// What ran in a trace's code where nothing it called was recorded: its profile's own functions (of that stretch when
// the profile says when its samples were taken, of the whole trace otherwise), what it waited on, or how to get a
// profile. The time strip's tooltip and the call tree's code rows say it alike.
import { FlameIcon } from "lucide-react";
import { useState } from "react";
import { duration } from "./format";
import { percent } from "./lib/percent";
import { ownHotspots, type Profile } from "./lib/profile";
import { rangeLabel, type TimeRange } from "./lib/slice";
import { timed, waitOf, within } from "./lib/waiting";
import { useProfilingOf } from "./Profiling";
import type { Trace } from "./types";

/** The profile of a stretch of the trace when it says when its samples were taken; the whole trace's otherwise. */
export function profileOver(
  trace: Trace,
  range: TimeRange | undefined,
): { profile: Profile | undefined; title: string } {
  const profile = trace.profile;
  if (range && timed(profile))
    return { profile: within(profile, range), title: `Profile of ${rangeLabel(range, trace.duration)}` };
  return { profile, title: "Profile of the whole trace" };
}

/**
 * What ran in the code's own time: the trace's profile, its own functions by where they were when sampled; without
 * one, how to get one, where the app profiles on request.
 */
export function WhatRan({ trace, range }: { trace: Trace; range?: TimeRange | undefined }) {
  const profiling = useProfilingOf(trace);
  const over = profileOver(trace, range);
  if (over.profile) return <Hotspots profile={over.profile} title={over.title} />;
  if (!profiling.available) return null;
  return (
    <span className="grid gap-0.5">
      <span className="flex items-center gap-1.5">
        <FlameIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        Turn on Profile to see what ran here
      </span>
      <span className="text-xs text-muted-foreground">
        {profiling.turnOn
          ? "Profile is in the legend below"
          : "with the panel's 🔥 or an X-Tracepanel-Profile: 1 header"}
      </span>
    </span>
  );
}

/** A profile there: the flame as the panel's Profile toggle draws it when on, orange. */
const PROFILED = "text-orange-500 fill-orange-500/30";

/** The way to the profile, as the panel's toggle draws it: its flame. */
function OpenProfile() {
  return (
    <span className="flex items-center gap-1 text-xs text-brand">
      <FlameIcon className={`size-3 ${PROFILED}`} aria-hidden="true" />
      Open the profile
    </span>
  );
}

/**
 * After a code row's name: the profile's flame (the row opens it), or, where the app profiles on request and the
 * trace has none, the flame dimmed, turning the panel's Profile on; nothing where the app can't profile.
 */
export function RowFlame({ trace }: { trace: Trace }) {
  const profiling = useProfilingOf(trace);
  if (trace.profile) {
    return (
      <span className="dt-map-flame" data-on="" title="Open the profile">
        <FlameIcon className={PROFILED} aria-label="Open the profile" />
      </span>
    );
  }
  return profiling.available ? <FlameOff turnOn={profiling.turnOn} /> : null;
}

/** The flame dimmed: Profile is off for this trace's app; in the panel a click turns it on. */
function FlameOff({ turnOn }: { turnOn: (() => void) | undefined }) {
  const [on, setOn] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: inside the row; in the panel a click turns its Profile on.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the legend's link is the keyboard's way.
    <span
      className="dt-map-flame"
      data-off=""
      title={on ? "Profile is on: run it again" : "Turn on Profile to see what ran here"}
      onClick={(event) => {
        if (!turnOn) return;
        event.stopPropagation();
        turnOn();
        setOn(true);
      }}
    >
      <FlameIcon aria-label={on ? "Profile is on: run it again" : "Turn on Profile to see what ran here"} />
    </span>
  );
}

/** The profile's own functions, each where your code was when sampled; a click opens it. */
function Hotspots({ profile, title }: { profile: Profile; title: string }) {
  return (
    <span className="grid gap-1">
      <span className="font-medium">{title}</span>
      <span className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5">
        {ownHotspots(profile).map(({ name, share }) => (
          <span key={name} className="contents">
            <span className="truncate font-mono text-xs">{name}</span>
            <span className="text-right text-xs text-muted-foreground tabular-nums">{percent(share, 1)}</span>
          </span>
        ))}
      </span>
      <OpenProfile />
    </span>
  );
}

/** What a stretch the code waited in waited on, and where: "await asyncio.sleep in build_sales_report · handlers.py:108". */
export function WhatWaited({ trace, range, waited }: { trace: Trace; range: TimeRange; waited: number }) {
  const over = profileOver(trace, range);
  const what = over.profile ? waitOf(over.profile) : null;
  return (
    <span className="grid gap-1">
      <span className="font-medium">Waiting · {duration(waited)}</span>
      {what ? <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{what}</span> : null}
      <OpenProfile />
    </span>
  );
}
