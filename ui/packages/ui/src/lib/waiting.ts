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

/** The profile of the buckets `kept` takes: each stack counted in those, the others out. */
function inBuckets(profile: Timed, kept: (bucket: number) => boolean): Profile {
  const stacks = profile.stacks.flatMap((stack): Stack[] => {
    const count = (stack.at ?? []).filter(([bucket]) => kept(bucket)).reduce((sum, [, seen]) => sum + seen, 0);
    return count > 0 ? [{ ...stack, count }] : [];
  });
  return { ...profile, stacks, samples: stacks.reduce((sum, stack) => sum + stack.count, 0) };
}

/** The profile of a stretch of the trace: each stack counted in the buckets that touch it, those seen elsewhere out. */
export function within(profile: Timed, range: TimeRange): Profile {
  return inBuckets(profile, (bucket) => touches(bucketSpan(profile, bucket), range));
}

/**
 * Whose code each bucket's samples are: of the spans whose own code has a row (their gaps, in the trace's clock),
 * the one whose gaps take most of the bucket. A bucket (10 ms) can hold a transaction's last queries with the code
 * between them and the handler's code after the commit: both rows would otherwise be named by all of its samples.
 */
export function bucketOwners(
  profile: Timed,
  gaps: ReadonlyMap<string, readonly (readonly [number, number])[]>,
  start: number,
): Map<number, string> {
  const width = profile.bucket_us;
  const taken = new Map<number, Map<string, number>>();
  for (const [span, stretches] of gaps) {
    for (const [from, to] of stretches) {
      for (let bucket = Math.floor((from - start) / width); bucket * width < to - start; bucket++) {
        const [left, right] = bucketSpan(profile, bucket);
        const overlap = Math.min(right, to - start) - Math.max(left, from - start);
        if (overlap <= 0) continue;
        const here = taken.get(bucket) ?? new Map<string, number>();
        here.set(span, (here.get(span) ?? 0) + overlap);
        taken.set(bucket, here);
      }
    }
  }
  const owners = new Map<number, string>();
  for (const [bucket, spans] of taken) {
    const most = [...spans].sort((a, b) => b[1] - a[1])[0];
    if (most) owners.set(bucket, most[0]);
  }
  return owners;
}

/**
 * The profile of a span's own code in pieces (µs since the trace started): the buckets they touch whose code is the
 * span's (`owners`); every bucket they touch where none is.
 */
export function ownProfile(
  profile: Timed,
  pieces: readonly Piece[],
  owners: ReadonlyMap<number, string>,
  span: string,
): Profile {
  const touched = (bucket: number) =>
    pieces.some((piece) => touches(bucketSpan(profile, bucket), [piece.from, piece.to]));
  const owned = (bucket: number) => touched(bucket) && owners.get(bucket) === span;
  const any = profile.stacks.some((stack) => (stack.at ?? []).some(([bucket]) => owned(bucket)));
  return inBuckets(profile, any ? owned : touched);
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

/** The stack that waited most: its frames, outermost first, and the last frame of yours in it. */
function longestWait(profile: Profile): { frames: Frame[]; leaf: Frame; own: Frame | undefined } | null {
  const stack = profile.stacks.filter((each) => waits(profile, each)).sort((a, b) => b.count - a.count)[0];
  if (!stack) return null;
  const frames = stack.frames.flatMap((index) => profile.frames[index] ?? []);
  const leaf = frames.at(-1);
  if (!leaf) return null;
  return { frames, leaf, own: frames.filter((frame) => frame.in_app).at(-1) };
}

/**
 * What the app awaited, where its own code says it better than the frame that waited: a call into a thread
 * (asgiref's SyncToAsync, as `sync_to_async()` wraps it) is the app's `await sync_to_async(…)`, whatever the
 * thread then waited in.
 */
const AWAITED = new Map([
  ["asgiref.SyncToAsync.__call__", "await sync_to_async(…)"],
  ["asgiref.AsyncToSync.__call__", "async_to_sync(…)"],
]);

/** The call the app awaited, by AWAITED's words, after its own last frame: the outermost one known. */
function awaited(frames: readonly Frame[], own: Frame | undefined): string | undefined {
  const after = own ? frames.slice(frames.indexOf(own) + 1) : frames;
  return after.map((frame) => AWAITED.get(called(frame))).find(Boolean);
}

/**
 * "asyncio.sleep in build_sales_report": what the code waited on most, in which function of yours (`yours`), as the
 * app awaited it where that is known: "await sync_to_async(…) in product_feed".
 */
export function waitName(profile: Profile): { name: string; yours: boolean } | null {
  const wait = longestWait(profile);
  if (!wait) return null;
  const what = awaited(wait.frames, wait.own) ?? called(wait.leaf);
  return wait.own ? { name: `${what} in ${wait.own.function}`, yours: true } : { name: what, yours: false };
}

/** "handlers.py:108": where in your code it waited most, when a frame of yours did. */
export function waitPlace(profile: Profile): string | null {
  const own = longestWait(profile)?.own;
  return own ? line(own) : null;
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

/** The stacks seen in each bucket, by stack, and how often. */
function seenIn(profile: Profile): Map<number, Map<number, number>> {
  const buckets = new Map<number, Map<number, number>>();
  profile.stacks.forEach((stack, index) => {
    for (const [bucket, seen] of stack.at ?? []) add(buckets, bucket, index, seen);
  });
  return buckets;
}

function add(buckets: Map<number, Map<number, number>>, bucket: number, index: number, seen: number): void {
  const here = buckets.get(bucket) ?? new Map<number, number>();
  here.set(index, (here.get(index) ?? 0) + seen);
  buckets.set(bucket, here);
}

/** A bucket's time shared among the stacks seen in it, in proportion: µs per stack. */
function spread(seen: ReadonlyMap<number, number>, width: number, into: Map<number, number>): void {
  const total = [...seen.values()].reduce((sum, count) => sum + count, 0);
  for (const [index, count] of seen) into.set(index, (into.get(index) ?? 0) + (width * count) / total);
}

/** Each stack's share of the trace's own time, bucket by bucket (within `range`), carrying over unsampled buckets. */
function bucketTimes(profile: Timed, duration: number, range: TimeRange | null): Map<number, number> {
  const buckets = seenIn(profile);
  const time = new Map<number, number>();
  let before: Map<number, number> | undefined;
  for (let bucket = 0; bucket * profile.bucket_us < duration; bucket++) {
    before = buckets.get(bucket) ?? before;
    const [from, to] = bucketSpan(profile, bucket);
    if (counts(before, [from, to], range)) spread(before, Math.min(to, duration) - from, time);
  }
  return time;
}

/** Whether a bucket's time counts: it has stacks to share it (its own or the bucket's before), within the range. */
function counts(
  seen: Map<number, number> | undefined,
  span: TimeRange,
  range: TimeRange | null,
): seen is Map<number, number> {
  return seen !== undefined && (range === null || touches(span, range));
}

/**
 * The profile in the trace's own time: each bucket's time shared among the stacks seen in it; a bucket with none
 * (its thread ran other traces then) as the bucket before it, as the time strip takes it. Counted in samples of
 * the profile's interval, so its time reads as the strip's; within `range` when one is given.
 */
export function wallClock(profile: Timed, duration: number, range: TimeRange | null): Profile {
  const time = bucketTimes(profile, duration, range);
  const stacks = profile.stacks.flatMap((stack, index): Stack[] => {
    const us = time.get(index) ?? 0;
    return us > 0 ? [{ ...stack, count: us / profile.interval_us }] : [];
  });
  return { ...profile, stacks, samples: stacks.reduce((sum, stack) => sum + stack.count, 0) };
}
