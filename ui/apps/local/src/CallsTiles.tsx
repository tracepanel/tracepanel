import { type CallsSummary, type DataSource, duration, percent, plural, Stat, StatGrid } from "@tracepanel/ui";
import { type ReactNode, useCallback } from "react";
import { useSearch } from "./data";

/** What a tile says under its number, when there is something to say. */
function when<T>(value: T | null | undefined, text: (value: T) => string): string | undefined {
  return value ? text(value) : undefined;
}

/**
 * A cache's gets that hit; nothing for other systems (null hits and misses), or a cache with no gets. A tile or
 * nothing, decided here: the grid sizes its columns by the tiles it is given, and an empty one would take a column.
 */
function hitRate(summary: CallsSummary): ReactNode {
  const hits = summary.hits ?? 0;
  const gets = hits + (summary.misses ?? 0);
  if (!gets) return null;
  return <Stat label="Hit rate" value={percent(hits, gets)} sub={`${hits} of ${plural(gets, "get", "gets")}`} />;
}

/** The calls that failed; with any, a click shows only them. */
function Failed({ errors, calls, onFailed }: { errors: number; calls: number; onFailed: () => void }) {
  const failed = errors > 0;
  return (
    <Stat
      label="Failed"
      value={percent(errors, Math.max(calls, 1))}
      sub={`${errors} of ${calls}`}
      tone={failed ? "error" : undefined}
      onClick={failed ? onFailed : undefined}
    />
  );
}

/**
 * A system's calls at a glance, over all of them and with the page's filters: how many, their time, how many per
 * request (a high count is an N+1's sign), how many failed (a click shows them), and a cache's hit rate.
 */
function CallsTiles({ summary, onFailed }: { summary: CallsSummary; onFailed: () => void }) {
  const { calls, traces, errors } = summary;
  return (
    <StatGrid label="Summary" className="mb-5">
      <Stat label="Calls" value={String(calls)} sub={`in ${plural(traces, "request", "requests")}`} />
      <Stat
        label="Time"
        value={duration(summary.total)}
        sub={when(summary.p95, (p95) => `p95 ${duration(p95)} a call`)}
      />
      <Stat
        label="Per request"
        value={(calls / Math.max(traces, 1)).toFixed(1)}
        sub={when(summary.most_per_trace, (most) => `up to ${most} in one`)}
      />
      <Failed errors={errors} calls={calls} onFailed={onFailed} />
      {hitRate(summary)}
    </StatGrid>
  );
}

/** A system's calls summed up with the page's search; none off a system's page. */
export function useCallsSummary(source: DataSource, system: string | null, q: string) {
  return useSearch(
    useCallback(
      (query: string) => (system ? source.callsSummary(system, query) : Promise.resolve(null)),
      [source, system],
    ),
    q,
    0,
  );
}

/** The tiles above a system's page, with its search; none while it has no calls. */
export function SystemTiles({ summary, onFailed }: { summary: CallsSummary | null | undefined; onFailed: () => void }) {
  return summary?.calls ? <CallsTiles summary={summary} onFailed={onFailed} /> : null;
}
