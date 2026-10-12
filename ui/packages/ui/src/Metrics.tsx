import { type SystemCalls, systemCalls } from "./CallsTab";
import { duration, percent } from "./format";
import type { Span, Trace } from "./types";

/** What a system's tile adds under its time: SQL's unique statements, a cache's hits. */
const DETAILS: Record<string, (spans: Span[]) => string | null> = {
  sql: (spans) => `${new Set(spans.map((span) => span.attrs["db.fingerprint"])).size} unique`,
  cache: (spans) => {
    const gets = spans.filter((span) => span.attrs["cache.op"] === "get");
    const hits = gets.filter((span) => span.attrs["cache.hit"] === true).length;
    return gets.length > 0 ? `${hits}/${gets.length} hits` : null;
  },
};

/** One system the request called: how many calls, their time, and what the system adds. */
function SystemMetric({ calls }: { calls: SystemCalls }) {
  const detail = DETAILS[calls.key]?.(calls.spans);
  return (
    <div className="dt-metric">
      <span className="dt-metric-label">{calls.label}</span>
      <span className="dt-metric-value">{calls.spans.length}</span>
      <span className="dt-metric-sub">{[duration(calls.total), detail].filter(Boolean).join(" · ")}</span>
    </div>
  );
}

/**
 * The request at a glance: how long it took and how much of that went to calls, then one tile per system it called
 * (the database, Redis, a cache, MongoDB, HTTP…), each the same: calls, time, and what that system adds.
 */
export function Metrics({ trace }: { trace: Trace }) {
  const systems = systemCalls(trace);
  const called = systems.reduce((sum, each) => sum + each.total, 0);
  const total = Math.max(trace.duration, 1);
  return (
    <div className="dt-metrics">
      <div className="dt-metric">
        <span className="dt-metric-label">Duration</span>
        <span className="dt-metric-value">{duration(trace.duration)}</span>
        <span className="dt-split" role="img" aria-label={`Calls ${percent(called, total)} of the request`}>
          <span className="dt-split-db" style={{ width: percent(Math.min(called, total), total) }} />
        </span>
      </div>
      {systems.map((calls) => (
        <SystemMetric key={calls.key} calls={calls} />
      ))}
    </div>
  );
}
