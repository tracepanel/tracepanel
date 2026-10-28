// A chain's profiles: each app's (its traces' merged: one process, one language), never one flame across apps, and
// what each adds up to. The Profile tab of a chain of calls draws them one under another on the chain's clock.

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

/**
 * Several traces' profiles of one app as one: their frames once, their stacks' samples added up. Their timing (when
 * each stack was seen) is each trace's own, so the merged one isn't timed.
 */
export function mergeProfiles(profiles: readonly Profile[]): Profile {
  const [first] = profiles;
  // biome-ignore lint/style/useNamingConvention: the trace format.
  if (!first) return { interval_us: 1, samples: 0, frames: [], stacks: [] };
  if (profiles.length === 1) return first;
  const frames: Frame[] = [];
  const index = new Map<string, number>();
  const stacks = new Map<string, Stack>();
  let dropped = 0;
  for (const profile of profiles) {
    dropped += profile.dropped ?? 0;
    for (const stack of profile.stacks) {
      const mapped = stack.frames.map((at) => {
        const frame = profile.frames[at] as Frame;
        const key = frameKey(frame);
        let found = index.get(key);
        if (found === undefined) {
          found = frames.push(frame) - 1;
          index.set(key, found);
        }
        return found;
      });
      const key = mapped.join(",");
      const seen = stacks.get(key);
      if (seen) seen.count += stack.count;
      else stacks.set(key, { frames: mapped, count: stack.count });
    }
  }
  return {
    // biome-ignore lint/style/useNamingConvention: the trace format.
    interval_us: first.interval_us,
    samples: profiles.reduce((sum, profile) => sum + profile.samples, 0),
    ...(dropped ? { dropped } : {}),
    frames,
    stacks: [...stacks.values()],
  };
}

/** What a profile adds up to: its time, of it waiting (its innermost frame waits), its function that ran most. */
export function profileSums(profile: Profile): { time: number; waiting: number; top: string | undefined } {
  const waiting = profile.stacks
    .filter((stack) => profile.frames[stack.frames[stack.frames.length - 1] ?? -1]?.waiting)
    .reduce((sum, stack) => sum + stack.count, 0);
  const top = functions(profile).find((row) => !row.frame.waiting)?.frame.function;
  return { time: profile.samples * profile.interval_us, waiting: waiting * profile.interval_us, top };
}
