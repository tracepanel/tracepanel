// Waiting as a share of a trace's time, beside the categories its spans count in: what the profile says the code
// waited in (a sleep, a timer, a socket, a lock), not computing, taken out of the code's own shares, as the Profile
// tab has it. One rule for every bar of the trace's time (the time strip's legend, the page's card). Plain data, no
// React.
import type { Trace } from "../types";
import { type Category, spanCategories } from "./breakdown";
import { offCpu } from "./offCpu";
import { onCpuOnly, type Profile, WAITING } from "./profile";
import { type Quiet, quietSpans } from "./quiet";
import { timed, waitedIn, waits } from "./waiting";

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
 * How long each of the code's shares waited (µs). A profile that says when its stacks were seen: the waits in the
 * spans' own time with no calls running, as the strip hatches them. One that doesn't: the profile's waiting less the
 * calls' time (a query's wait is the database's share), shared among the code's shares by their time.
 */
function waitedBy(trace: Trace, parts: readonly (readonly [string, number])[]): Map<string, number> {
  const profile = trace.profile;
  const waited = new Map<string, number>();
  if (!profile) return waited;
  if (timed(profile)) {
    const categories = spanCategories(trace);
    for (const [span, quiet] of quietSpans(trace)) {
      const category = categories.get(span);
      if (category) waited.set(category, (waited.get(category) ?? 0) + waitsOf(trace, quiet));
    }
    return waited;
  }
  const own = parts.filter(([category]) => OWN_CODE.has(category));
  const ownTime = sumOf(own);
  const calls = sumOf(parts.filter(([category]) => !OWN_CODE.has(category) && category !== "gc"));
  const total = Math.min(Math.max(profileWaiting(profile, trace) - calls, 0), ownTime);
  if (total <= 0) return waited;
  for (const [category, value] of own) waited.set(category, (waited.get(category) ?? 0) + (total * value) / ownTime);
  return waited;
}

function waitsOf(trace: Trace, quiet: Quiet): number {
  return waitedIn(trace.profile, quiet.gaps, trace.start);
}

/**
 * The trace's time by share with waiting split out of the code's own shares (its own share, last): the shares add up
 * to the same time. A share left with nothing is left out.
 */
export function withWaiting<K extends string>(
  trace: Trace,
  parts: readonly (readonly [K, number])[],
): [K | typeof WAITED_SHARE, number][] {
  const waited = waitedBy(trace, parts);
  const split = parts.flatMap(([category, value]): [K, number][] => {
    const left = value - Math.min(waited.get(category) ?? 0, value);
    return left > 0 ? [[category, left]] : [];
  });
  const waiting = sumOf(parts) - sumOf(split);
  return waiting >= 1 ? [...split, [WAITED_SHARE, waiting]] : split;
}
