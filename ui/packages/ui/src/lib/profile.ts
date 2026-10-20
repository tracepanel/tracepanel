// A trace's profile made readable: its stacks as a tree, its time by package, and the two ways of looking at it (the
// project's own code, every frame).
import type { Trace } from "../types";

export type Profile = NonNullable<Trace["profile"]>;
export type Frame = Profile["frames"][number];
type Stack = Profile["stacks"][number];

/** Under this share of samples in the project's own code, a profile opens on every frame: there is little of yours. */
const OWN_ENOUGH = 0.1;
/** Frames kept above the first of the project's own, out of what every stack starts with: the middleware around it. */
const CONTEXT = 3;

export const YOUR_CODE = "your code";

/** What a frame belongs to: your code, or a library's package (django.db, django.template, requests, threading). */
export function packageOf(frame: Frame): string {
  if (frame.in_app) return YOUR_CODE;
  const name = frame.module ?? frame.file.replace(/\.py$/, "").split("/").join(".");
  const parts = name.split(".").filter(Boolean);
  // Django is many packages in one: what a request spends there is told apart by the second part.
  return (parts[0] === "django" ? parts.slice(0, 2) : parts.slice(0, 1)).join(".") || "(unknown)";
}

/** The samples in which each package's code was running, most first. */
export function packageTimes(profile: Profile): { name: string; samples: number }[] {
  const times = new Map<string, number>();
  for (const stack of profile.stacks) {
    const frame = profile.frames[stack.frames[stack.frames.length - 1] ?? -1];
    const name = frame ? packageOf(frame) : "(unknown)";
    times.set(name, (times.get(name) ?? 0) + stack.count);
  }
  return [...times.entries()].map(([name, samples]) => ({ name, samples })).sort((a, b) => b.samples - a.samples);
}

/** The same stacks, merged where they are now alike. */
function merged(profile: Profile, stacks: Stack[]): Profile {
  const counts = new Map<string, Stack>();
  for (const stack of stacks) {
    const key = stack.frames.join(",");
    const found = counts.get(key);
    if (found) found.count += stack.count;
    else counts.set(key, { ...stack });
  }
  return { ...profile, stacks: [...counts.values()] };
}

/**
 * A stack as your code sees it: your frames, and under each the library call it made (what it spent was spent in
 * that call); the server's frames above your first are left out. A stack without your code is left as it is.
 */
function ownFrames(profile: Profile, frames: readonly number[]): number[] {
  const kept: number[] = [];
  let underYours = false;
  for (const index of frames) {
    const yours = profile.frames[index]?.in_app === true;
    if (yours || underYours) kept.push(index);
    // After a library call, its own calls are part of it: only the call itself stays.
    underYours = yours;
  }
  return kept.length ? kept : [...frames];
}

export function ownCode(profile: Profile): Profile {
  return merged(
    profile,
    profile.stacks.map((stack) => ({ frames: ownFrames(profile, stack.frames), count: stack.count })),
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
  const shared = rest.reduce((length, stack) => Math.min(length, commonLength(first.frames, stack.frames)), first.frames.length);
  const library = first.frames.slice(0, shared).findIndex((index) => profile.frames[index]?.in_app);
  const cut = Math.max(0, (library === -1 ? shared : library) - CONTEXT);
  return merged(
    profile,
    profile.stacks.map((stack) => ({ frames: stack.frames.slice(cut), count: stack.count })),
  );
}

/** Whether your code ran enough of the time for the profile to open on it. */
export function mostlyYours(profile: Profile): boolean {
  const yours = profile.stacks
    .filter((stack) => stack.frames.some((index) => profile.frames[index]?.in_app))
    .reduce((sum, stack) => sum + stack.count, 0);
  return yours >= profile.samples * OWN_ENOUGH;
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
  const made: Node = { frame: profile.frames[index] ?? null, key: `${at.key}/${index}`, total: 0, self: 0, children: new Map() };
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
