import { type CallsSummary, type DataSource, duration, percent, Stat, StatGrid } from "@tracepanel/ui";
import { useCallback } from "react";
import { useSearch } from "./data";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What a tile says under its number, when there is something to say. */
function when<T>(value: T | null | undefined, text: (value: T) => string): string | undefined {
  return value ? text(value) : undefined;
}

/** A cache's gets that hit; nothing for other systems (null hits and misses), or a cache with no gets. */
function HitRate({ summary }: { summary: CallsSummary }) {
  const hits = summary.hits ?? 0;
  const gets = hits + (summary.misses ?? 0);
  return gets ? (
    <Stat label="Hit rate" value={percent(hits, gets)} sub={`${hits} of ${plural(gets, "get", "gets")}`} />
  ) : null;
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
      <HitRate summary={summary} />
    </StatGrid>
  );
}

/** The tiles above a system's page, loaded with its search; none while it has no calls. */
export function SystemTiles({
  system,
  q,
  source,
  onFailed,
}: {
  system: string;
  q: string;
  source: DataSource;
  onFailed: () => void;
}) {
  const summary = useSearch(
    useCallback((query: string) => source.callsSummary(system, query), [source, system]),
    q,
    0,
  );
  return summary.data?.calls ? <CallsTiles summary={summary.data} onFailed={onFailed} /> : null;
}
