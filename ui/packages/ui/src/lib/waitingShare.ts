// Waiting as a share of a trace's time, beside the categories its spans count in: what the profile says the code
// waited in (a sleep, a timer, a socket, a lock), not computing, taken out of the code's own shares, as the Profile
// tab has it. One rule for every bar of the trace's time (the time strip's legend, the page's card). Plain data, no
// React.
import type { Trace } from "../types";
import type { Category } from "./breakdown";
import { GC } from "./memory";
import { offCpu } from "./offCpu";
import { onCpuOnly, type Profile, WAITING } from "./profile";
import { rounded, type Segment, segmentsOf } from "./timeShares";
import { timed, waits } from "./waiting";

/** The waiting share: neutral and hatched, as the strip draws the code's waits. */
export const WAITED_SHARE = WAITING;

/** The categories whose time is the code's own: what it waited in is taken out of them; a call's is its own share. */
const OWN_CODE: ReadonlySet<string> = new Set<Category>(["code", "django", "signal", "template"]);

/** The wall-clock time the profile says the code waited, in all: Go's and Node's off the CPU, else its waiting samples. */
function profileWaiting(profile: Profile, trace: Pick<Trace, "duration" | "attrs">): number {
  if (onCpuOnly(trace)) return offCpu(profile, trace);
  const waited = profile.stacks.filter((stack) => waits(profile, stack)).reduce((sum, stack) => sum + stack.count, 0);
  return waited * profile.interval_us;
}

function sumOf(parts: readonly (readonly [unknown, number])[]): number {
  return parts.reduce((sum, [, value]) => sum + value, 0);
}

/**
 * How long each of the code's shares waited (µs), for a profile that doesn't say when its stacks were seen: the
 * profile's waiting less the calls' time (a query's wait is the database's share), shared among the code's shares by
 * their time. A timed one's shares are lib/timeShares'.
 */
function waitedBy(trace: Trace, parts: readonly (readonly [string, number])[]): Map<string, number> {
  const profile = trace.profile;
  const waited = new Map<string, number>();
  if (!profile) return waited;
  const own = parts.filter(([category]) => OWN_CODE.has(category));
  const ownTime = sumOf(own);
  const calls = sumOf(parts.filter(([category]) => !OWN_CODE.has(category) && category !== "gc"));
  const total = Math.min(Math.max(profileWaiting(profile, trace) - calls, 0), ownTime);
  if (total <= 0) return waited;
  for (const [category, value] of own) waited.set(category, (waited.get(category) ?? 0) + (total * value) / ownTime);
  return waited;
}

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
 * to the same time. A share left with nothing is left out.
 */
export function withWaiting<K extends string>(
  trace: Trace,
  parts: readonly (readonly [K, number])[],
): [K | typeof WAITED_SHARE, number][] {
  if (timed(trace.profile)) return timedShares(trace, parts);
  const waited = waitedBy(trace, parts);
  const split = parts.flatMap(([category, value]): [K, number][] => {
    const left = value - Math.min(waited.get(category) ?? 0, value);
    return left > 0 ? [[category, left]] : [];
  });
  const waiting = sumOf(parts) - sumOf(split);
  return waiting >= 1 ? [...split, [WAITED_SHARE, waiting]] : split;
}
