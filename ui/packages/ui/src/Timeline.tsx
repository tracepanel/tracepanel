import { type CSSProperties, type MouseEvent, type PointerEvent, type RefObject, useRef } from "react";
import { duration } from "./format";
import { keyed } from "./keys";
import { overlaps, type TimeRange } from "./lib/slice";
import { DATASTORES, MESSAGING, RPC } from "./lib/systems";
import { RangeBand, useHeldSlice, useRangeDrag } from "./TimeSlice";
import type { Trace } from "./types";

/** Where a mark leads: the span in the call tree (or the tree itself), the logs, the error. */
export type MarkTarget = { tab: "tree"; span?: string } | { tab: "logs" } | { tab: "error" };

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
  // A failed span is red; so is the trace's own when the trace failed (its error is an issue on it, not amber).
  const failed = (span: Trace["spans"][number]) =>
    span.status === "error" || (span.parent_id === null && trace.status === "error");
  const spans = (...kinds: readonly string[]): Mark[] =>
    trace.spans
      .filter((span) => kinds.includes(span.kind))
      .map((span) => ({
        key: span.id,
        start: span.start,
        duration: span.duration,
        label: `${span.name} · ${duration(span.duration)}`,
        tone: failed(span) ? "error" : flagged.has(span.id) ? "warn" : "neutral",
        target: { tab: "tree", span: span.id },
      }));
  const result: Lane[] = [
    { label: LANE_WORDS[trace.kind] ?? trace.kind, marks: spans(trace.kind) },
    { label: "sql", marks: spans("sql") },
    { label: "redis", marks: spans("redis") },
    { label: "cache", marks: spans("cache") },
    { label: "datastores", marks: spans(...DATASTORES) },
    { label: "messaging", marks: spans(...MESSAGING) },
    { label: "http", marks: spans("http.client") },
    { label: "rpc", marks: spans(...RPC) },
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

/** The trace's own lane, named as what it is: a request, a task, a job, a WebSocket, a page. */
const LANE_WORDS: Record<string, string> = {
  http: "request",
  task: "task",
  command: "job",
  websocket: "websocket",
  page: "page",
  rpc: "call",
};

/** Where a mark sits on its lane. */
function position(mark: Mark, trace: Trace, total: number): CSSProperties {
  return {
    left: `${Math.min(Math.max(((mark.start - trace.start) / total) * 100, 0), 100)}%`,
    width: mark.duration === 0 ? undefined : `${Math.min((mark.duration / total) * 100, 100)}%`,
  };
}

/** Set on a mark outside the picked range: it steps back. */
function outside(mark: Mark, trace: Trace, range: TimeRange | null): "" | undefined {
  return range && !overlaps(range, mark.start - trace.start, mark.duration) ? "" : undefined;
}

/** One lane: its name, how many marks, and the marks over the trace's time; those outside a picked range fade. */
function LaneRow({
  lane,
  trace,
  range,
  onSelect,
}: {
  lane: Lane;
  trace: Trace;
  range: TimeRange | null;
  onSelect: ((target: MarkTarget) => void) | undefined;
}) {
  const total = Math.max(trace.duration, 1);
  return (
    <div className="dt-lane">
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
            data-out={outside(mark, trace, range)}
            style={position(mark, trace, total)}
            title={mark.target.tab === "tree" ? `${mark.label} · open in the call tree` : mark.label}
            aria-label={mark.label}
            onClick={() => onSelect?.(mark.target)}
          />
        ))}
      </div>
    </div>
  );
}

/** What picks a stretch of the time on the lanes: the drag, and where the range goes. */
interface Picking {
  onRange: (range: TimeRange | null) => void;
  start: (event: PointerEvent<HTMLDivElement>, track: Element) => void;
  layer: RefObject<HTMLDivElement | null>;
}

/** A press on a lane or the axis may start a drag across them (on a mark too: it stays a click unless it moves). */
function pressOnLanes(event: PointerEvent<HTMLDivElement>, picking: Picking): void {
  const onTrack = (event.target as Element).closest(".dt-lane-track, .dt-timeline-axis");
  if (onTrack && picking.layer.current) picking.start(event, picking.layer.current);
}

/** A click on a lane beside its marks: the range goes. */
function clickOnLanes(event: MouseEvent<HTMLDivElement>, picking: Picking): void {
  if ((event.target as Element).classList.contains("dt-lane-track")) picking.onRange(null);
}

/** The axis and the lanes, and over them the range picked (or being picked). */
function LanesBody({
  trace,
  drawn,
  range,
  picking,
  onSelect,
}: {
  trace: Trace;
  drawn: Lane[];
  range: TimeRange | null;
  picking: Picking;
  onSelect: ((target: MarkTarget) => void) | undefined;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drag over the marks, which are buttons of their own.
    // biome-ignore lint/a11y/useKeyWithClickEvents: from the keyboard, Esc lets the range go (useSlice).
    <div
      className="dt-timeline-body"
      onPointerDown={(event) => pressOnLanes(event, picking)}
      onClick={(event) => clickOnLanes(event, picking)}
      onDoubleClick={() => picking.onRange(null)}
    >
      <div className="dt-timeline-axis" aria-hidden="true">
        {TICKS.map((tick) => (
          <span key={tick} style={{ left: `${tick * 100}%` }}>
            {tick === 0 ? "0" : duration(trace.duration * tick)}
          </span>
        ))}
      </div>
      {drawn.map((lane) => (
        <LaneRow key={lane.label} lane={lane} trace={trace} range={range} onSelect={onSelect} />
      ))}
      <div className="dt-timeline-layer" ref={picking.layer}>
        {range ? <RangeBand range={range} total={Math.max(trace.duration, 1)} /> : null}
      </div>
    </div>
  );
}

/** The range of the trace's view around; one picked on the lanes is the call tree's to show, which opens with it. */
function useLanesRange(onSelect: ((target: MarkTarget) => void) | undefined) {
  const { slice, change } = useHeldSlice();
  const onRange = (range: TimeRange | null) => {
    change({ ...slice, range });
    if (range) onSelect?.({ tab: "tree" });
  };
  return { range: slice.range, onRange };
}

/**
 * The trace's lanes over its time; a mark (an N+1 burst in amber, an error in red) opens what it is. A drag across
 * the lanes picks a stretch of the time (`onRange`); a click beside the marks, or a double click, lets it go.
 */
export function Timeline({ trace, onSelect }: { trace: Trace; onSelect?: (target: MarkTarget) => void }) {
  const drawn = lanes(trace);
  const layer = useRef<HTMLDivElement>(null);
  const { range, onRange } = useLanesRange(onSelect);
  const drag = useRangeDrag(Math.max(trace.duration, 1), onRange);
  // The trace's own lane alone is one bar from 0 to its duration, which its header says: no lanes then. With others
  // it stays, their reference.
  if (drawn.length < 2) return null;
  const shown = drag.draft ?? range;
  return (
    <figure className="dt-timeline" aria-label="Timeline">
      <LanesBody
        trace={trace}
        drawn={drawn}
        range={shown}
        picking={{ onRange, start: drag.start, layer }}
        onSelect={onSelect}
      />
    </figure>
  );
}
