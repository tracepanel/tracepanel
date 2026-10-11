import { duration } from "./format";
import { keyed } from "./keys";
import type { Trace } from "./types";

/** Where a mark leads: the span in the call tree, the logs, the error. */
export type MarkTarget = { tab: "tree"; span: string } | { tab: "logs" } | { tab: "error" };

interface Mark {
  key: string;
  start: number;
  duration: number;
  label: string;
  tone: "neutral" | "warn" | "error" | "info";
  target: MarkTarget;
}

interface Lane {
  label: string;
  marks: Mark[];
}

function lanes(trace: Trace): Lane[] {
  const flagged = new Set(trace.issues.flatMap((issue) => issue.span_ids));
  const spans = (kind: string): Mark[] =>
    trace.spans
      .filter((span) => span.kind === kind)
      .map((span) => ({
        key: span.id,
        start: span.start,
        duration: span.duration,
        label: `${span.name} · ${duration(span.duration)}`,
        tone: span.status === "error" ? "error" : flagged.has(span.id) ? "warn" : "neutral",
        target: { tab: "tree", span: span.id },
      }));
  const result: Lane[] = [
    { label: "request", marks: spans(trace.kind) },
    { label: "sql", marks: spans("sql") },
    { label: "cache", marks: spans("cache") },
    {
      label: "logs",
      marks: keyed(trace.logs, (log) => `log:${log.time}:${log.message}`).map(({ key, item: log }) => ({
        key,
        start: log.time,
        duration: 0,
        label: `${log.level}: ${log.message}`,
        tone: log.level === "error" || log.level === "critical" ? "error" : log.level === "warning" ? "warn" : "info",
        target: { tab: "logs" },
      })),
    },
    {
      label: "errors",
      marks: keyed(trace.errors, (error) => `error:${error.time}:${error.type}`).map(({ key, item: error }) => ({
        key,
        start: error.time,
        duration: 0,
        label: `${error.type}: ${error.message}`,
        tone: "error",
        target: { tab: "error" },
      })),
    },
  ];
  return result.filter((lane) => lane.marks.length > 0);
}

const TICKS = [0, 0.25, 0.5, 0.75, 1];

/** The trace's lanes over its time; a mark (an N+1 burst in amber, an error in red) opens what it is. */
export function Timeline({ trace, onSelect }: { trace: Trace; onSelect?: (target: MarkTarget) => void }) {
  const total = Math.max(trace.duration, 1);
  const position = (mark: Mark) => ({
    left: `${Math.min(Math.max(((mark.start - trace.start) / total) * 100, 0), 100)}%`,
    width: mark.duration === 0 ? undefined : `${Math.min((mark.duration / total) * 100, 100)}%`,
  });
  return (
    <figure className="dt-timeline" aria-label="Timeline">
      <div className="dt-timeline-axis" aria-hidden="true">
        {TICKS.map((tick) => (
          <span key={tick} style={{ left: `${tick * 100}%` }}>
            {tick === 0 ? "0" : duration(trace.duration * tick)}
          </span>
        ))}
      </div>
      {lanes(trace).map((lane) => (
        <div key={lane.label} className="dt-lane">
          <span className="dt-lane-label">
            {lane.label}
            <span className="dt-lane-count">{lane.marks.length}</span>
          </span>
          <div className="dt-lane-track">
            {TICKS.slice(1, -1).map((tick) => (
              <span key={tick} className="dt-lane-grid" style={{ left: `${tick * 100}%` }} />
            ))}
            {lane.marks.map((mark) => (
              <button
                type="button"
                key={mark.key}
                className="dt-mark"
                data-tone={mark.tone}
                data-point={mark.duration === 0 ? "" : undefined}
                style={position(mark)}
                title={mark.target.tab === "tree" ? `${mark.label} · open in the call tree` : mark.label}
                aria-label={mark.label}
                onClick={() => onSelect?.(mark.target)}
              />
            ))}
          </div>
        </div>
      ))}
    </figure>
  );
}
