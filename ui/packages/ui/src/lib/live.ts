// One model of where a request, a view or a call is, said the same way in the pill, its card, the panel's list and
// the call tree (one entity, one look):
// - running: in flight (a request the page waits for, a view still open). A turning ring and its time so far,
//   ticking; no status, its numbers pending.
// - done: its status, its time, its numbers.
// - failed: as done, in red (an answer of 5xx, or none: a connection error, a timeout).
// - no answer yet: a call cut short (its view's trace went out before it answered, after the longest wait). The
//   hourglass and "no answer yet", its time neutral, never red: it isn't slow, it hasn't ended.
// Numbers not known yet (a row's chain not loaded, a request still running) say PENDING, never a definite 0.

import { duration } from "../format";
import type { Chain, Span, Trace } from "../types";
import { answers, unfinished } from "./callAnswer";

/** In place of a number not known yet. */
export const PENDING = "…";

/** What a call cut short says, wherever it shows. */
export const NO_ANSWER = "no answer yet";

/** How often a running time ticks on screen (ms): tenths of a second, as `duration` writes them. */
export const TICK_MS = 100;

/** A running thing's time so far (µs), from its start (epoch µs). */
export function elapsed(start: number, now: number = Date.now()): number {
  return Math.max(0, now * 1000 - start);
}

/** Under this (µs), a running thing's time so far says PENDING: its first frame, never "0 µs". */
const FIRST_FRAME_US = 100;

/**
 * A running thing's time so far, as its ring shows it: PENDING until it has run a tenth of a millisecond (a view's
 * first frame, or a start a moment ahead of this clock), its time from its start after that. Never "0 µs".
 */
export function runningTime(start: number, now: number = Date.now()): string {
  const us = elapsed(start, now);
  return us < FIRST_FRAME_US ? PENDING : duration(us);
}

/** "Running for 3.2 s": a running thing's time so far, in words; "running" before it has one. */
export function runningLabel(start: number, now: number = Date.now()): string {
  const time = runningTime(start, now);
  return time === PENDING ? "running" : `running for ${time}`;
}

/** Whether a call was cut short: its trace went out before it answered (see `unfinished`). */
export function isCut(span: Span): boolean {
  return answers(span) && unfinished(span);
}

/**
 * Where a trace was cut, when it was: the end of its trace (µs since its start), for a trace that went out with a
 * call of its own still waiting for its answer. Null for a trace whose calls all ended, or whose cut calls another
 * app's trace answered since (`answered`: the ids of its spans a trace of the chain served).
 */
export function cutAt(
  trace: Pick<Trace, "spans" | "duration">,
  answered: ReadonlySet<string> = new Set(),
): number | null {
  return trace.spans.some((span) => isCut(span) && !answered.has(span.id)) ? trace.duration : null;
}

/** A chain's first trace's calls another trace of it served: by its span ids. */
export function answeredIn(chain: Pick<Chain, "traces">): ReadonlySet<string> {
  const first = chain.traces[0]?.id;
  return new Set(chain.traces.flatMap((each) => (each.parent === first && each.via !== null ? [each.via] : [])));
}

/** Where a chain's first trace was cut with a call no trace of the chain answered (see cutAt). */
export function chainCutAt(chain: Pick<Chain, "traces">): number | null {
  const own = chain.traces[0]?.trace;
  return own ? cutAt(own, answeredIn(chain)) : null;
}

/** What a call or a view cut short says in its tooltip: where it was cut, what that means. */
export function cutNote(at: number | null): string {
  const when = at === null ? "" : ` at ${duration(at)}`;
  return `No answer yet: cut${when}, as the view's trace went out before the call answered (a route change, or the longest wait). Not slow: it hadn't ended. Its answer, if it comes, is the trace of the app that served it.`;
}
