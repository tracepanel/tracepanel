// Where a trace's time went, moment by moment, in one set of shares: what the time strip draws and its legend adds
// up, what the call tree's code rows say, and what the Profile tab's bar, flame and list show for any stretch. Spans
// say what ran when (a query is the database's time, a pause the collector's); in a span's own code, a timed profile
// says, bucket by bucket, how much of it waited, ran your code, or ran only the framework's. One rule, so a row, its
// profile and the strip give the same time for the same stretch. Plain data, no React.
import type { Trace } from "../types";
import { type Category, categoryLabel, stretches } from "./breakdown";
import { cutByPauses, GC, gcPauses } from "./memory";
import { type Profile, runsYours, type Stack, WAITING } from "./profile";
import type { TimeRange, Windows } from "./slice";
import { bucketStacks, type Timed, timed, waits } from "./waiting";

/**
 * A span's own code where a timed profile has no samples to split it by (before its first sample): its own share,
 * neither your code's nor the framework's. Other spans' time (a call's, the collector's) is theirs all the same.
 */
export const NOT_PROFILED = "unprofiled";

/** A share of the trace's time: a category of spans, the collector's pauses, the code's waits, or its unprofiled time. */
export type Share = Category | typeof GC | typeof WAITING | typeof NOT_PROFILED;

/** The categories whose time is the code's own: a profile splits it into its waits and what ran. */
export const OWN_CODE: ReadonlySet<string> = new Set<Category>(["code", "django", "signal", "template"]);

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

/** The categories a stack's own time is split by what it ran: your code's, or the framework's. */
const BY_STACK: ReadonlySet<string> = new Set<Category>(["code", "django"]);

/**
 * A span's own code in a bucket (`stacks`, by how often each was seen) in its parts: what waited; in a handler's or a
 * framework's span (a request's root, a middleware), what ran your code (Your code) and what ran only the
 * framework's (the framework's share), whichever span it ran under; in a signal's or a template's, its category's.
 * Each part as long as its samples' share of the bucket; in turn one way in even buckets and the other in odd ones,
 * so the parts of neighbouring buckets meet.
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
    const ran: Share = !BY_STACK.has(category) ? category : runsYours(profile, stack) ? "code" : "django";
    const share: Share = waits(profile, stack) ? WAITING : ran;
    groups.set(share, [...(groups.get(share) ?? []), [index, count]]);
  }
  // Once each: a handler's span starts with Your code, a framework's with the framework's.
  const order: Share[] = [...new Set<Share>([category, "code", "django", WAITING])];
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
  unsampled: boolean,
): Segment[] {
  const plain: Share = gc ? GC : base.category;
  if (!(profile && stacks?.size)) {
    // Where a profile could say and has no samples, a span's own code is said so: not your code's, nor the
    // framework's. Spans say the rest (a call's time, the collector's).
    const share = unsampled && !gc && OWN_CODE.has(base.category) ? NOT_PROFILED : plain;
    return [{ ...base, from, to, share, stacks: null }];
  }
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

/** A profile with no samples at all (a Go request shorter than its profiler's tick): it says when nothing ran. */
function empty(profile: Profile | undefined): boolean {
  return profile?.stacks.every((stack) => stack.count <= 0) ?? false;
}

/**
 * The trace's time in segments, in order: each span's stretches (the deepest span running), the collector's pauses
 * cut out as GC's, and, with a timed profile, each bucket of a span's own code in its parts (ownParts). With a profile
 * that has no samples, a span's own code is not profiled; the spans say the rest.
 */
export function segmentsOf(trace: Shared): Segment[] {
  const known = SEGMENTS.get(trace);
  if (known) return known;
  const profile = timed(trace.profile) ? trace.profile : null;
  const unsampled = profile !== null || empty(trace.profile);
  const buckets = profile ? bucketStacks(profile, trace.duration) : new Map<number, ReadonlyMap<number, number>>();
  const pauses = gcPauses(trace.profile, trace.duration);
  const segments = stretches(trace as Trace).flatMap((stretch) => {
    const base = { span: stretch.span, category: stretch.category, quiet: stretch.quiet };
    // Only the trace's own time: a span that ends after it (its exporter's clock) counts up to its end.
    const [from, to] = [Math.max(stretch.from, 0), Math.min(stretch.to, trace.duration)];
    if (to <= from) return [];
    // A query's time is the database's whole, the collector's pauses during it too: the DB tab's time.
    return cutByPauses(from, to, stretch.category === "sql" ? [] : pauses).flatMap(({ range, gc }) =>
      profile
        ? byBucket(range, profile.bucket_us).flatMap(([part, bucket]) =>
            bucketSegments(base, part, gc, profile, buckets.get(bucket), bucket, unsampled),
          )
        : bucketSegments(base, range, gc, null, undefined, 0, unsampled),
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
export function shareLabel(share: Share): string {
  if (share === GC) return "GC";
  if (share === WAITING) return "Waiting";
  if (share === NOT_PROFILED) return "Not profiled";
  return categoryLabel(share);
}

/** A trace with a profile its time can be read by: a timed one, or one with no samples (the spans say it all). */
export type Readable = Shared & { profile: Profile };

/** Whether a trace's time can be read by this profile: a timed one, or one with no samples. */
export function readable(profile: Profile | undefined): profile is Profile {
  return timed(profile) || empty(profile);
}

/** Whether the trace's time can be read by its profile (readable). */
export function splitByProfile(trace: Shared): trace is Readable {
  return readable(trace.profile);
}
