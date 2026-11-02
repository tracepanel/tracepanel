// What a profile's waits were for, by the calls in flight: a function of yours that waited 3.9 s waited on a query
// to Snowflake, an HTTP call, a sleep. Your code's hatched waiting boxes and its summary rows say so ("waiting · SQL
// snowflake"), one way in every language: a timed profile's (Python's, a JVM's) by the calls its function made in
// the buckets it waited in, a CPU profile's (Go's, Node's) by the calls its time off the CPU went to (lib/offCpu).
// All frames keeps the frames that waited. Plain data, no React: read in the console, not in the agent.
import type { Span, Trace } from "../types";
import { type Frame, type Profile, type Stack, WAITING } from "./profile";
import { CALL_KINDS } from "./systems";

/** A wait named by what was in flight: the calls it waited for, by their span ids (the call tree opens there). */
export type WaitFrame = Frame & { calls?: readonly string[] };

/** What a wait with no call in flight says: the frame that waited ("sleep"), else that no call was. */
const NO_CALL = `${WAITING} (no call)`;

function text(attrs: Span["attrs"], key: string): string | null {
  const value = attrs[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Where an HTTP call went: its host, as the call tree names it. */
function hostOf(span: Span): string | null {
  const full = text(span.attrs, "url.full") ?? text(span.attrs, "http.url");
  if (full) {
    try {
      return new URL(full).hostname;
    } catch {
      // Not a URL: its address below.
    }
  }
  return text(span.attrs, "server.address") ?? text(span.attrs, "net.peer.name");
}

/** What a call is, in a wait's name: "SQL snowflake", "HTTP GET analytics.example.com", "redis". */
export function callLabel(span: Span): string {
  const system =
    text(span.attrs, "db.system") ??
    text(span.attrs, "db.vendor") ??
    text(span.attrs, "messaging.system") ??
    text(span.attrs, "rpc.system");
  if (span.kind === "sql") return ["SQL", system].filter(Boolean).join(" ");
  if (span.kind === "http.client") {
    const method = text(span.attrs, "http.request.method") ?? text(span.attrs, "http.method");
    return ["HTTP", method, hostOf(span)].filter(Boolean).join(" ");
  }
  return system && system !== span.kind ? `${span.kind} ${system}` : span.kind;
}

/** A wait's frame: hatched as every wait (`waiting`), named by what it waited for. */
export function waitFrame(label: string | null, calls: readonly string[] = []): WaitFrame {
  return {
    function: label ? `${WAITING} · ${label}` : NO_CALL,
    module: null,
    file: "",
    line: 0,
    // biome-ignore lint/style/useNamingConvention: a frame as the SDKs send it.
    in_app: false,
    waiting: true,
    ...(calls.length ? { calls } : {}),
  };
}

/** Whether a frame is a wait named by what was in flight (not a function's, nor the plain "waiting"). */
export function namedWait(frame: Frame | undefined): frame is WaitFrame {
  return frame?.waiting === true && !frame.in_app && frame.file === "" && frame.function.startsWith(`${WAITING} `);
}

/** A call of the trace with its stretch (µs since the trace started). */
interface Call {
  span: Span;
  from: number;
  to: number;
}

/** The trace's calls out (queries, HTTP calls, cache and queue calls), on its clock. */
export function callsOf(trace: Pick<Trace, "start" | "spans">): Call[] {
  return trace.spans
    .filter((span) => span.parent_id !== null && CALL_KINDS.has(span.kind))
    .map((span) => ({ span, from: span.start - trace.start, to: span.start + span.duration - trace.start }))
    .filter((call) => call.to > call.from);
}

/** A stack's frame that waited: its innermost, when it is a wait (a sleep, a socket, a parked thread). */
function waitedIn(profile: Profile, stack: Stack): Frame | null {
  const leaf = profile.frames[stack.frames.at(-1) ?? -1];
  return leaf?.waiting === true && !leaf.in_app ? leaf : null;
}

/** The function a call's origin names ("api.py:56 in report": `report`), as every SDK writes code.origin. */
function madeIn(span: Span): string | null {
  return text(span.attrs, "code.origin")?.split(" in ").at(-1) ?? null;
}

/** The same function, however each names it: `report`, `Reports.report`, `(*App).report`. */
function sameName(a: string, b: string): boolean {
  return a === b || a.split(".").at(-1) === b.split(".").at(-1);
}

/**
 * The calls in flight in a bucket of the profile (µs since the trace started): those a function of the stack made
 * (their code.origin), where any did; else all of them (an origin a stack doesn't name: the driver's, a callback's).
 */
function inFlight(calls: readonly Call[], from: number, to: number, names: readonly string[]): Call[] {
  const open = calls.filter((call) => call.from < to && call.to > from);
  const own = open.filter((call) => {
    const made = madeIn(call.span);
    return made !== null && names.some((name) => sameName(name, made));
  });
  return own.length > 0 ? own : open;
}

/** A wait's label for the calls in flight: theirs, or, with none, the frame that waited ("sleep"). */
function labelsOf(open: readonly Call[], leaf: Frame): { label: string | null; calls: string[] }[] {
  if (open.length === 0) return [{ label: leaf.function === WAITING ? null : leaf.function, calls: [] }];
  return open.map((call) => ({ label: callLabel(call.span), calls: [call.span.id] }));
}

/** The parts of a waiting stack's time, by what was in flight in each of its buckets. */
function partsOf(profile: Profile, stack: Stack, leaf: Frame, calls: readonly Call[], width: number): Part[] {
  const seen = (stack.at ?? []).reduce((sum, [, count]) => sum + count, 0);
  const names = stack.frames.map((at) => profile.frames[at]?.function ?? "");
  const parts = new Map<string, Part>();
  for (const [bucket, count] of stack.at ?? []) {
    const labels = labelsOf(inFlight(calls, bucket * width, (bucket + 1) * width, names), leaf);
    for (const { label, calls: ids } of labels) {
      const part = parts.get(label ?? "") ?? { label, calls: new Set<string>(), count: 0 };
      part.count += (stack.count * count) / seen / labels.length;
      for (const id of ids) part.calls.add(id);
      parts.set(label ?? "", part);
    }
  }
  return exact([...parts.values()], stack.count);
}

/** The parts with the last one taking what the shares' rounding left: together, the stack's count to the sample. */
function exact(parts: Part[], count: number): Part[] {
  const last = parts.at(-1);
  if (last) last.count = count - parts.slice(0, -1).reduce((sum, part) => sum + part.count, 0);
  return parts;
}

/** A share of a waiting stack's time: what was in flight (null: no call), the calls, its samples. */
interface Part {
  label: string | null;
  calls: Set<string>;
  count: number;
}

/**
 * The profile's frames with a wait frame per label the stacks were split by (its calls those of every part named
 * so), and where each label's frame is.
 */
function withWaitFrames(profile: Profile, parts: readonly Part[]): { frames: Frame[]; at: Map<string, number> } {
  const calls = new Map<string, Set<string>>();
  for (const part of parts) {
    const known = calls.get(part.label ?? "") ?? new Set<string>();
    for (const id of part.calls) known.add(id);
    calls.set(part.label ?? "", known);
  }
  const frames: Frame[] = [...profile.frames];
  const at = new Map<string, number>();
  for (const [key, ids] of calls) {
    at.set(key, frames.length);
    frames.push(waitFrame(key || null, [...ids]));
  }
  return { frames, at };
}

/**
 * A timed profile with its waits named by what was in flight (Your code's view of it): each stack that waited split
 * by the calls in flight in the buckets it was seen in, its waiting frame named after them. A profile that doesn't
 * say when its stacks were seen is left as it is.
 */
export function namedWaits(profile: Profile, trace: Pick<Trace, "start" | "spans">): Profile {
  const width = profile.bucket_us;
  if (!width) return profile;
  const calls = callsOf(trace);
  const split = profile.stacks.map((stack) => {
    const leaf = waitedIn(profile, stack);
    return leaf && stack.at?.length ? partsOf(profile, stack, leaf, calls, width) : null;
  });
  const { frames, at } = withWaitFrames(
    profile,
    split.flatMap((parts) => parts ?? []),
  );
  const stacks = profile.stacks.flatMap((stack, index): Stack[] => {
    const parts = split[index];
    if (!parts) return [stack];
    return parts.map((part) => ({
      frames: [...stack.frames.slice(0, -1), at.get(part.label ?? "") ?? -1],
      count: part.count,
    }));
  });
  return { ...profile, frames, stacks };
}
