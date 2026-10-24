// A trace's profile over a stretch of its code's own time, and the flame that leads to it from a code row.
import { FlameIcon } from "lucide-react";
import type { Profile } from "./lib/profile";
import type { TimeRange } from "./lib/slice";
import { timed, within } from "./lib/waiting";
import type { Trace } from "./types";

/** The profile of a stretch of the trace when it says when its samples were taken; the whole trace's otherwise. */
export function profileOver(trace: Trace, range: TimeRange | undefined): Profile | undefined {
  const profile = trace.profile;
  return range && timed(profile) ? within(profile, range) : profile;
}

/** A profile there: the flame as the panel's Profile toggle draws it when on, orange. */
const PROFILED = "text-orange-500 fill-orange-500/30";

/** After a code row's name, with a profile: its flame, orange as the panel's toggle when on (the row opens it). */
export function RowFlame({ trace }: { trace: Trace }) {
  if (!trace.profile) return null;
  return (
    <span className="dt-map-flame" data-on="">
      <FlameIcon className={PROFILED} aria-hidden="true" />
    </span>
  );
}
