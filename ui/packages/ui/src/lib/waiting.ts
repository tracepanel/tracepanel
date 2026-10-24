// When a trace's profile says when each stack was seen (its `at` buckets): the profile of a stretch of the trace, and
// which parts of a stretch the code waited in (a sleep, a socket, the event loop) rather than computed. Plain data,
// no React: the time strip, the call tree's code row and the Profile tab read it alike.
import type { Frame, Profile, Stack } from "./profile";
import type { TimeRange } from "./slice";

/** A profile with its buckets' width: one that may say when its stacks were seen. */
export type Timed = Profile & Required<Pick<Profile, "bucket_us">>;

/** A profile that says when its stacks were seen: its bucket width, and buckets on its stacks. */
export function timed(profile: Profile | undefined): profile is Timed {
  return Boolean(profile?.bucket_us && profile.stacks.some((stack) => stack.at?.length));
}

/** A bucket's stretch of the trace, in microseconds since it started. */
function bucketSpan(profile: Timed, bucket: number): TimeRange {
  return [bucket * profile.bucket_us, (bucket + 1) * profile.bucket_us];
}

function touches(a: TimeRange, b: TimeRange): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/** The profile of a stretch of the trace: each stack counted in the buckets that touch it, those seen elsewhere out. */
export function within(profile: Timed, range: TimeRange): Profile {
  const stacks = profile.stacks.flatMap((stack): Stack[] => {
    const count = (stack.at ?? [])
      .filter(([bucket]) => touches(bucketSpan(profile, bucket), range))
      .reduce((sum, [, seen]) => sum + seen, 0);
    return count > 0 ? [{ ...stack, count }] : [];
  });
  return { ...profile, stacks, samples: stacks.reduce((sum, stack) => sum + stack.count, 0) };
}

/** Whether a stack's innermost frame waits. */
export function waits(profile: Profile, stack: Stack): boolean {
  return profile.frames[stack.frames.at(-1) ?? -1]?.waiting === true;
}

/** Each bucket's samples that waited and those that didn't. */
function bucketsOf(profile: Profile): Map<number, [number, number]> {
  const buckets = new Map<number, [number, number]>();
  for (const stack of profile.stacks) {
    const waited = waits(profile, stack);
    for (const [bucket, seen] of stack.at ?? []) buckets.set(bucket, counted(buckets.get(bucket), seen, waited));
  }
  return buckets;
}

/** A bucket's [waited, other] samples, with `seen` more of one or the other. */
function counted(was: [number, number] | undefined, seen: number, waited: boolean): [number, number] {
  const [waiting, other] = was ?? [0, 0];
  return waited ? [waiting + seen, other] : [waiting, other + seen];
}

/** A part of a stretch of the trace: waited in, or computed in (or not sampled). */
export interface Piece {
  from: number;
  to: number;
  waiting: boolean;
}

/**
 * Whether a bucket's samples mostly waited; one with no samples (not sampled: its thread ran other traces) goes on
 * as the time before it did.
 */
function mostlyWaiting(buckets: ReadonlyMap<number, [number, number]>, bucket: number, before: boolean): boolean {
  const [waiting, other] = buckets.get(bucket) ?? [0, 0];
  return waiting + other === 0 ? before : waiting > other;
}

/** A piece after the last: like it, it makes it longer. */
function grow(pieces: Piece[], next: Piece): void {
  const last = pieces.at(-1);
  if (last && last.waiting === next.waiting && last.to === next.from) last.to = next.to;
  else pieces.push(next);
}

/** A stretch of the trace (µs since it started) in the parts its code waited in and those it didn't, bucket by bucket. */
export function piecesOf(profile: Timed, from: number, to: number): Piece[] {
  const buckets = bucketsOf(profile);
  const pieces: Piece[] = [];
  const width = profile.bucket_us;
  for (let bucket = Math.floor(from / width); bucket * width < to; bucket++) {
    const [start, end] = bucketSpan(profile, bucket);
    const waiting = mostlyWaiting(buckets, bucket, pieces.at(-1)?.waiting ?? false);
    grow(pieces, { from: Math.max(start, from), to: Math.min(end, to), waiting });
  }
  return pieces;
}

/** "asyncio.sleep": a library function by its package and name. */
function called(frame: Frame): string {
  const root = (frame.module ?? "").split(".")[0];
  return root ? `${root}.${frame.function}` : frame.function;
}

/** "handlers.py:108": where in a file, its line when sampled (an await's) or where the function is. */
function line(frame: Frame): string {
  return `${frame.file.split("/").at(-1)}:${frame.at_line ?? frame.line}`;
}

/** The stack that waited most, and the frame of yours that waited in it. */
function longestWait(profile: Profile): { leaf: Frame; own: Frame | undefined } | null {
  const stack = profile.stacks.filter((each) => waits(profile, each)).sort((a, b) => b.count - a.count)[0];
  if (!stack) return null;
  const frames = stack.frames.map((index) => profile.frames[index]);
  const leaf = frames.at(-1);
  if (!leaf) return null;
  return { leaf, own: frames.filter((frame) => frame?.in_app).at(-1) };
}

/** "await asyncio.sleep in build_sales_report · handlers.py:108": what the code waited on most, and where. */
export function waitOf(profile: Profile): string | null {
  const wait = longestWait(profile);
  if (!wait) return null;
  const what = `${wait.leaf.module?.startsWith("asyncio") ? "await " : ""}${called(wait.leaf)}`;
  return wait.own ? `${what} in ${wait.own.function} · ${line(wait.own)}` : what;
}

/** A stretch of a span's own code in pieces: waited in or computed in; one computed piece where the profile can't say. */
export function quietPieces(profile: Profile | undefined, from: number, to: number): Piece[] {
  return timed(profile) ? piecesOf(profile, from, to) : [{ from, to, waiting: false }];
}

/** How long a span's own code waited, of its gaps (in the trace's clock): none where the profile can't say. */
export function waitedIn(profile: Profile | undefined, gaps: readonly [number, number][], start: number): number {
  return gaps
    .flatMap(([from, to]) => quietPieces(profile, from - start, to - start))
    .filter((piece) => piece.waiting)
    .reduce((sum, piece) => sum + piece.to - piece.from, 0);
}
