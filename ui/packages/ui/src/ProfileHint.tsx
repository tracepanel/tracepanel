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
 * What ran in the code's own time: the trace's profile, its own functions by where they were when sampled, and the
 * way to it (`onOpen`); without one, how to get one, where the app profiles on request.
 */
export function WhatRan({
  trace,
  range,
  onOpen,
}: {
  trace: Trace;
  range?: TimeRange | undefined;
  onOpen?: (() => void) | undefined;
}) {
  const over = profileOver(trace, range);
  return (
    <>
      {over.profile ? <Hotspots profile={over.profile} title={over.title} /> : null}
      <ProfileAction trace={trace} onOpen={onOpen} />
    </>
  );
}

/** A profile there: the flame as the panel's Profile toggle draws it when on, orange. */
const PROFILED = "text-orange-500 fill-orange-500/30";

/** The traces whose Profile was turned on from here, this page's life: each says so until it is run again. */
const turnedOn = new Set<string>();

/** Profile turned on for this trace's app from here: whether it was, and how. */
function useTurnOn(trace: Trace): { on: boolean; turnOn: (() => void) | undefined } {
  const profiling = useProfilingOf(trace);
  const [, redraw] = useState(0);
  const turnOn = profiling.turnOn;
  return {
    on: turnedOn.has(trace.id),
    turnOn: turnOn
      ? () => {
          turnOn();
          turnedOn.add(trace.id);
          redraw((count) => count + 1);
        }
      : undefined,
  };
}

const TURN_ON = "Turn on Profile to see what ran here";
const TURNED_ON = "Profile is on: run it again";

/**
 * The way on from a tooltip of the code's own time, its last line: the profile opened, with one; without, Profile
 * turned on (the panel), or how to (the console); nothing where the app can't profile.
 */
function ProfileAction({ trace, onOpen }: { trace: Trace; onOpen: (() => void) | undefined }) {
  if (trace.profile) {
    return onOpen ? (
      <button type="button" className="dt-tip-action" onClick={onOpen}>
        <FlameIcon className={PROFILED} aria-hidden="true" />
        Open the profile
      </button>
    ) : null;
  }
  return <TurnOnAction trace={trace} />;
}

/** No profile: Profile turned on from here (the panel), or how to turn it on (the console), where the app can. */
function TurnOnAction({ trace }: { trace: Trace }) {
  const profiling = useProfilingOf(trace);
  const { on, turnOn } = useTurnOn(trace);
  if (!profiling.available) return null;
  if (turnOn) {
    return (
      <button type="button" className="dt-tip-action" disabled={on} onClick={turnOn}>
        <FlameIcon aria-hidden="true" />
        {on ? TURNED_ON : TURN_ON}
      </button>
    );
  }
  return (
    <span className="grid gap-0.5">
      <span className="flex items-center gap-1.5">
        <FlameIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        {TURN_ON}
      </span>
      <span className="text-xs text-muted-foreground">with the panel's 🔥 or an X-Tracepanel-Profile: 1 header</span>
    </span>
  );
}

/**
 * After a code row's name: the profile's flame (the row opens it), or, where the app profiles on request and the
 * trace has none, the flame dimmed, a button in the panel that turns its Profile on. What each does is the row's
 * tooltip's to say: no title of their own.
 */
export function RowFlame({ trace }: { trace: Trace }) {
  const profiling = useProfilingOf(trace);
  if (trace.profile) {
    return (
      <span className="dt-map-flame" data-on="">
        <FlameIcon className={PROFILED} aria-hidden="true" />
      </span>
    );
  }
  if (!profiling.available) return null;
  return profiling.turnOn ? (
    <FlameOff trace={trace} />
  ) : (
    <span className="dt-map-flame" data-off="">
      <FlameIcon aria-hidden="true" />
    </span>
  );
}

/** The flame dimmed, in the panel: a click turns its Profile on (the row is no button then: it opens nothing). */
function FlameOff({ trace }: { trace: Trace }) {
  const { on, turnOn } = useTurnOn(trace);
  return (
    <button
      type="button"
      className="dt-map-flame"
      data-off=""
      aria-label={on ? TURNED_ON : TURN_ON}
      disabled={on}
      onClick={(event) => {
        event.stopPropagation();
        turnOn?.();
      }}
    >
      <FlameIcon aria-hidden="true" />
    </button>
  );
}

/** The profile's own functions, each where your code was when sampled. */
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
    </span>
  );
}

/** What a stretch the code waited in waited on, and where: "await asyncio.sleep in build_sales_report · handlers.py:108". */
export function WhatWaited({
  trace,
  range,
  waited,
  onOpen,
}: {
  trace: Trace;
  range: TimeRange;
  waited: number;
  onOpen?: (() => void) | undefined;
}) {
  const over = profileOver(trace, range);
  const what = over.profile ? waitOf(over.profile) : null;
  return (
    <span className="grid gap-1">
      <span className="font-medium">Waiting · {duration(waited)}</span>
      {what ? <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{what}</span> : null}
      <ProfileAction trace={trace} onOpen={onOpen} />
    </span>
  );
}
