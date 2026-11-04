// When a trace's profile says when each stack was seen (its `at` buckets): the stacks of each bucket of the trace's
// time (bucketStacks, what lib/timeShares splits the trace's time by), whose code row a bucket is, and what a profile
// waited on. Plain data, no React.
import type { Frame, Profile, Stack } from "./profile";
import type { TimeRange, Windows } from "./slice";

/** A profile with its buckets' width: one that may say when its stacks were seen. */
export type Timed = Profile & Required<Pick<Profile, "bucket_us">>;

/** A profile that says when its stacks were seen: its bucket width, and buckets on its stacks. */
export function timed(profile: Profile | undefined): profile is Timed {
  return Boolean(profile?.bucket_us && profile.stacks.some((stack) => stack.at?.length));
}

/** The stacks seen in each bucket, by stack, and how often (the ticks a sample stands for). */
function seenIn(profile: Profile): Map<number, Map<number, number>> {
  const buckets = new Map<number, Map<number, number>>();
  profile.stacks.forEach((stack, index) => {
    for (const [bucket, seen] of stack.at ?? []) {
      if (seen <= 0) continue;
      const here = buckets.get(bucket) ?? new Map<number, number>();
      here.set(index, (here.get(index) ?? 0) + seen);
      buckets.set(bucket, here);
    }
  });
  return buckets;
}

/**
 * Each bucket of the trace's time and the stacks it goes to: those seen in it; in one without samples (its thread ran
 * other traces, the sampler waited), those of the bucket before. Before the first sample, none: not profiled. The
 * MCP server's get_profile has the same rule (bucket_stacks in crates/mcp/src/shares.rs).
 */
export function bucketStacks(profile: Timed, duration: number): Map<number, ReadonlyMap<number, number>> {
  const seen = seenIn(profile);
  const buckets = new Map<number, ReadonlyMap<number, number>>();
  let before: ReadonlyMap<number, number> | undefined;
  for (let bucket = 0; bucket * profile.bucket_us < duration; bucket++) {
    before = seen.get(bucket) ?? before;
    if (before) buckets.set(bucket, before);
  }
  return buckets;
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
        const [left, right] = [bucket * width, (bucket + 1) * width];
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
 * The windows a span's code row is named by: its pieces in the buckets whose code is the span's (`owners`); all of
 * its pieces where none is.
 */
export function ownedWindows(
  profile: Timed,
  pieces: readonly Piece[],
  owners: ReadonlyMap<number, string>,
  span: string,
): Windows {
  const width = profile.bucket_us;
  const owned = pieces.flatMap((piece): TimeRange[] => {
    const cut: TimeRange[] = [];
    for (let bucket = Math.floor(piece.from / width); bucket * width < piece.to; bucket++) {
      if (owners.get(bucket) !== span) continue;
      const from = Math.max(piece.from, bucket * width);
      const to = Math.min(piece.to, (bucket + 1) * width);
      const last = cut.at(-1);
      if (last && last[1] === from) cut[cut.length - 1] = [last[0], to];
      else if (to > from) cut.push([from, to]);
    }
    return cut;
  });
  return owned.length ? owned : pieces.map((piece) => [piece.from, piece.to]);
}

/** Whether a stack's innermost frame waits. */
export function waits(profile: Profile, stack: Stack): boolean {
  return profile.frames[stack.frames.at(-1) ?? -1]?.waiting === true;
}

/** A part of a stretch of the trace: waited in, or computed in (or not sampled). */
export interface Piece {
  from: number;
  to: number;
  waiting: boolean;
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

/** A wait this much of the waiting time or more is one of its own in a wait's name ("and 2 more waits"). */
const OTHER_WAIT = 0.1;

/** How many other frames than `leaf` the profile waited in, each for a tenth of its waiting or more. */
function otherWaits(profile: Profile, leaf: Frame): number {
  const times = new Map<string, number>();
  for (const stack of profile.stacks.filter((each) => waits(profile, each))) {
    const frame = profile.frames[stack.frames.at(-1) ?? -1];
    if (frame && frame !== leaf) times.set(called(frame), (times.get(called(frame)) ?? 0) + stack.count);
  }
  const waited = profile.stacks.filter((each) => waits(profile, each)).reduce((sum, each) => sum + each.count, 0);
  times.delete(called(leaf));
  return [...times.values()].filter((count) => count >= waited * OTHER_WAIT).length;
}

/**
 * "asyncio.sleep in build_sales_report": what the code waited on most, in which function of yours (`yours`), as the
 * app awaited it where that is known: "await sync_to_async(…) in product_feed". Waits of their own beside it say so
 * ("waiter.acquire and 2 more waits in get_author"): its time is theirs too, as the profile it opens lists them.
 */
export function waitName(profile: Profile): { name: string; yours: boolean } | null {
  const wait = longestWait(profile);
  if (!wait) return null;
  const others = otherWaits(profile, wait.leaf);
  const more = others ? ` and ${others} more ${others === 1 ? "wait" : "waits"}` : "";
  const what = `${awaited(wait.frames, wait.own) ?? called(wait.leaf)}${more}`;
  return wait.own ? { name: `${what} in ${wait.own.function}`, yours: true } : { name: what, yours: false };
}

/** "handlers.py:108": where in your code it waited most, when a frame of yours did. */
export function waitPlace(profile: Profile): string | null {
  const own = longestWait(profile)?.own;
  return own ? line(own) : null;
}

/** The windows of pieces. */
export function windowsOf(pieces: readonly Piece[]): Windows {
  return pieces.map((piece) => [piece.from, piece.to]);
}
