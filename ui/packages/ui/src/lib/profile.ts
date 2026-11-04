// A trace's profile made readable: its stacks as a tree, its time by package, and the two ways of looking at it (the
// project's own code, every frame).
import type { Trace } from "../types";
import { packageOf as modulePackage } from "./packages";

export type Profile = NonNullable<Trace["profile"]>;
export type Frame = Profile["frames"][number];
export type Stack = Profile["stacks"][number];

/** Under this share of the samples that computed in the project's own code, a profile opens on every frame. */
const OWN_ENOUGH = 0.1;
/** Frames kept above the first of the project's own, out of what every stack starts with: the middleware around it. */
const CONTEXT = 3;

export const YOUR_CODE = "your code";

/**
 * A frame for a share of the trace's time that no function's frame says (lib/timeShares): a call's (Database, its
 * label "SQL postgresql"), the collector's (GC), the framework's. The time under it is that share's, as the time strip
 * and the call tree count it; `share` is the share's name there, `category` its colour's.
 */
export type ShareFrame = Frame & { share: string; category: string; calls?: readonly string[] };

/** The frame as a share's, when it is one. */
export function shareFrame(frame: Frame | undefined): ShareFrame | null {
  return frame && typeof (frame as Partial<ShareFrame>).share === "string" ? (frame as ShareFrame) : null;
}

/** What a frame belongs to: your code, or a library's package (django.db, django.template, requests, threading). */
export function packageOf(frame: Frame): string {
  const share = shareFrame(frame);
  if (share) return share.share;
  if (frame === OUTSIDE) return FRAMEWORK;
  if (frame.waiting) return WAITING;
  return frame.in_app ? YOUR_CODE : libraryOf(frame);
}

/**
 * Your code's time is the framework's and the runtime's that ran none of it: the server's, a worker's, the
 * runtime's timers, OpenTelemetry's and Tracepanel's own. One box and one share in Your code, never a library's.
 */
export const FRAMEWORK = "framework & runtime";

/** The frame Your code draws the samples that ran none of your code as: one, not theirs. */
// biome-ignore lint/style/useNamingConvention: a frame as the SDKs send it.
const OUTSIDE: Frame = { function: FRAMEWORK, module: null, file: "", line: 0, in_app: false };

/** Time a sample's innermost frame waited (a sleep, the event loop's select, a socket), not computing: its own share. */
export const WAITING = "waiting";

/**
 * The frame waiting is drawn as where no frame of the runtime's should name it: Your code's waits (a JVM's
 * VirtualThread.park, Python's sleep, Node's idle event loop, a Go CPU profile's time off the CPU). One name and one
 * look in every language; All frames keeps the frame that waited, where the profile has one.
 */
// biome-ignore lint/style/useNamingConvention: a frame as the SDKs send it.
export const WAITED: Frame = { function: WAITING, module: null, file: "", line: 0, in_app: false, waiting: true };

/**
 * A library frame's package: its module's (org.springframework, not org; Django's first two parts, as it is many
 * packages in one), else its file's first folder (express, node:internal), a scoped npm package's first two
 * (@opentelemetry/instrumentation-http).
 */
function libraryOf(frame: Frame): string {
  const module = frame.module ?? "";
  if (module) return module.startsWith("django.") ? module.split(".").slice(0, 2).join(".") : modulePackage(module);
  const parts = frame.file.replace(/\.py$/, "").split("/").filter(Boolean);
  const first = parts[0] ?? "";
  if (first.startsWith("@")) return parts.slice(0, 2).join("/");
  return (parts.length > 1 ? first : first.split(".")[0]) || "(unknown)";
}

/** The package whose code a stack was running: its innermost frame's. */
function runningIn(profile: Profile, stack: Stack): string {
  const frame = profile.frames[stack.frames[stack.frames.length - 1] ?? -1];
  return frame ? packageOf(frame) : "(unknown)";
}

/** The samples in which each package's code was running, most first. */
export function packageTimes(profile: Profile): { name: string; samples: number }[] {
  const times = new Map<string, number>();
  for (const stack of profile.stacks) {
    const name = runningIn(profile, stack);
    times.set(name, (times.get(name) ?? 0) + stack.count);
  }
  return [...times.entries()].map(([name, samples]) => ({ name, samples })).sort((a, b) => b.samples - a.samples);
}

/** A function as the console tells functions apart: its name, where it is defined, whether it waits. */
function functionKey(frame: Frame): string {
  const share = shareFrame(frame)?.share ?? "";
  return [frame.function, frame.module ?? "", frame.file, frame.line, frame.in_app, frame.waiting === true, share].join(
    "|",
  );
}

/**
 * Each frame's index as the function's first: one function is one frame, however many its profile has. A Python
 * coroutine is two, the line it awaits at (`at_line`) told apart from the same function running: one box and one row.
 * The frame without an await's line stands for the function.
 */
function sameFunctions(frames: readonly Frame[]): number[] {
  const first = new Map<string, number>();
  frames.forEach((frame, index) => {
    const key = functionKey(frame);
    const found = first.get(key);
    if (found === undefined || (frames[found]?.at_line !== undefined && frame.at_line === undefined)) {
      first.set(key, index);
    }
  });
  return frames.map((frame) => first.get(functionKey(frame)) ?? 0);
}

/** The same stacks, merged where they are now alike: a function's frames as one. */
function merged(profile: Profile, stacks: Stack[]): Profile {
  const same = sameFunctions(profile.frames);
  const counts = new Map<string, Stack>();
  for (const each of stacks) {
    const stack = { ...each, frames: each.frames.map((index) => same[index] ?? index) };
    const key = stack.frames.join(",");
    const found = counts.get(key);
    if (found) found.count += stack.count;
    else counts.set(key, { ...stack });
  }
  return { ...profile, stacks: [...counts.values()] };
}

/**
 * Tracing's own code, never the app's, wherever it runs: OpenTelemetry's and Tracepanel's SDKs in every language, and
 * the hooks they patch a Node app's modules with. By its module, else its file, as each SDK names them.
 */
const TRACING =
  /^(?:@opentelemetry\/|@tracepanel\/|(?:require|import)-in-the-middle\/|opentelemetry[./]|tracepanel[./]|io\.opentelemetry\.|dev\.tracepanel\.|go\.opentelemetry\.io\/|github\.com\/tracepanel\/)/;

function tracing(frame: Frame | undefined): boolean {
  return frame !== undefined && !frame.in_app && TRACING.test(frame.module || frame.file);
}

/** Whether a stack ran your code: a frame of yours on it, and not tracing's own code at its tip. */
export function runsYours(profile: Profile, stack: Stack): boolean {
  const leaf = profile.frames[stack.frames.at(-1) ?? -1];
  return stack.frames.some((index) => profile.frames[index]?.in_app === true) && !tracing(leaf);
}

/** Whether a frame is a wait the console named by what was in flight ("waiting · SQL snowflake"). */
function named(frame: Frame): boolean {
  return frame.file === "" && frame.function.startsWith(`${WAITING} `);
}

/** Where Your code's two frames of its own are in its frames: the framework & runtime's, and waiting's. */
interface Kept {
  outside: number;
  waited: number;
}

/**
 * A stack as your code sees it: your frames only, the time in the libraries they called counted to the innermost of
 * them; one waiting frame under them where the stack waited (a socket, a sleep, a parked thread: waiting, not a
 * library's time, nor its frame's). A stack with none of your code, or running tracing's own code (a span started,
 * an attribute set), is the framework's and the runtime's (`outside`): none of their frames, nor tracing's time, are
 * yours.
 */
function ownFrames(profile: Profile, frames: readonly number[], kept: Kept): number[] {
  const yours = frames.filter((index) => profile.frames[index]?.in_app === true);
  const leaf = frames.at(-1);
  const inner = leaf === undefined ? undefined : profile.frames[leaf];
  // A share's time (a call's, the collector's, the framework's) is that share's, under your frames that led to it.
  if (shareFrame(inner) && leaf !== undefined) return [...yours, leaf];
  // A wait named by what was in flight (lib/waitCalls) keeps its name; any other is Your code's one waiting frame.
  if (inner?.waiting === true && !inner.in_app)
    return [...yours, named(inner) && leaf !== undefined ? leaf : kept.waited];
  return yours.length && !tracing(inner) ? yours : [kept.outside];
}

/**
 * Your code's view of the profile: its frames alone, the rest one framework & runtime frame (FRAMEWORK), and its
 * waits one waiting frame (WAITING).
 */
export function ownCode(profile: Profile): Profile {
  const frames = [...profile.frames, OUTSIDE, WAITED];
  const kept = { outside: frames.length - 2, waited: frames.length - 1 };
  return merged(
    { ...profile, frames },
    profile.stacks.map((stack) => ({ frames: ownFrames(profile, stack.frames, kept), count: stack.count })),
  );
}

function commonLength(a: readonly number[], b: readonly number[]): number {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  return at;
}

/** Every frame, less the library frames every stack starts with (the server, the thread) but the last few. */
export function allFrames(profile: Profile): Profile {
  const [first, ...rest] = profile.stacks;
  if (!first) return profile;
  const shared = rest.reduce(
    (length, stack) => Math.min(length, commonLength(first.frames, stack.frames)),
    first.frames.length,
  );
  const library = first.frames.slice(0, shared).findIndex((index) => profile.frames[index]?.in_app);
  const cut = Math.max(0, (library === -1 ? shared : library) - CONTEXT);
  return merged(
    profile,
    profile.stacks.map((stack) => ({ frames: stack.frames.slice(cut), count: stack.count })),
  );
}

/**
 * Whether your code ran enough of the time it computed for the profile to open on it, as the time strip splits it
 * (lib/timeShares): its waits are no one's code (a Node task idle on its event loop is still yours to read), and a
 * profile that only waited opens on Your code too, which says so.
 */
export function mostlyYours(profile: Profile): boolean {
  const ran = profile.stacks.filter((stack) => profile.frames[stack.frames.at(-1) ?? -1]?.waiting !== true);
  const computed = ran.reduce((sum, stack) => sum + stack.count, 0);
  const yours = ran.filter((stack) => runsYours(profile, stack)).reduce((sum, stack) => sum + stack.count, 0);
  return computed === 0 || yours >= computed * OWN_ENOUGH;
}

/** A function as the stacks reached it: its samples (here and below), its own, and the functions it called. */
export interface Node {
  frame: Frame | null;
  key: string;
  total: number;
  self: number;
  children: Map<number, Node>;
}

function child(at: Node, index: number, profile: Profile): Node {
  const found = at.children.get(index);
  if (found) return found;
  const made: Node = {
    frame: profile.frames[index] ?? null,
    key: `${at.key}/${index}`,
    total: 0,
    self: 0,
    children: new Map(),
  };
  at.children.set(index, made);
  return made;
}

/** The stacks merged into one tree from the outermost frame in: a call path is one node however often it was seen. */
export function tree(profile: Profile): Node {
  const root: Node = { frame: null, key: "root", total: 0, self: 0, children: new Map() };
  for (const stack of profile.stacks) {
    root.total += stack.count;
    const leaf = stack.frames.reduce((at, index) => {
      const next = child(at, index, profile);
      next.total += stack.count;
      return next;
    }, root);
    leaf.self += stack.count;
  }
  return root;
}

/** Each function's samples: its own (it was running) and in all (it or what it called was), each stack counted once. */
export function functions(profile: Profile): { frame: Frame; self: number; total: number }[] {
  const self = new Map<number, number>();
  const total = new Map<number, number>();
  const add = (counts: Map<number, number>, index: number, samples: number) =>
    counts.set(index, (counts.get(index) ?? 0) + samples);
  for (const stack of profile.stacks) {
    add(self, stack.frames[stack.frames.length - 1] ?? -1, stack.count);
    for (const index of new Set(stack.frames)) add(total, index, stack.count);
  }
  return [...total.entries()]
    .flatMap(([index, samples]) => {
      const frame = profile.frames[index];
      return frame ? [{ frame, self: self.get(index) ?? 0, total: samples }] : [];
    })
    .sort((a, b) => b.self - a.self || b.total - a.total);
}

/**
 * What a frame of the console's own stands for, no function's: the framework & runtime (Your code's samples that
 * ran none of it), or waiting (Your code's waits). Null for a function's frame,
 * however it is named. By its fields, as a chain's merged profiles copy their frames.
 */
export function summaryOf(frame: Frame): string | null {
  const share = shareFrame(frame);
  if (share) return share.share;
  if (frame.file !== "" || frame.in_app || frame.module) return null;
  if (frame.function === FRAMEWORK && !frame.waiting) return FRAMEWORK;
  return frame.function.startsWith(WAITING) && frame.waiting === true ? WAITING : null;
}

/** A box per call, a row per depth, each as wide as its share of the focused node's samples. */
export interface Box {
  node: Node;
  depth: number;
  left: number;
  width: number;
}

export function layout(focus: Node): Box[] {
  const boxes: Box[] = [];
  const place = (at: Node, depth: number, left: number) => {
    let x = left;
    for (const next of [...at.children.values()].sort((a, b) => b.total - a.total)) {
      const width = next.total / focus.total;
      // Narrower than a pixel or so is noise at any width.
      if (width >= 0.002) {
        boxes.push({ node: next, depth, left: x, width });
        place(next, depth + 1, x);
      }
      x += width;
    }
  };
  place(focus, 0, 0);
  return boxes;
}

/**
 * The function of the project's own that ran most (each sample counted for the innermost of yours in its stack), and
 * the function of yours that called it most often in those samples: its real parent, the nearest frame of yours above
 * it. None when no code of yours ran.
 */
export function hottestOwn(profile: Profile): { name: string; caller: string | null } | null {
  const samples = new Map<string, number>();
  const callers = new Map<string, Map<string, number>>();
  for (const stack of profile.stacks) {
    const own = stack.frames.map((index) => profile.frames[index]).filter((frame) => frame?.in_app);
    const name = own.at(-1)?.function;
    if (name === undefined) continue;
    samples.set(name, (samples.get(name) ?? 0) + stack.count);
    const caller = own.at(-2)?.function;
    if (caller === undefined || caller === name) continue;
    const counts = callers.get(name) ?? new Map<string, number>();
    counts.set(caller, (counts.get(caller) ?? 0) + stack.count);
    callers.set(name, counts);
  }
  const top = mostOf(samples);
  if (top === null) return null;
  return { name: top, caller: mostOf(callers.get(top) ?? new Map()) };
}

/** The key with the most samples; the first seen of those tied. */
function mostOf(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let most = 0;
  for (const [key, count] of counts) {
    if (count > most) {
      best = key;
      most = count;
    }
  }
  return best;
}

/** Why the SDKs say a trace was profiled (`profile.reason`), as people read it. */
const REASONS: Record<string, string> = {
  cookie: "by the panel's cookie",
  setting: "by its own setting",
  header: "by a request header",
  parent: "by its caller",
  code: "by your code",
};

/**
 * "Profiled: by the panel's cookie": why the trace was profiled, as its SDK says on its root span (or the trace's
 * attributes); a reason the console doesn't know, as sent. Null when it doesn't say.
 */
export function profileReason(trace: Pick<Trace, "attrs" | "spans">): string | null {
  const root = trace.spans.find((span) => span.parent_id === null);
  const value = root?.attrs["profile.reason"] ?? trace.attrs["profile.reason"];
  if (typeof value !== "string" || value === "") return null;
  return `Profiled: ${REASONS[value] ?? value}`;
}
