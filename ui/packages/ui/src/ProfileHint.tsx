// What ran in a trace's code where nothing it called was recorded: its profile's own functions, or how to get a
// profile. The time strip's tooltip and the call tree's code row say it alike.
import { percent } from "./lib/percent";
import { ownHotspots } from "./lib/profile";
import { useProfilingOf } from "./Profiling";
import type { Trace } from "./types";

/**
 * What ran in the code's own time: the trace's profile (the whole trace's: its samples aren't timed, so not this
 * stretch's alone), its own functions by where they were when sampled; without one, how to get one, where the app
 * profiles on request.
 */
export function WhatRan({ trace }: { trace: Trace }) {
  const profiling = useProfilingOf(trace);
  if (trace.profile) return <Hotspots profile={trace.profile} />;
  if (!profiling.available) return null;
  return (
    <span className="grid gap-0.5">
      <span>Turn on Profile to see what ran here</span>
      <span className="text-xs text-muted-foreground">
        {profiling.turnOn
          ? "Profile is in the legend below"
          : "with the panel's 🔥 or an X-Tracepanel-Profile: 1 header"}
      </span>
    </span>
  );
}

/** The profile's own functions, each where your code was when sampled, the whole trace over; a click opens it. */
function Hotspots({ profile }: { profile: NonNullable<Trace["profile"]> }) {
  return (
    <span className="grid gap-1">
      <span className="font-medium">Profile of the whole trace</span>
      <span className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5">
        {ownHotspots(profile).map(({ name, share }) => (
          <span key={name} className="contents">
            <span className="truncate font-mono text-xs">{name}</span>
            <span className="text-right text-xs text-muted-foreground tabular-nums">{percent(share, 1)}</span>
          </span>
        ))}
      </span>
      <span className="text-xs text-brand">Open profile →</span>
    </span>
  );
}
