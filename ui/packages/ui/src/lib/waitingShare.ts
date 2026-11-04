// Waiting as a share of a trace's time, beside the categories its spans count in: what the profile says the code
// waited in (a sleep, a timer, a socket, a lock), not computing, taken out of the code's own shares, as the Profile
// tab has it (lib/timeShares). One rule for every bar of the trace's time (the time strip's legend, the page's card).
// Plain data, no React.
import type { Trace } from "../types";
import { breakdown, type Category, stretches } from "./breakdown";
import { cutByPauses, GC, gcPauses } from "./memory";
import { WAITING } from "./profile";
import { rounded, type Segment, segmentsOf } from "./timeShares";
import { timed } from "./waiting";

/** The waiting share: neutral and hatched, as the strip draws the code's waits. */
export const WAITED_SHARE = WAITING;

/** A segment's share where the collector's pauses aren't one: the share of what they stopped. */
function shareWithoutGc(segment: Segment): string {
  return segment.share === GC ? segment.category : segment.share;
}

/**
 * A timed profile's trace by share (lib/timeShares): the shares the strip draws, its waits and the framework's time
 * split out of the code's own. The collector's pauses are their own share where `parts` has one (the legend's), else
 * the time of the share they stopped.
 */
function timedShares<K extends string>(
  trace: Trace,
  parts: readonly (readonly [K, number])[],
): [K | typeof WAITED_SHARE, number][] {
  const gc = parts.some(([category]) => category === GC);
  const times = new Map<string, number>();
  for (const segment of segmentsOf(trace)) {
    const share = gc ? segment.share : shareWithoutGc(segment);
    times.set(share, (times.get(share) ?? 0) + segment.to - segment.from);
  }
  const said = rounded(times);
  const waiting = said.get(WAITED_SHARE) ?? 0;
  said.delete(WAITED_SHARE);
  const split = [...said].filter(([, value]) => value > 0) as [K, number][];
  return waiting >= 1 ? [...split, [WAITED_SHARE, waiting]] : split;
}

/**
 * The trace's time by share with waiting split out of the code's own shares (its own share, last): the shares add up
 * to the same time. A share left with nothing is left out. Without a timed profile (none, or one too short for a
 * sample), the parts as they are: nothing says when the code waited.
 */
export function withWaiting<K extends string>(
  trace: Trace,
  parts: readonly (readonly [K, number])[],
): [K | typeof WAITED_SHARE, number][] {
  if (timed(trace.profile)) return timedShares(trace, parts);
  return parts.filter(([, value]) => value > 0).map(([category, value]): [K, number] => [category, value]);
}

/** The stretches added up, the collector's pauses taken out of the shares they stopped and counted as their own. */
function byPause(trace: Trace): [Category | typeof GC, number][] {
  const pauses = gcPauses(trace.profile, trace.duration);
  if (pauses.length === 0) return breakdown(trace);
  const sums = new Map<Category | typeof GC, number>();
  for (const { from, to, category } of stretches(trace)) {
    for (const { range, gc } of cutByPauses(from, to, pauses)) {
      const share = gc ? GC : category;
      sums.set(share, (sums.get(share) ?? 0) + range[1] - range[0]);
    }
  }
  return [...sums];
}

/**
 * Where the wall-clock time went, per share, as every bar of a trace's time says it (the strip's legend, the
 * Profile tab's bar, the widget's card): the stretches added up, the collector's pauses (a profile's) taken out of the
 * shares they stopped and counted as their own, and the code's waits out of its own shares (withWaiting).
 */
export function timeParts(trace: Trace): [Category | typeof GC | typeof WAITED_SHARE, number][] {
  return withWaiting<Category | typeof GC>(trace, byPause(trace));
}
