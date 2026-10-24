// What a profiled trace's code allocated and how long the garbage collector stopped it: its facts in the header, its
// allocation sites as a profile (bytes where the time profile has samples) for the Profile tab, its pauses for the
// time strip. Plain data, no React.
import { bytes, duration } from "../format";
import type { Frame, Profile } from "./profile";
import type { TimeRange } from "./slice";

export type Memory = NonNullable<Profile["memory"]>;
export type Site = NonNullable<Memory["sites"]>[number];

/** "↑ 42 MB peak", "GC 3× 12 ms": what the header says of a profile's memory and collections, the parts it has. */
export function memoryFacts(profile: Profile | undefined): string[] {
  return [peakFact(profile?.memory), gcFact(profile?.gc)].filter((fact) => fact !== null);
}

function peakFact(memory: Memory | undefined): string | null {
  return memory ? `↑ ${bytes(memory.peak)} peak` : null;
}

function gcFact(gc: Profile["gc"]): string | null {
  return gc?.collections ? `GC ${gc.collections}× ${duration(gc.pause_us)}` : null;
}

/**
 * The allocation sites as a profile is read: each site a stack, its bytes its count (a "sample" of one byte). The
 * time profile's views (by package, the flame graph, your code or every frame) then read it as they read time.
 */
export function memoryProfile(profile: Profile, memory: Memory): Profile {
  const stacks = (memory.sites ?? []).filter((site) => site.bytes > 0);
  return {
    frames: profile.frames,
    // biome-ignore lint/style/useNamingConvention: a profile as the SDKs send it.
    interval_us: 1,
    samples: stacks.reduce((sum, site) => sum + site.bytes, 0),
    stacks: stacks.map((site) => ({ frames: site.frames, count: site.bytes })),
  };
}

/** A site as its list says it: the function that allocated, and the line of your code that led there. */
export interface SitePlace {
  site: Site;
  allocated: Frame;
  /** The innermost frame of the project's own, else the one that allocated. */
  own: Frame;
}

/** The sites with bytes, where they are; one whose frames the profile doesn't have is left out. */
export function sitePlaces(profile: Profile, memory: Memory): SitePlace[] {
  return (memory.sites ?? []).flatMap((site): SitePlace[] => {
    const frames = site.frames.flatMap((index) => profile.frames[index] ?? []);
    const allocated = frames.at(-1);
    if (!(allocated && site.bytes > 0)) return [];
    return [{ site, allocated, own: frames.filter((frame) => frame.in_app).at(-1) ?? allocated }];
  });
}

/** The time strip's share for the collector's pauses: its own colour, solid like every share but waiting. */
export const GC = "gc";

/** The collector's pauses on the trace's clock (µs since it started), within it and in order. */
export function gcPauses(profile: Profile | undefined, total: number): TimeRange[] {
  return (profile?.gc?.pauses ?? [])
    .map(([from, length]): TimeRange => [Math.min(from, total), Math.min(from + length, total)])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
}

/** A stretch of time cut by the pauses: its parts outside them, and those inside (`gc`). */
export function cutByPauses(
  from: number,
  to: number,
  pauses: readonly TimeRange[],
): { range: TimeRange; gc: boolean }[] {
  const inside = pauses
    .map(([start, end]): TimeRange => [Math.max(start, from), Math.min(end, to)])
    .filter(([start, end]) => end > start);
  // From one edge to the next, outside a pause and in one by turns.
  const edges = [from, ...inside.flat(), to];
  return edges
    .slice(1)
    .map((end, index) => ({ range: [edges[index] ?? end, end] as TimeRange, gc: index % 2 === 1 }))
    .filter(({ range: [start, end] }) => end > start);
}
