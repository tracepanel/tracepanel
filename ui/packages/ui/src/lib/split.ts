// Where a trace's time went, said once: the one result every view of it reads. Of the whole trace or of stretches of
// it (a code row's, a range picked), or of an app's traces in a chain: its shares (Database, Your code, Waiting…) in
// µs and in percent, rounded once so the times add up to the total and the percents to 100%; how much of it the
// profile covers (the rest its code's time it didn't sample: Not profiled); how many samples it is drawn from; what
// it is of. The time strip's legend, the hover card, the Profile tab's head and bar, a code row's time and its
// stretch's profile, and the MCP server's get_profile (crates/mcp/src/shares.rs, the same rule, its cases in
// schema/waits.json) say this and nothing they work out themselves. Plain data, no React.
import { duration } from "../format";
import { apportion, percents } from "./percent";
import type { Profile } from "./profile";
import { type TimeRange, type Windows, windowsLabel } from "./slice";
import { NOT_PROFILED, type Share, type Shared, segmentsOf, shareLabel } from "./timeShares";
import { type Timed, timed } from "./waiting";

/** A share of the time as said: its time (µs, rounded with the rest), that time written, its percent. */
export interface SaidShare {
  share: Share;
  label: string;
  us: number;
  time: string;
  percent: string;
}

/** Where the time of a trace (or of stretches of it, or of an app's traces) went, as every view says it. */
export interface Split {
  /** What it is of: "the whole trace", "93 ms – 100 ms", "3 traces". */
  of: string;
  /** The stretches it is of (µs since the trace started); none: all of it. */
  windows: Windows | null;
  /** Its time (µs): its shares' added up; and written at the split's step, as its shares are. */
  total: number;
  time: string;
  /** Largest first, waiting last; none with no time. */
  shares: SaidShare[];
  /** How much of it the profile covers: all but its code's time before the first sample (Not profiled); written. */
  profiled: number;
  covered: string;
  /** How many samples it is drawn from (the profile's in its stretches); 0 without a profile. */
  samples: number;
  /** "50 samples, one every 1 ms", as the profile took them; null without a profile. */
  sampled: string | null;
  /** The step its times are rounded to and written at (µs): the one the console says its total in. */
  step: number;
  /** Its time before it is said (µs): its total is written as the console's duration writes this. */
  exact: number;
}

/** What a split adds up before it is said: each share's time, the samples behind it. */
interface Raw {
  times: Map<Share, number>;
  samples: Samples | null;
}

/** The samples behind a split, as the profile took them. */
interface Samples {
  /** Every sample in it; and of them the CPU's (a spread profile's, not waiting). */
  all: number;
  cpu: number;
  /** A CPU time estimated from fewer samples (Go on macOS): how many. */
  estimated: number | null;
  spread: boolean;
  interval: number;
}

/**
 * The step a time is written at by the console's duration (format.ts): a µs under 0.1 ms, a tenth of a millisecond
 * under one, a millisecond under a second, else a tenth of a second.
 */
export function displayStep(us: number): number {
  const ms = us / 1000;
  if (ms < 0.1) return 1;
  if (ms < 1) return 100;
  return ms < 1000 ? 1000 : 100_000;
}

/** How much of a stretch (`from`–`to`) the windows take (all of it with none). */
export function taken(from: number, to: number, windows: Windows | null): number {
  if (windows === null) return to - from;
  return windows.reduce((sum, [start, end]) => sum + Math.max(Math.min(to, end) - Math.max(from, start), 0), 0);
}

/** A share of stretches of a bucket's `width` from `bucket`: how much of it the windows take, as a fraction. */
function bucketPart(bucket: number, width: number, windows: Windows): number {
  return taken(bucket * width, (bucket + 1) * width, windows) / width;
}

/** Whether a stack's innermost frame waited. */
function waits(profile: Profile, frames: readonly number[]): boolean {
  return profile.frames[frames.at(-1) ?? -1]?.waiting === true;
}

/** The samples a profile seen in the windows (`all`), and of them those not waiting (`cpu`), by its buckets. */
function seenIn(profile: Timed, windows: Windows): { all: number; cpu: number } {
  let [all, cpu] = [0, 0];
  for (const stack of profile.stacks) {
    const ran = !waits(profile, stack.frames);
    for (const [bucket, count] of stack.at ?? []) {
      const seen = count * bucketPart(bucket, profile.bucket_us, windows);
      all += seen;
      if (ran) cpu += seen;
    }
  }
  return { all, cpu };
}

/** The profile's samples in the windows: by the buckets they were seen in, as much of each as the windows take. */
function samplesOf(profile: Profile | undefined, windows: Windows | null): Samples | null {
  if (!profile) return null;
  const estimated = profile.estimated_from ?? null;
  const base = { spread: profile.spread === true, interval: profile.interval_us };
  if (windows === null || !timed(profile)) {
    const waited = profile.stacks
      .filter((stack) => waits(profile, stack.frames))
      .reduce((sum, stack) => sum + stack.count, 0);
    return { ...base, all: profile.samples, cpu: profile.samples - waited, estimated };
  }
  const { all, cpu } = seenIn(profile, windows);
  const scaled = estimated === null || profile.samples <= 0 ? null : Math.round((estimated * all) / profile.samples);
  return { ...base, all: Math.round(all), cpu: Math.round(cpu), estimated: scaled };
}

/** "1 sample", "1,204 samples": a count as the page writes one, its thousands apart. */
export function counted(count: number, one: string, many: string): string {
  const digits = String(Math.round(count));
  return `${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${count === 1 ? one : many}`;
}

/** What a CPU profile placed on the trace's clock (`spread`, Go's) says of its waits: they weren't sampled. */
const SPREAD = "spread evenly over your code's time, the rest of it waiting off the CPU (not sampled)";

/**
 * "110 samples, one every 10 ms": what the profile took. A CPU profile the agent placed on the trace's clock (Go's)
 * says its samples are the CPU's, spread; one whose CPU time is an estimate too (Go on macOS, whose kernel hands the
 * profiler's samples out unevenly) says from how many samples.
 */
function sampledLine(samples: Samples): string {
  if (samples.estimated !== null) {
    const estimated = `CPU time estimated from ${counted(samples.estimated, "sample", "samples")} (macOS hands the profiler's samples out unevenly, so each is weighed)`;
    return samples.spread ? `${estimated}, ${SPREAD}` : estimated;
  }
  const every = `one every ${duration(samples.interval)}`;
  if (samples.spread) return `${counted(samples.cpu, "sample", "samples")} of CPU time, ${every}, ${SPREAD}`;
  return `${counted(samples.all, "sample", "samples")}, ${every}`;
}

/** The time each share took in the windows (all of it with none), in the order the trace first had them. */
function rawOf(trace: Shared, windows: Windows | null): Raw {
  const times = new Map<Share, number>();
  for (const segment of segmentsOf(trace)) {
    const time = taken(segment.from, segment.to, windows);
    if (time > 0) times.set(segment.share, (times.get(segment.share) ?? 0) + time);
  }
  return { times, samples: samplesOf(trace.profile, windows) };
}

/**
 * A time (µs, a whole number of `step`s) written at a split's step, as the console's duration writes its total:
 * "1.6 s", "0.2 s", "3 ms", "0.8 ms", "27 µs".
 */
export function writtenAt(us: number, step: number): string {
  const whole = Math.round(us);
  if (step >= 100_000) return `${Math.floor(whole / 1_000_000)}.${Math.round((whole % 1_000_000) / 100_000)} s`;
  if (step >= 1000) return `${Math.round(whole / 1000)} ms`;
  if (step >= 100) return `${Math.floor(whole / 1000)}.${Math.round((whole % 1000) / 100)} ms`;
  return `${whole} µs`;
}

/**
 * How many steps a time is as the console's duration writes it: its tenths rounded as toFixed rounds them (of the
 * number's exact value), its whole ms and µs as Math.round does. The total said is then the total as written.
 */
function stepsOf(us: number, step: number): number {
  if (step >= 100_000) return Math.round(Number((us / 1_000_000).toFixed(1)) * 10);
  if (step >= 1000) return Math.round(us / 1000);
  if (step >= 100) return Math.round(Number((us / 1000).toFixed(1)) * 10);
  return Math.round(us);
}

/** Less than a step, as a share with some time that rounds to none reads: "<0.1 s", "<1 ms", "<0.1 ms", "<1 µs". */
const UNDER: Readonly<Record<number, string>> = { 100000: "<0.1 s", 1000: "<1 ms", 100: "<0.1 ms", 1: "<1 µs" };

/** A share's time written at the split's step; one too short to round to a step, under it. */
function shareTime(us: number, step: number): string {
  return Math.round(us) > 0 ? writtenAt(us, step) : (UNDER[step] ?? "<1 µs");
}

/** Waiting after the rest, the rest by their time before it is said, largest first (as long: as the trace had them). */
function byTime(a: [Share, number], b: [Share, number]): number {
  const waiting = (entry: [Share, number]) => (entry[0] === "waiting" ? 1 : 0);
  return waiting(a) - waiting(b) || b[1] - a[1];
}

/**
 * The raw times said. The total is said at the step the console says it in (displayStep), as the page's header says
 * it; the shares are rounded to that step by largest remainder, so as written they add up to the total as written. A
 * share with time that rounds to none still shows: "<1 ms". Percents of the time before it is rounded, largest
 * remainder, adding up to 100% ("<1%" a share too small for one).
 */
function said(raw: Raw, of: string, windows: Windows | null): Split {
  // Time less than half a µs is the arithmetic's, no share's.
  const entries = [...raw.times].filter(([, us]) => us >= 0.5).sort(byTime);
  const exact = entries.map(([, us]) => us);
  const sum = exact.reduce((all, us) => all + us, 0);
  const step = displayStep(sum);
  const rounded = apportion(exact, step, stepsOf(sum, step));
  const total = rounded.reduce((all, us) => all + us, 0);
  const percent = percents(exact, sum);
  const shares = entries.map(
    ([share], at): SaidShare => ({
      share,
      label: shareLabel(share),
      us: rounded[at] ?? 0,
      time: shareTime(rounded[at] ?? 0, step),
      percent: percent[at] ?? "0%",
    }),
  );
  const unprofiled = shares.find((share) => share.share === NOT_PROFILED)?.us ?? 0;
  return {
    of,
    windows,
    total,
    time: writtenAt(total, step),
    shares,
    profiled: total - unprofiled,
    covered: writtenAt(total - unprofiled, step),
    samples: raw.samples?.all ?? 0,
    sampled: raw.samples ? sampledLine(raw.samples) : null,
    step,
    exact: sum,
  };
}

const SPLITS = new WeakMap<object, Map<string, Split>>();

/** The windows as one key: their ends in whole µs. */
function windowsKey(windows: Windows | null): string {
  return windows === null ? "" : windows.map(([from, to]) => `${from}-${to}`).join(",");
}

/**
 * Where the trace's time went, of all of it or of the windows' (µs since it started): the one result the strip, its
 * legend, the hover card, a code row, the Profile tab and its stretches read. Worked out once per trace and windows.
 */
export function splitOf(trace: Shared, windows: Windows | null = null): Split {
  const known = SPLITS.get(trace) ?? new Map<string, Split>();
  SPLITS.set(trace, known);
  const key = windowsKey(windows);
  const found = known.get(key);
  if (found) return found;
  const split = said(rawOf(trace, windows), windows === null ? "the whole trace" : windowsLabel(windows), windows);
  known.set(key, split);
  return split;
}

/** One app's traces in a chain (each of all of it or of its windows), added up before they are said: one split. */
export function appSplit(parts: readonly { trace: Shared; windows: Windows | null }[]): Split {
  const [first] = parts;
  if (parts.length === 1 && first) return splitOf(first.trace, first.windows);
  const times = new Map<Share, number>();
  let samples: Samples | null = null;
  for (const { trace, windows } of parts) {
    const raw = rawOf(trace, windows);
    for (const [share, us] of raw.times) times.set(share, (times.get(share) ?? 0) + us);
    samples = added(samples, raw.samples);
  }
  return said({ times, samples }, `${parts.length} traces`, null);
}

/** Two traces' samples as one app's. */
function added(sum: Samples | null, more: Samples | null): Samples | null {
  if (!(sum && more)) return sum ?? more;
  const estimated = sum.estimated === null || more.estimated === null ? null : sum.estimated + more.estimated;
  return {
    all: sum.all + more.all,
    cpu: sum.cpu + more.cpu,
    estimated,
    spread: sum.spread && more.spread,
    interval: sum.interval,
  };
}

/** A share's said time and percent, where the split has it. */
export function shareIn(split: Split, share: Share): SaidShare | undefined {
  return split.shares.find((each) => each.share === share);
}

/**
 * Stretches in whole µs, those that meet as one: what a link carries of them (stretchText), so a code row's time and
 * the profile it opens are of the same stretches.
 */
export function wholeWindows(windows: Windows): Windows {
  const out: [number, number][] = [];
  for (const [from, to] of windows.map(([a, b]): TimeRange => [Math.round(a), Math.round(b)])) {
    if (to <= from) continue;
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** What a split is of, as a profile's head says it: "the trace's 123 ms", "the stretch's 7 ms", "these stretches' 9 ms". */
export function ofWhat(split: Split): string {
  const time = split.time;
  if (!split.windows) return split.of.endsWith("traces") ? `the traces' ${time}` : `the trace's ${time}`;
  return split.windows.length > 1 ? `these stretches' ${time}` : `the stretch's ${time}`;
}

/** The split as the shared cases (schema/waits.json) and the MCP server write it. */
export function splitJson(split: Split): Record<string, unknown> {
  return {
    of: split.of,
    windows: split.windows,
    total: split.total,
    time: split.time,
    shares: split.shares.map(({ label, us, time, percent }) => [label, us, time, percent]),
    profiled: split.profiled,
    covered: split.covered,
    samples: split.samples,
    sampled: split.sampled,
  };
}
