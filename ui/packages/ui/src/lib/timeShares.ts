// Where a trace's time went, moment by moment, in one set of shares: what the time strip draws and its legend adds
// up, what the call tree's code rows say, and what the Profile tab's bar, flame and list show for any stretch. Spans
// say what ran when (a query is the database's time, a pause the collector's); in a span's own code, a timed profile
// says, bucket by bucket, how much of it waited, ran your code, or ran only the framework's. One rule, so a row, its
// profile and the strip give the same time for the same stretch. Plain data, no React.
import type { Span, Trace } from "../types";
import { type Category, categoryLabel, stretches } from "./breakdown";
import { cutByPauses, GC, gcPauses } from "./memory";
import { type Frame, type Profile, runsYours, type ShareFrame, type Stack, WAITING } from "./profile";
import type { TimeRange, Windows } from "./slice";
import { callLabel, waitFrame } from "./waitCalls";
import { bucketStacks, type Timed, timed, waits } from "./waiting";

/** A share of the trace's time: a category of spans, the collector's pauses, or the code's waits. */
export type Share = Category | typeof GC | typeof WAITING;

/** The categories whose time is the code's own: a profile splits it into its waits and what ran. */
const OWN_CODE: ReadonlySet<string> = new Set<Category>(["code", "django", "signal", "template"]);

/** A trace as its shares read it. */
export type Shared = Pick<Trace, "start" | "duration" | "spans" | "attrs" | "profile"> & { kind?: string };

/**
 * A stretch of the trace's time (µs since it started) and the share it went to: the span running then (deepest),
 * whether that was its own code with calls of its own around (`quiet`), and the stacks of the profile running then
 * with their time in it (µs, by stack index); none where the profile can't say (not timed, before its first sample).
 */
export interface Segment {
  from: number;
  to: number;
  share: Share;
  span: string;
  category: Category;
  quiet: boolean;
  stacks: ReadonlyMap<number, number> | null;
}

/** Each stack's time, scaled to a stretch `length` long: by how often each was seen. */
function scaled(stacks: readonly (readonly [number, number])[], length: number): Map<number, number> {
  const total = stacks.reduce((sum, [, count]) => sum + count, 0);
  return new Map(stacks.map(([index, count]) => [index, (length * count) / total]));
}

/**
 * A span's own code in a bucket (`stacks`, by how often each was seen) in its parts: what ran your code (its
 * category's), what ran only the framework (a view's: the framework's share), what waited. Each part as long as its
 * samples' share of the bucket; in turn one way in even buckets and the other in odd ones, so the parts of
 * neighbouring buckets meet.
 */
function ownParts(
  profile: Profile,
  category: Category,
  stacks: ReadonlyMap<number, number>,
  bucket: number,
): [Share, [number, number][]][] {
  const groups = new Map<Share, [number, number][]>();
  for (const [index, count] of stacks) {
    const stack = profile.stacks[index] as Stack;
    const share: Share = waits(profile, stack)
      ? WAITING
      : category === "code" && !runsYours(profile, stack)
        ? "django"
        : category;
    groups.set(share, [...(groups.get(share) ?? []), [index, count]]);
  }
  const order: Share[] = [category, "django", WAITING];
  const parts = order.flatMap((share): [Share, [number, number][]][] => {
    const group = groups.get(share);
    return group ? [[share, group]] : [];
  });
  return bucket % 2 === 0 ? parts : parts.reverse();
}

/** A stretch of one span's time inside one bucket (or with no profile to split it), in its segments. */
function bucketSegments(
  base: Omit<Segment, "from" | "to" | "share" | "stacks">,
  [from, to]: TimeRange,
  gc: boolean,
  profile: Timed | null,
  stacks: ReadonlyMap<number, number> | undefined,
  bucket: number,
): Segment[] {
  const plain: Share = gc ? GC : base.category;
  if (!(profile && stacks?.size)) return [{ ...base, from, to, share: plain, stacks: null }];
  if (gc || !OWN_CODE.has(base.category)) {
    return [{ ...base, from, to, share: plain, stacks: scaled([...stacks], to - from) }];
  }
  const parts = ownParts(profile, base.category, stacks, bucket);
  const total = [...stacks.values()].reduce((sum, count) => sum + count, 0);
  const segments: Segment[] = [];
  let at = from;
  parts.forEach(([share, group], index) => {
    const seen = group.reduce((sum, [, count]) => sum + count, 0);
    const end = index === parts.length - 1 ? to : at + ((to - from) * seen) / total;
    if (end > at) segments.push({ ...base, from: at, to: end, share, stacks: scaled(group, end - at) });
    at = end;
  });
  return segments;
}

const SEGMENTS = new WeakMap<object, Segment[]>();

/**
 * The trace's time in segments, in order: each span's stretches (the deepest span running), the collector's pauses
 * cut out as GC's, and, with a timed profile, each bucket of a span's own code in its parts (ownParts).
 */
export function segmentsOf(trace: Shared): Segment[] {
  const known = SEGMENTS.get(trace);
  if (known) return known;
  const profile = timed(trace.profile) ? trace.profile : null;
  const buckets = profile ? bucketStacks(profile, trace.duration) : new Map<number, ReadonlyMap<number, number>>();
  const pauses = gcPauses(trace.profile, trace.duration);
  const segments = stretches(trace as Trace).flatMap((stretch) => {
    const base = { span: stretch.span, category: stretch.category, quiet: stretch.quiet };
    return cutByPauses(stretch.from, stretch.to, pauses).flatMap(({ range, gc }) =>
      profile
        ? byBucket(range, profile.bucket_us).flatMap(([part, bucket]) =>
            bucketSegments(base, part, gc, profile, buckets.get(bucket), bucket),
          )
        : bucketSegments(base, range, gc, null, undefined, 0),
    );
  });
  SEGMENTS.set(trace, segments);
  return segments;
}

/** A stretch cut at the buckets' edges: each part with its bucket. */
function byBucket([from, to]: TimeRange, width: number): [TimeRange, number][] {
  const parts: [TimeRange, number][] = [];
  for (let bucket = Math.floor(from / width); bucket * width < to; bucket++) {
    const part: TimeRange = [Math.max(from, bucket * width), Math.min(to, (bucket + 1) * width)];
    if (part[1] > part[0]) parts.push([part, bucket]);
  }
  return parts;
}

/** How much of a segment the windows take (all of it with none). */
function taken(segment: Segment, windows: Windows | null): number {
  if (windows === null) return segment.to - segment.from;
  return windows.reduce(
    (sum, [from, to]) => sum + Math.max(Math.min(segment.to, to) - Math.max(segment.from, from), 0),
    0,
  );
}

/** The time of each share (µs), of the whole trace or of the windows: what the strip's legend adds up. */
export function shareTimes(trace: Shared, windows: Windows | null = null): Map<Share, number> {
  const times = new Map<Share, number>();
  for (const segment of segmentsOf(trace)) {
    const time = taken(segment, windows);
    if (time > 0) times.set(segment.share, (times.get(segment.share) ?? 0) + time);
  }
  return times;
}

/** The segments of a span's own time: what its code rows are, its waits and the rest, GC's left to GC. */
export function spanSegments(trace: Shared, span: string): Segment[] {
  return segmentsOf(trace).filter((segment) => segment.span === span && segment.share !== GC);
}

/** Segments as the stretches they cover, those that meet as one. */
export function windowsOfSegments(segments: readonly Segment[]): Windows {
  const windows: [number, number][] = [];
  for (const { from, to } of [...segments].sort((a, b) => a.from - b.from)) {
    const last = windows.at(-1);
    if (last && from <= last[1] + 0.5) last[1] = Math.max(last[1], to);
    else windows.push([from, to]);
  }
  return windows;
}

/** A share's name, as the strip's legend says it: "Database", "GC", "Framework & middleware". */
export function shareLabel(share: Share, trace: Pick<Trace, "attrs"> & { kind?: string }): string {
  if (share === GC) return "GC";
  if (share === WAITING) return "Waiting";
  return categoryLabel(share, trace);
}

/** The frame a segment's time goes under in a profile, where its share isn't the code's own or a wait. */
function frameOf(segment: Segment, trace: Shared, byId: ReadonlyMap<string, Span>): ShareFrame | null {
  if (segment.share === "code" || segment.share === WAITING) return null;
  const share = shareLabel(segment.share, trace);
  const span = byId.get(segment.span);
  const call = segment.share !== GC && !OWN_CODE.has(segment.share) && span ? span : null;
  return {
    function: call ? callLabel(call) : share,
    module: null,
    file: "",
    line: 0,
    // biome-ignore lint/style/useNamingConvention: a frame as the SDKs send it.
    in_app: false,
    share,
    category: segment.share,
    ...(call ? { calls: [call.id] } : {}),
  };
}

/** A profile's frames with more of the console's own added, each once: where a frame is, added if new. */
function frameTable(profile: Profile): { frames: Frame[]; frameAt: (frame: Frame) => number } {
  const frames: Frame[] = [...profile.frames];
  const index = new Map<string, number>();
  const frameAt = (frame: Frame): number => {
    const key = JSON.stringify(frame);
    const found = index.get(key);
    if (found !== undefined) return found;
    index.set(key, frames.length);
    return frames.push(frame) - 1;
  };
  return { frames, frameAt };
}

/** A stack seen for `count` samples in a bucket, added to the stacks by its frames. */
function addStack(stacks: Map<string, Stack>, path: number[], count: number, bucket: number): void {
  const key = path.join(",");
  const found = stacks.get(key);
  if (found) {
    found.count += count;
    found.at = [...(found.at ?? []), [bucket, count]];
  } else stacks.set(key, { frames: path, count, at: [[bucket, count]] });
}

/**
 * A stack's frames in a segment: under its share's frame (a call's, the collector's, the framework's); a wait, in
 * Your code (`named`), with its waiting frame named by what waited.
 */
function pathIn(
  profile: Profile,
  stack: Stack,
  share: number | null,
  named: boolean,
  frameAt: (frame: Frame) => number,
): number[] {
  if (share !== null) return [...stack.frames, share];
  const leaf = profile.frames[stack.frames.at(-1) ?? -1];
  if (!(named && leaf?.waiting)) return stack.frames;
  const wait = waitFrame(leaf.function === WAITING ? null : leaf.function);
  return [...stack.frames.slice(0, -1), frameAt(wait)];
}

/**
 * The profile of the trace's time, or of the windows', as its shares have it: each segment's stacks for as much of
 * it as the windows take, a call's, the collector's or the framework's time under a frame of that share (ShareFrame).
 * `named`: Your code's, its waits named by the frame that waited ("waiting · waiter.acquire"). Counted in samples of
 * the profile's interval, so its numbers read as the strip's and the call tree's.
 */
export function windowProfile(trace: Shared & { profile: Timed }, windows: Windows | null, named = false): Profile {
  const { profile } = trace;
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  const { frames, frameAt } = frameTable(profile);
  const stacks = new Map<string, Stack>();
  for (const segment of segmentsOf(trace)) {
    const time = taken(segment, windows);
    if (time <= 0 || !segment.stacks) continue;
    const frame = frameOf(segment, trace, byId);
    const share = frame ? frameAt(frame) : null;
    const bucket = Math.floor(segment.from / profile.bucket_us);
    const part = time / (segment.to - segment.from) / profile.interval_us;
    for (const [at, us] of segment.stacks) {
      const path = pathIn(profile, profile.stacks[at] as Stack, share, named, frameAt);
      addStack(stacks, path, us * part, bucket);
    }
  }
  const list = [...stacks.values()];
  return { ...profile, frames, stacks: list, samples: list.reduce((sum, stack) => sum + stack.count, 0) };
}

/** Whether the trace's time can be split by its profile: a timed one. */
export function splitByProfile(trace: Shared): trace is Shared & { profile: Timed } {
  return timed(trace.profile);
}
