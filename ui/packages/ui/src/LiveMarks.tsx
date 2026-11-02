// The marks of lib/live's states, one look wherever they show: the list's rows, the call tree, the trace's pane. The
// widget draws the same in its own DOM (its pill and card, outside React): the ring and the hourglass, these words.
import { useEffect, useState } from "react";
import { clockOf, cutNote, NO_ANSWER, PENDING, runningLabel, runningTime, TICK_MS } from "./lib/live";
import { WaitingIcon } from "./primitives";

/** Now (ms), ticking every `ms` while `active`; still otherwise. */
export function useNow(active: boolean, ms: number = TICK_MS): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [active, ms]);
  return now;
}

/** In flight: a turning ring (still with reduced motion). */
export function RunningMark({ title }: { title?: string | undefined }) {
  return <span className="dt-running" role="img" aria-label="running" title={title} />;
}

/** A running thing's time so far, ticking, after its ring: "⟳ 3.2 s"; stopped at `until` (lib/live clockOf). */
export function Running({
  start,
  until,
  className,
}: {
  start: number;
  until?: number | undefined;
  className?: string | undefined;
}) {
  const now = clockOf(until, useNow(true));
  const label = runningLabel(start, now);
  return (
    <span className={className ? `dt-running-time ${className}` : "dt-running-time"} data-state="running" title={label}>
      <RunningMark title={label} />
      {runningTime(start, now)}
    </span>
  );
}

/** A call cut short, or a view that went out with one: the hourglass and "no answer yet". */
export function NoAnswer({ at, short = false }: { at: number | null; short?: boolean | undefined }) {
  return (
    <span className="dt-no-answer" data-state="cut" title={cutNote(at)}>
      <WaitingIcon />
      <span className="dt-no-answer-text">{short ? "no answer" : NO_ANSWER}</span>
    </span>
  );
}

/** A number not known yet. */
export function Pending({ what }: { what: string }) {
  return (
    <span className="dt-pending" data-state="pending" title={`${what}: not known yet`}>
      {PENDING}
    </span>
  );
}
