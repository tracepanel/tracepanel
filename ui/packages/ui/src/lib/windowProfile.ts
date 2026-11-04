// A profile of a trace's time, or of stretches of it, as its shares have it (lib/timeShares) and as its split says
// them (lib/split): each segment's stacks for as much of it as the stretches take, a call's, the collector's or the
// framework's time under a frame of that share, rounded so every sum of it said is the split's. What the Profile
// tab's flame graph and functions read, and what names a code row. Plain data, no React.
import type { Span } from "../types";
import { GC } from "./memory";
import { apportion } from "./percent";
import { type Frame, type Profile, type ShareFrame, type Stack, shareFrame, WAITING } from "./profile";
import type { Windows } from "./slice";
import { type Split, shareIn, splitOf, taken } from "./split";
import { NOT_PROFILED, OWN_CODE, type Readable, type Segment, type Share, segmentsOf, shareLabel } from "./timeShares";
import { callLabel, waitFrame } from "./waitCalls";

/** The frame a segment's time goes under in a profile, where its share isn't the code's own or a wait. */
function frameOf(segment: Segment, byId: ReadonlyMap<string, Span>): ShareFrame | null {
  if (segment.share === "code" || segment.share === WAITING) return null;
  const share = shareLabel(segment.share);
  const span = byId.get(segment.span);
  const call =
    segment.share !== GC && segment.share !== NOT_PROFILED && !OWN_CODE.has(segment.share) && span ? span : null;
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

/** A stack's time in a profile of windows, before it is rounded: its share's, by bucket (µs). */
interface Timing {
  frames: number[];
  share: Share;
  us: number;
  at: Map<number, number>;
}

/** A stack seen for `us` in a bucket, added to the stacks by its frames. */
function addStack(stacks: Map<string, Timing>, path: number[], share: Share, us: number, bucket: number): void {
  const key = path.join(",");
  const found = stacks.get(key) ?? { frames: path, share, us: 0, at: new Map<number, number>() };
  found.us += us;
  found.at.set(bucket, (found.at.get(bucket) ?? 0) + us);
  stacks.set(key, found);
}

/** The share a stack of a window's profile is time of: its share's frame's, a wait's, else your code's. */
function shareOfStack(profile: Profile, stack: Stack): Share {
  const leaf = profile.frames[stack.frames.at(-1) ?? -1];
  const share = shareFrame(leaf);
  if (share) return share.category as Share;
  return leaf?.waiting === true ? WAITING : "code";
}

/**
 * A profile of a split's time (a window's, or an app's traces' merged) as the split says it: each share's stacks
 * rounded to add up to that share's said time (split.ts), so every sum of them said (a share, a function's own time,
 * all of it) is the split's. Counted in samples of the profile's interval.
 */
export function sayProfile(profile: Profile, split: Split): Profile {
  const byShare = new Map<Share, Stack[]>();
  for (const stack of profile.stacks) {
    const share = shareOfStack(profile, stack);
    byShare.set(share, [...(byShare.get(share) ?? []), stack]);
  }
  const interval = profile.interval_us;
  const stacks = [...byShare].flatMap(([share, list]) => {
    const target = shareIn(split, share)?.us ?? 0;
    const parts = apportion(
      list.map((each) => each.count * interval),
      split.step,
      Math.round(target / split.step),
    );
    return list.flatMap((each, at): Stack[] => {
      const us = parts[at] ?? 0;
      if (us <= 0) return [];
      const scale = us / (each.count * interval);
      const timedAt = each.at ? { at: each.at.map(([bucket, seen]): [number, number] => [bucket, seen * scale]) } : {};
      return [{ frames: each.frames, count: us / interval, ...timedAt }];
    });
  });
  return { ...profile, stacks, samples: sum(stacks.map((stack) => stack.count)) };
}

function sum(values: readonly number[]): number {
  return values.reduce((all, value) => all + value, 0);
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
 * The profile of the trace's time, or of the windows', as its shares have it, unrounded: each segment's stacks for
 * as much of it as the windows take, a call's, the collector's or the framework's time under a frame of that share
 * (ShareFrame). `named`: Your code's, its waits named by the frame that waited ("waiting · waiter.acquire"). Counted
 * in samples of the profile's interval; sayProfile rounds it as its split says it.
 */
export function rawWindowProfile(trace: Readable, windows: Windows | null, named = false): Profile {
  const { profile } = trace;
  const width = profile.bucket_us ?? Number.POSITIVE_INFINITY;
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  const { frames, frameAt } = frameTable(profile);
  const timings = new Map<string, Timing>();
  for (const segment of segmentsOf(trace)) {
    const time = taken(segment.from, segment.to, windows);
    if (time <= 0) continue;
    const frame = frameOf(segment, byId);
    const share = frame ? frameAt(frame) : null;
    const bucket = Math.floor(segment.from / width);
    // Time the profile has no samples of is its share's all the same (a call's, the collector's, not profiled), as
    // the strip says it: under that share's frame alone.
    if (!segment.stacks) {
      if (share !== null) addStack(timings, [share], segment.share, time, bucket);
      continue;
    }
    const part = time / (segment.to - segment.from);
    for (const [at, us] of segment.stacks) {
      const path = pathIn(profile, profile.stacks[at] as Stack, share, named, frameAt);
      addStack(timings, path, segment.share, us * part, bucket);
    }
  }
  const interval = profile.interval_us;
  const stacks = [...timings.values()].map(
    (timing): Stack => ({
      frames: timing.frames,
      count: timing.us / interval,
      ...(Number.isFinite(width)
        ? { at: [...timing.at].map(([bucket, us]): [number, number] => [bucket, us / interval]) }
        : {}),
    }),
  );
  return { ...profile, frames, stacks, samples: sum(stacks.map((stack) => stack.count)) };
}

/** The profile of the trace's time, or of the windows', as its split says it (rawWindowProfile, sayProfile). */
export function windowProfile(trace: Readable, windows: Windows | null, named = false): Profile {
  return sayProfile(rawWindowProfile(trace, windows, named), splitOf(trace, windows));
}
