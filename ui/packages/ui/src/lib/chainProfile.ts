// A chain's profiles: each app's (its traces' merged: one process, one language), never one flame across apps, and
// what each adds up to. The Profile tab of a chain of calls draws them one under another on the chain's clock.

import { type Memory, type Site, sitePlaces } from "./memory";
import { type Frame, functions, type Profile, type Stack } from "./profile";
import { type Member, type SpanScope, scopedParts } from "./scope";
import type { TimeRange } from "./slice";

/** A profiled trace of a scope, and the stretch of it the scope takes (none: all of it), from the trace's start. */
export interface ScopedProfile {
  member: Member;
  profile: Profile;
  range: TimeRange | null;
}

/** An app's profiles in a scope: one trace's as it is (its stretch picked), several merged. */
export interface AppProfile {
  app: string;
  traces: ScopedProfile[];
  /** Where it starts on the chain's clock: the apps are drawn in that order. */
  start: number;
}

/** The profiled traces a scope takes, each with the stretch of it under the rows asked for. */
export function scopedProfiles(members: readonly Member[], scope: SpanScope | null): ScopedProfile[] {
  return scopedParts(members, scope).flatMap(({ member, windows }) => {
    const profile = member.trace.profile;
    if (!profile) return [];
    const range: TimeRange | null = windows
      ? [
          Math.min(...windows.map((w) => w[0])) - member.trace.start,
          Math.max(...windows.map((w) => w[1])) - member.trace.start,
        ]
      : null;
    return [{ member, profile, range }];
  });
}

/** The scope's profiles by app, in the order the apps start. */
export function appProfiles(profiles: readonly ScopedProfile[]): AppProfile[] {
  const byApp = new Map<string, AppProfile>();
  for (const each of profiles) {
    const app = byApp.get(each.member.app);
    if (app) {
      app.traces.push(each);
      app.start = Math.min(app.start, each.member.trace.start);
    } else {
      byApp.set(each.member.app, { app: each.member.app, traces: [each], start: each.member.trace.start });
    }
  }
  return [...byApp.values()].sort((a, b) => a.start - b.start);
}

const frameKey = (frame: Frame) =>
  `${frame.function}|${frame.file}|${frame.line}|${frame.in_app}|${frame.waiting ?? ""}|${frame.at_line ?? ""}`;

/** Frames of several profiles as one list: each profile's stack mapped to indexes in it, a frame met twice once. */
function frameList(): { frames: Frame[]; mapped: (profile: Profile, stack: readonly number[]) => number[] } {
  const frames: Frame[] = [];
  const index = new Map<string, number>();
  const mapped = (profile: Profile, stack: readonly number[]) =>
    stack.map((at) => {
      const frame = profile.frames[at] as Frame;
      const key = frameKey(frame);
      let found = index.get(key);
      if (found === undefined) {
        found = frames.push(frame) - 1;
        index.set(key, found);
      }
      return found;
    });
  return { frames, mapped };
}

/** A stack's frames, mapped into one list, and what it counts (samples, bytes, blocks), added up by stack. */
function addedUp<T extends { frames: number[] }>(
  into: Map<string, T>,
  frames: number[],
  item: T,
  add: (seen: T, item: T) => void,
): void {
  const key = frames.join(",");
  const seen = into.get(key);
  if (seen) add(seen, item);
  else into.set(key, { ...item, frames });
}

/**
 * Several traces' profiles of one app as one: their frames once, their stacks' samples added up. Their timing (when
 * each stack was seen) is each trace's own, so the merged one isn't timed.
 */
export function mergeProfiles(profiles: readonly Profile[]): Profile {
  const [first] = profiles;
  // biome-ignore lint/style/useNamingConvention: the trace format.
  if (!first) return { interval_us: 1, samples: 0, frames: [], stacks: [] };
  if (profiles.length === 1) return first;
  const { frames, mapped } = frameList();
  const stacks = new Map<string, Stack>();
  for (const profile of profiles) {
    for (const stack of profile.stacks) {
      addedUp(stacks, mapped(profile, stack.frames), { frames: [], count: stack.count }, (seen, more) => {
        seen.count += more.count;
      });
    }
  }
  const dropped = profiles.reduce((sum, profile) => sum + (profile.dropped ?? 0), 0);
  return {
    // biome-ignore lint/style/useNamingConvention: the trace format.
    interval_us: first.interval_us,
    samples: profiles.reduce((sum, profile) => sum + profile.samples, 0),
    ...(dropped ? { dropped } : {}),
    frames,
    stacks: [...stacks.values()],
  };
}

/** A profile's memory, with the profile whose frames its sites index. */
export interface MemoryOf {
  profile: Profile;
  memory: Memory;
}

/** What several traces' memories say together, where they all say it the same. */
function together<T>(values: readonly (T | undefined)[]): T | undefined {
  const [first] = values;
  return values.every((value) => value === first) ? first : undefined;
}

/** Several memories' numbers as one: what they kept and allocated added up, the peak the largest of one of them. */
function memoryNumbers(memories: readonly Memory[]): Memory {
  const allocated = memories.every((memory) => memory.allocated !== undefined)
    ? memories.reduce((sum, memory) => sum + (memory.allocated ?? 0), 0)
    : undefined;
  const at = together(memories.map((memory) => memory.sites_at));
  return {
    peak: Math.max(...memories.map((each) => each.peak)),
    net: memories.reduce((sum, each) => sum + each.net, 0),
    ...(allocated === undefined ? {} : { allocated }),
    // biome-ignore lint/style/useNamingConvention: the trace format.
    ...(at ? { sites_at: at } : {}),
    ...(memories.some((each) => each.shared) ? { shared: true } : {}),
  };
}

/**
 * Several traces' memory of one app as one: their sites added up by stack (largest first), their numbers as
 * `memoryNumbers` adds them (they ran apart, each from its own start). None when none of them measured it.
 */
export function mergeMemories(profiles: readonly Profile[]): MemoryOf | undefined {
  const measured = profiles.flatMap((profile) => (profile.memory ? [{ profile, memory: profile.memory }] : []));
  const [first] = measured;
  if (!first || measured.length === 1) return first;
  const { frames, mapped } = frameList();
  const sites = new Map<string, Site>();
  for (const { profile, memory } of measured) {
    for (const site of memory.sites ?? []) {
      addedUp(sites, mapped(profile, site.frames), { ...site }, (seen, more) => {
        seen.bytes += more.bytes;
        seen.count += more.count;
      });
    }
  }
  const memory: Memory = {
    ...memoryNumbers(measured.map((each) => each.memory)),
    sites: [...sites.values()].sort((a, b) => b.bytes - a.bytes),
  };
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { profile: { interval_us: 1, samples: 0, frames, stacks: [], memory }, memory };
}

/** What a profile adds up to: its time, of it waiting (its innermost frame waits), its function that ran most. */
export function profileSums(profile: Profile): { time: number; waiting: number; top: string | undefined } {
  const waiting = profile.stacks
    .filter((stack) => profile.frames[stack.frames[stack.frames.length - 1] ?? -1]?.waiting)
    .reduce((sum, stack) => sum + stack.count, 0);
  const top = functions(profile).find((row) => !row.frame.waiting)?.frame.function;
  return { time: profile.samples * profile.interval_us, waiting: waiting * profile.interval_us, top };
}

/** What a memory adds up to: its peak, what it kept, the function that allocated most (its largest site's). */
export function memorySums({ profile, memory }: MemoryOf): { peak: number; net: number; top: string | undefined } {
  const [largest] = sitePlaces(profile, memory).sort((a, b) => b.site.bytes - a.site.bytes);
  return { peak: memory.peak, net: memory.net, top: largest?.allocated.function };
}
