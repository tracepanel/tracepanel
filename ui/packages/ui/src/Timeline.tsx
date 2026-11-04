import {
  type CSSProperties,
  type HTMLAttributes,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useRef,
} from "react";
import { partOfCategory } from "./callTree";
import { duration } from "./format";
import { keyed } from "./keys";
import { withoutAnsi } from "./lib/ansi";
import { type Category, spanCategories } from "./lib/breakdown";
import { answers, callAnswer, cutLength } from "./lib/callAnswer";
import { GC } from "./lib/memory";
import type { Profile } from "./lib/profile";
import { isShown, overlaps, type Slice, type TimeRange, togglePart } from "./lib/slice";
import { DATASTORES, MESSAGING, RPC } from "./lib/systems";
import { timed } from "./lib/waiting";
import { litKey, litScope } from "./lit";
import { rangeIn, TimeLane } from "./TimeLane";
import { TimeLegend } from "./TimeLegend";
import { RangeBand, useHeldSlice, useRangeDrag } from "./TimeSlice";
import type { Related, Span, Trace } from "./types";

/** Where a mark leads: the span in the call tree (or the tree itself), the logs, the error, the profile. */
export type MarkTarget = { tab: "tree"; span?: string } | { tab: "logs" } | { tab: "error" } | { tab: "profile" };

interface Mark {
  key: string;
  start: number;
  duration: number;
  label: string;
  tone: "neutral" | "warn" | "error" | "info";
  target: MarkTarget;
  /** A call's share of the time (its legend item's): hovering one lights the other. */
  category?: string | undefined;
  /** A call that hadn't ended when its trace went out: drawn to where it was cut, fading out there. */
  cut?: boolean | undefined;
}

interface Lane {
  noun: Noun;
  marks: Mark[];
  /** Shown with no mark that says anything more than the trace lane's colour. */
  always: boolean;
}

/** What a lane's marks are, one and many: "1 query", "139 queries". */
type Noun = readonly [string, string];

/**
 * A lane of calls: what they are called, and their kinds. A store's calls are the trace lane's colour already: their
 * lane shows only when one of them has something to say (an issue, an error). Messages (tasks sent), HTTP and RPC
 * calls lead to other traces, and LLM calls are what the time went to: theirs always shows.
 */
const CALL_LANES: readonly { noun: Noun; kinds: readonly string[]; always: boolean }[] = [
  { noun: ["query", "queries"], kinds: ["sql"], always: false },
  { noun: ["Redis command", "Redis commands"], kinds: ["redis"], always: false },
  { noun: ["cache call", "cache calls"], kinds: ["cache"], always: false },
  { noun: ["datastore call", "datastore calls"], kinds: DATASTORES, always: false },
  { noun: ["storage call", "storage calls"], kinds: ["storage"], always: false },
  { noun: ["LLM call", "LLM calls"], kinds: ["llm"], always: true },
  { noun: ["message", "messages"], kinds: MESSAGING, always: true },
  { noun: ["HTTP call", "HTTP calls"], kinds: ["http.client"], always: true },
  { noun: ["RPC call", "RPC calls"], kinds: RPC, always: true },
];

/**
 * A span's tone on its lane: red when it failed (the trace's own too when the trace did), amber with an issue or, a
 * call out, answered 4xx: as its row in the call tree says it (see callAnswer).
 */
function toneOf(span: Span, trace: Trace, flagged: ReadonlySet<string>): Mark["tone"] {
  const answer = answers(span) ? callAnswer(span).tone : undefined;
  if (answer === "error" || failed(span, trace)) return "error";
  return answer === "warn" || flagged.has(span.id) ? "warn" : "neutral";
}

/** Said on a cut call's mark, in place of a time it doesn't have. */
const CUT_LABEL = "hadn't ended when the trace went out";

/**
 * A call's mark. One cut short (its trace went out before it ended, see `unfinished`) has no time of its own (0 µs,
 * or until it was cut): it runs to the trace's end, where it was cut, never a 0-width mark.
 */
function callMark(span: Span, trace: Trace, flagged: ReadonlySet<string>, category: string | undefined): Mark {
  const length = cutLength(span, trace);
  const cut = length !== null;
  return {
    key: span.id,
    start: span.start,
    duration: length ?? span.duration,
    label: `${span.name} · ${cut ? CUT_LABEL : duration(span.duration)}`,
    tone: toneOf(span, trace, flagged),
    target: { tab: "tree", span: span.id },
    category,
    cut,
  };
}

function failed(span: Span, trace: Trace): boolean {
  return span.status === "error" || (span.parent_id === null && trace.status === "error");
}

function callLanes(trace: Trace): Lane[] {
  const flagged = new Set(trace.issues.flatMap((issue) => issue.span_ids));
  const categories = spanCategories(trace);
  return CALL_LANES.map(({ noun, kinds, always }) => ({
    noun,
    always,
    marks: trace.spans
      .filter((span) => kinds.includes(span.kind))
      .map((span) => callMark(span, trace, flagged, categories.get(span.id))),
  }));
}

function logTone(level: string): Mark["tone"] {
  if (level === "error" || level === "critical") return "error";
  return level === "warning" ? "warn" : "info";
}

/** The lanes of what happened at a point: log records (warnings and worse, unless every one shows), errors. */
function pointLanes(trace: Trace, allLogs: boolean): Lane[] {
  const shown = allLogs ? trace.logs : trace.logs.filter(isShown);
  const logs = keyed(shown, (log) => `log:${log.time}:${log.message}`).map(({ key, item: log }) => ({
    key,
    start: log.time,
    duration: 0,
    label: `${log.level}: ${withoutAnsi(log.message)}`,
    tone: logTone(log.level),
    target: { tab: "logs" } as const,
  }));
  const errors = keyed(trace.errors, (error) => `error:${error.time}:${error.type}`).map(({ key, item: error }) => ({
    key,
    start: error.time,
    duration: 0,
    label: `${error.type}: ${error.message}`,
    tone: "error" as const,
    target: { tab: "error" } as const,
  }));
  return [
    { noun: ["log record", "log records"], marks: logs, always: true },
    { noun: ["error", "errors"], marks: errors, always: true },
  ];
}

/** The lanes under the trace's own: its calls, system by system, then its logs and errors; those that say more. */
function lanes(trace: Trace, allLogs: boolean): Lane[] {
  return [...callLanes(trace), ...pointLanes(trace, allLogs)].filter(saysMore);
}

/** A lane worth its line: marks, and, for a store's calls, one flagged (the rest the trace lane shows in colour). */
function saysMore(lane: Lane): boolean {
  return lane.marks.length > 0 && (lane.always || lane.marks.some((mark) => mark.tone !== "neutral"));
}

/** A tick of the time axis: where it is (a share of the trace's time) and what it says. */
interface Tick {
  at: number;
  label: string;
}

/** The round steps an axis counts in, of a power of ten. */
const STEPS = [1, 2, 2.5, 5, 10];

/** At least this many steps across the axis: 3 to 6 of them, whatever the time. */
const MIN_STEPS = 3;

/**
 * The time axis' ticks: from 0 by the largest round step (1, 2, 2.5 or 5 of a power of ten) that fits MIN_STEPS
 * times, none past its end; all said in one unit with the decimals the step needs ("0.5 ms", "1.0 ms"), so they read
 * evenly spaced and no two the same.
 */
function axisTicks(duration: number): Tick[] {
  const total = Math.max(duration, 1);
  const power = 10 ** Math.floor(Math.log10(total / MIN_STEPS));
  const fits = [...STEPS, ...STEPS.map((each) => each / 10)]
    .map((each) => each * power)
    .filter((each) => total / each >= MIN_STEPS - 1e-9);
  const step = Math.max(Math.max(...fits), 1);
  const [unit, scale] = step >= 100_000 && total >= 1_000_000 ? ["s", 1e6] : step >= 100 ? ["ms", 1e3] : ["µs", 1];
  const said = step / scale;
  let decimals = 0;
  while (decimals < 3 && Math.abs(Math.round(said * 10 ** decimals) - said * 10 ** decimals) > 1e-6) decimals += 1;
  const ticks: Tick[] = [];
  for (let n = 0; n * step <= total * (1 + 1e-9); n += 1) {
    ticks.push({ at: (n * step) / total, label: n === 0 ? "0" : `${(n * said).toFixed(decimals)} ${unit}` });
  }
  return ticks;
}

/** The axis' ticks between its ends: where the lanes draw their grid lines. */
function gridTicks(duration: number): number[] {
  return axisTicks(duration)
    .map((tick) => tick.at)
    .filter((at) => at > 0 && at < 0.999);
}

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

/**
 * A mark: a button that opens what it is where the lanes lead somewhere (over the call tree), else just its look and
 * its name on hover.
 */
function MarkOn({
  mark,
  look,
  onSelect,
}: {
  mark: Mark;
  look: HTMLAttributes<HTMLElement> & Record<`data-${string}`, string | undefined>;
  onSelect: ((target: MarkTarget) => void) | undefined;
}) {
  if (!onSelect) return <span {...look} title={mark.label} />;
  return (
    <button type="button" {...look} title={mark.label} aria-label={mark.label} onClick={() => onSelect(mark.target)} />
  );
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
        <span className="dt-lane-count">{lane.marks.length}</span>{" "}
        {lane.marks.length === 1 ? lane.noun[0] : lane.noun[1]}
      </span>
      <div className="dt-lane-track">
        {gridTicks(trace.duration).map((at) => (
          <span key={at} className="dt-lane-grid" style={{ left: `${at * 100}%` }} />
        ))}
        {lane.marks.map((mark) => (
          <MarkOn
            key={mark.key}
            mark={mark}
            look={{
              className: "dt-mark",
              "data-tone": mark.tone,
              "data-point": mark.duration === 0 && !mark.cut ? "" : undefined,
              "data-cut": mark.cut ? "" : undefined,
              "data-out": outside(mark, trace, range),
              ...litKey(mark.category),
              style: position(mark, trace, total),
            }}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

/** What picks a stretch of the time on the lanes: the drag, and where the range goes. */
interface Picking {
  onRange: (range: TimeRange | null) => void;
  /** A share's stretch clicked: its rows picked, or let go. */
  onShare: (category: string) => void;
  /** The code's own time clicked, when the trace has a profile: it opens, to show what ran. */
  onQuiet: ((range: TimeRange | undefined) => void) | undefined;
  start: (event: PointerEvent<HTMLDivElement>, track: Element) => void;
  layer: RefObject<HTMLDivElement | null>;
}

/** A press on a lane or the axis may start a drag across them (on a mark too: it stays a click unless it moves). */
function pressOnLanes(event: PointerEvent<HTMLDivElement>, picking: Picking): void {
  const onTrack = (event.target as Element).closest(".dt-lane-track, .dt-timeline-axis");
  if (onTrack && picking.layer.current) picking.start(event, picking.layer.current);
}

/** A click on a share's stretch picks its rows; on a lane beside its marks, the range goes. */
function clickOnLanes(event: MouseEvent<HTMLDivElement>, picking: Picking): void {
  const target = event.target as Element;
  const share = target.closest<HTMLElement>(".dt-time-track [data-category]");
  if (share) clickOnShare(share, picking);
  else if (target.classList.contains("dt-lane-track")) picking.onRange(null);
}

/**
 * A share's stretch picks its rows; its code's own time, with a profile to show what ran there, opens it. The
 * collector's pauses have no rows to pick.
 */
function clickOnShare(share: HTMLElement, picking: Picking): void {
  if (share.dataset["quiet"] && picking.onQuiet) picking.onQuiet(rangeIn(share));
  else pickShare(share.dataset["category"] ?? "", picking);
}

function pickShare(category: string, picking: Picking): void {
  if (category !== GC) picking.onShare(category);
}

/** The axis and the lanes, and over them the range picked (or being picked). */
function LanesBody({
  trace,
  drawn,
  slice,
  picking,
  onSelect,
}: {
  trace: Trace;
  drawn: Lane[];
  slice: Slice;
  picking: Picking;
  onSelect: ((target: MarkTarget) => void) | undefined;
}) {
  const range = slice.range;
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
        <span className="dt-timeline-unit">time</span>
        {/* Each label as far along itself as its tick is along the axis: the first starts there, the last ends. */}
        {axisTicks(trace.duration).map((tick) => (
          <span key={tick.at} style={{ left: `${tick.at * 100}%`, transform: `translateX(${-tick.at * 100}%)` }}>
            {tick.label}
          </span>
        ))}
      </div>
      <TimeLane trace={trace} word={LANE_WORDS[trace.kind] ?? trace.kind} parts={slice.parts} />
      {drawn.map((lane) => (
        <LaneRow key={lane.noun[1]} lane={lane} trace={trace} range={range} onSelect={onSelect} />
      ))}
      <div className="dt-timeline-layer" ref={picking.layer}>
        {range ? <RangeBand range={range} total={Math.max(trace.duration, 1)} /> : null}
      </div>
    </div>
  );
}

/**
 * The slice of the trace's view around, as the lanes change it: a range dragged, a share's stretch clicked. What
 * they pick is the call tree's to show, which opens with it.
 */
function useLanesSlice(onSelect: ((target: MarkTarget) => void) | undefined, profile: Profile | undefined) {
  const { slice, change, profileAt } = useHeldSlice();
  const pick = (next: Slice, more: boolean) => {
    change(next);
    if (more) onSelect?.({ tab: "tree" });
  };
  return {
    slice,
    // The profile at a stretch of the code's own time, where the profile says when its samples were taken: the
    // Profile tab's own stretch, not a range of the call tree's.
    openProfile: (range: TimeRange | undefined) => {
      if (range && timed(profile)) profileAt([range]);
      onSelect?.({ tab: "profile" });
    },
    onRange: (range: TimeRange | null) => pick({ ...slice, range }, range !== null),
    onShare: (category: string) => {
      const next = togglePart(slice, partOfCategory(category as Category));
      pick(next, next.parts.length > slice.parts.length);
    },
  };
}

/**
 * The trace's time: its own lane in its shares' colours, then a lane per system it called and its logs and errors
 * (only those it has), a mark each (an N+1 burst in amber, an error in red) that opens what it is. A drag across the
 * lanes picks a stretch of the time; a click beside the marks, or a double click, lets it go. Always there, its own
 * lane alone too: every call tree is read over its time the same way.
 */
export function Timeline({ trace, onSelect }: { trace: Trace; onSelect?: ((target: MarkTarget) => void) | undefined }) {
  const layer = useRef<HTMLDivElement>(null);
  const { slice, onRange, onShare, openProfile } = useLanesSlice(onSelect, trace.profile);
  const drawn = lanes(trace, slice.logs);
  const drag = useRangeDrag(Math.max(trace.duration, 1), onRange);
  const onQuiet = trace.profile ? (range: TimeRange | undefined) => openProfile(range) : undefined;
  const picking = { onRange, onShare, onQuiet, start: drag.start, layer };
  return (
    <figure className="dt-timeline" aria-label="Timeline">
      <LanesBody
        trace={trace}
        drawn={drawn}
        slice={{ ...slice, range: drag.draft ?? slice.range }}
        picking={picking}
        onSelect={onSelect}
      />
    </figure>
  );
}

/**
 * Where the trace's time went, over its call tree: its lanes over the time, and under them their legend, the shares
 * of the time and the call tree's filters. A click on a share's stretch or a mark, or a drag across the lanes, picks
 * what the tree shows.
 */
export function TimeStrip({
  trace,
  related,
  onSelect,
}: {
  trace: Trace;
  related: Related | undefined;
  onSelect: (target: MarkTarget) => void;
}) {
  return (
    // A segment hovered on any lane lights its legend item, and the legend item every segment of it.
    <section className="dt-strip" aria-label="Time" {...litScope}>
      <Timeline trace={trace} onSelect={onSelect} />
      <TimeLegend trace={trace} related={related} />
    </section>
  );
}
