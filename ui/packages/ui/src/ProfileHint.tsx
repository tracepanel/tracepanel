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

/**
 * After a row's name, with a profile: its flame, orange as the panel's toggle when on. A code row opens the profile
 * itself (the whole row is the button); a call's trace from another app opens its own with a click on the flame
 * (`onOpen`), the row's click being the row's.
 */
export function RowFlame({ trace, onOpen }: { trace: Trace; onOpen?: (() => void) | undefined }) {
  if (!trace.profile) return null;
  const icon = <FlameIcon className={PROFILED} aria-hidden="true" />;
  if (!onOpen) {
    return (
      <span className="dt-map-flame" data-on="">
        {icon}
      </span>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: inside the row's button; a click here opens the profile.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row's details have the same way there, a link.
    <span
      className="dt-map-flame dt-map-flame-open"
      data-on=""
      role="button"
      tabIndex={-1}
      aria-label="Open its profile"
      title="Open its profile"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {icon}
    </span>
  );
}
