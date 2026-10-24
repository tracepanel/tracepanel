// A span's own time with no recorded calls: where its code ran while none of what it called was running. Plain
// data, no React: the call tree's "no recorded calls" rows and the time strip's hatched stretches draw from it, so
// both say the same time.
import type { Span, Trace } from "../types";

/** A span's quiet time: when (its gaps, in the trace's clock), and how long in all. */
export interface Quiet {
  gaps: [number, number][];
  total: number;
}

/** Said for a span whose own code ran at least this long, and this share of it, with no recorded calls. */
const QUIET_MIN_US = 5_000;
const QUIET_MIN_SHARE = 0.2;

/** Where a span ran with none of its calls running: from its start to its end, between and around them. */
function gapsIn(span: Span, calls: readonly Span[]): [number, number][] {
  const gaps: [number, number][] = [];
  let at = span.start;
  for (const call of [...calls].sort((a, b) => a.start - b.start)) {
    if (call.start > at) gaps.push([at, call.start]);
    at = Math.max(at, call.start + call.duration);
  }
  if (span.start + span.duration > at) gaps.push([at, span.start + span.duration]);
  return gaps;
}

/** A span's quiet time, when it made calls but ran long without them. */
function quietIn(span: Span, calls: readonly Span[]): Quiet | null {
  if (calls.length === 0) return null;
  const gaps = gapsIn(span, calls);
  const total = gaps.reduce((sum, [from, to]) => sum + to - from, 0);
  return total >= Math.max(QUIET_MIN_US, span.duration * QUIET_MIN_SHARE) ? { gaps, total } : null;
}

/** Each span of the trace whose own code ran long with no recorded calls, by its id. */
export function quietSpans(trace: Pick<Trace, "spans">): Map<string, Quiet> {
  const calls = callsOf(trace.spans);
  return new Map(
    trace.spans.flatMap((span): [string, Quiet][] => {
      const quiet = quietIn(span, calls.get(span.id) ?? []);
      return quiet ? [[span.id, quiet]] : [];
    }),
  );
}

/** The spans each span called, by its id. */
function callsOf(spans: readonly Span[]): Map<string, Span[]> {
  const calls = new Map<string, Span[]>();
  for (const span of spans) {
    if (span.parent_id !== null) calls.set(span.parent_id, [...(calls.get(span.parent_id) ?? []), span]);
  }
  return calls;
}
