// What ran in a trace's code where nothing it called was recorded: its profile's own functions (of that stretch when
// the profile says when its samples were taken, of the whole trace otherwise), what it waited on, or how to get a
// profile. The time strip's tooltip and the call tree's code rows say it alike.
import { FlameIcon } from "lucide-react";
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
  if (range && timed(profile)) return { profile: within(profile, range), title: `Profile of ${rangeLabel(range)}` };
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

const TURN_ON = "Turn on Profile in the panel to see what ran here";

/**
 * The last line of a tooltip of the code's own time: with a profile, the way to it; without, how to get one, where
 * the app can profile. Profile is turned on in the panel's toolbar only, never from the trace.
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

/** No profile, where the app can profile: one quiet line on how to get one. Nothing to click here. */
function TurnOnAction({ trace }: { trace: Trace }) {
  const profiling = useProfilingOf(trace);
  if (!profiling.available) return null;
  return <span className="text-xs text-muted-foreground">{TURN_ON}</span>;
}

/** After a code row's name, with a profile: its flame, orange as the panel's toggle when on (the row opens it). */
export function RowFlame({ trace }: { trace: Trace }) {
  if (!trace.profile) return null;
  return (
    <span className="dt-map-flame" data-on="">
      <FlameIcon className={PROFILED} aria-hidden="true" />
    </span>
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
