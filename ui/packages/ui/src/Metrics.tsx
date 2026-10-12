import { duration, percent } from "./format";
import type { Span, Trace } from "./types";

/** Calls the request made of one kind, when it made any: how many, and their time. */
function CallsMetric({ label, calls }: { label: string; calls: Span[] }) {
  if (calls.length === 0) return null;
  return (
    <div className="dt-metric">
      <span className="dt-metric-label">{label}</span>
      <span className="dt-metric-value">{calls.length}</span>
      <span className="dt-metric-sub">{duration(calls.reduce((sum, span) => sum + span.duration, 0))}</span>
    </div>
  );
}

/** The request at a glance: time split between the app and the database, queries, cache, outgoing calls. */
export function Metrics({ trace }: { trace: Trace }) {
  const sql = trace.spans.filter((span) => span.kind === "sql");
  const cache = trace.spans.filter((span) => span.kind === "cache");
  const calls = trace.spans.filter((span) => span.kind === "http.client");
  const redis = trace.spans.filter((span) => span.kind === "redis");
  const hits = cache.filter((span) => span.attrs["cache.hit"] === true).length;
  const gets = cache.filter((span) => span.attrs["cache.op"] === "get").length;
  const db = sql.reduce((sum, span) => sum + span.duration, 0);
  const byAlias = new Map<string, number>();
  for (const span of sql) {
    const alias = String(span.attrs["db.alias"] ?? "default");
    byAlias.set(alias, (byAlias.get(alias) ?? 0) + span.duration);
  }
  const total = Math.max(trace.duration, 1);

  return (
    <div className="dt-metrics">
      <div className="dt-metric">
        <span className="dt-metric-label">Duration</span>
        <span className="dt-metric-value">{duration(trace.duration)}</span>
        <span className="dt-split" role="img" aria-label={`Database ${percent(db, total)} of the request`}>
          <span className="dt-split-db" style={{ width: percent(db, total) }} />
        </span>
      </div>
      <div className="dt-metric">
        <span className="dt-metric-label">Database</span>
        <span className="dt-metric-value">{duration(db)}</span>
        <span className="dt-metric-sub">
          {byAlias.size > 1
            ? [...byAlias].map(([alias, time]) => `${alias} ${duration(time)}`).join(" · ")
            : `${percent(db, total)} of time`}
        </span>
      </div>
      <div className="dt-metric">
        <span className="dt-metric-label">Queries</span>
        <span className="dt-metric-value">{sql.length}</span>
        <span className="dt-metric-sub">{new Set(sql.map((span) => span.attrs["db.fingerprint"])).size} unique</span>
      </div>
      <div className="dt-metric">
        <span className="dt-metric-label">Cache</span>
        <span className="dt-metric-value">{cache.length}</span>
        <span className="dt-metric-sub">{gets > 0 ? `${hits}/${gets} hits` : "calls"}</span>
      </div>
      <CallsMetric label="Redis" calls={redis} />
      <CallsMetric label="HTTP calls" calls={calls} />
    </div>
  );
}
