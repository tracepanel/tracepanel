import { type CSSProperties, createContext, type ReactNode, useContext } from "react";
import { type Mark, type Node, type ServedRun, SKEW_NOTE_MIN, type SpanNode } from "./callTree";
import { duration } from "./format";
import { ChevronRightIcon } from "./icons";
import { NoAnswer } from "./LiveMarks";
import type { Category } from "./lib/breakdown";
import { answers, callAnswer, cutLength, unfinished } from "./lib/callAnswer";
import { callText } from "./lib/calls";
import { spanKindLabel } from "./lib/handler";
import { foldKeys } from "./lib/keys";
import { cutNote, isCut } from "./lib/live";
import { pageParts } from "./lib/page";
import { plural } from "./lib/plural";
import { type Quiet, quietSpans } from "./lib/quiet";
import type { Slice, Windows } from "./lib/slice";
import { FailedStatus, KindBadge, StateBadge, StatusBadge, TaskName } from "./primitives";
import type { IssueKind, Span, Trace, TraceSummary } from "./types";
import { type Axis, useAxis, useWaterfall } from "./Waterfall";

export interface RowContext {
  trace: Trace;
  issueBySpan: ReadonlyMap<string, IssueKind>;
  selected: string | null;
  onSelect: (key: string) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Set while filters are on: only marked rows show. */
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** The selected row's details, opened right under that row; null while they show in the side pane. */
  details: ReactNode;
  /** How many info and debug records each span has that don't show, by its id; and what shows them. */
  hiddenLogs: ReadonlyMap<string, number>;
  onShowLogs: () => void;
  /** Whose code the code rows under are: this trace's, or a call's trace opened under its call. */
  code: CodeOwner;
  categories: ReadonlyMap<string, Category>;
  /** What is picked: a code row shows with its share picked, or a range it overlaps. */
  slice: Slice;
  /**
   * Opens another trace's profile (a call's trace from another app, by its id), at a stretch of it where given: its
   * row's flame and its code rows lead there. None where the host can't open one.
   */
  onTraceProfile: TraceProfileOpener | undefined;
  profilesIn: ProfilesIn | undefined;
  /** Loads the links of a call's trace opened in the tree: the calls it made in turn open under it. */
  onChain: (traceId: string) => void;
  /** The stretch of the span rows are under, which no bar of theirs is drawn past (and see Clock). */
  within?: Within | undefined;
}

export type Within = readonly [number, number];

/** Opens a trace's profile by its id, at stretches of it (µs since it started) where given. */
export type TraceProfileOpener = (traceId: string, windows?: Windows) => void;

/**
 * The trace whose own code the code rows under a row are: this one's, or a call's trace from another app opened under
 * its call (on this trace's clock), with its own profile. `quiet`: its spans whose own code ran long with nothing
 * recorded inside (as the strip says them); `onProfile` opens its profile at a stretch, when it has one.
 */
export interface CodeOwner {
  trace: Trace;
  quiet: ReadonlyMap<string, Quiet>;
  onProfile: ((windows: Windows) => void) | undefined;
  /** Its app profiles a request when asked: untraced code then says how to see what ran. */
  profiles: boolean;
}

/** A call's trace as the owner of the code rows under it: its own quiet spans, its own profile. */
export function ownerFor(
  whole: Trace,
  open: TraceProfileOpener | undefined,
  profilesIn: ProfilesIn | undefined,
): CodeOwner {
  const onProfile = open && whole.profile ? (windows: Windows) => open(whole.id, windows) : undefined;
  return { trace: whole, quiet: quietSpans(whole), onProfile, profiles: profilesIn?.(whole) === true };
}

/** Whether the app that recorded a trace profiles a request when asked. */
export type ProfilesIn = (trace: Trace) => boolean;

/** The stretch of a call, inside the one rows are already kept in. */
export function narrowed(within: Within | undefined, call: Span): Within {
  const [from, to] = [call.start, call.start + call.duration];
  if (!within) return [from, to];
  const start = Math.min(Math.max(from, within[0]), within[1]);
  return [start, Math.max(Math.min(to, within[1]), start)];
}

/** A bar's start and length cut to the stretch it is kept in. */
export function clipped(start: number, length: number, within: Within | undefined): [number, number] {
  if (!within) return [start, length];
  const from = Math.min(Math.max(start, within[0]), within[1]);
  const to = Math.min(Math.max(start + length, within[0]), within[1]);
  return [from, to - from];
}

export function Bar({
  trace,
  start,
  length,
  point,
  cut,
  within,
  title,
}: {
  trace: Trace;
  start: number;
  length: number;
  /** What a hover over the bar says: the call, its kind, its time and share. */
  title?: string | undefined;
  point?: boolean;
  /** A call cut short (see cutLength): it fades out where it was cut, as one that runs past the end does. */
  cut?: boolean;
  within?: Within | undefined;
}) {
  const [from, long] = clipped(start, length, within);
  const axis = useAxis(trace);
  const place = point ? pointPlace(axis, from) : barPlace(axis, from, long);
  const past = place.past ?? (cut ? "" : undefined);
  return (
    <span className="dt-map-track" aria-hidden="true" title={title}>
      <span
        className="dt-map-bar"
        data-point={point ? "" : undefined}
        data-past={past}
        data-before={"before" in place ? place.before : undefined}
        style={place.style}
      />
    </span>
  );
}

/** Where a point sits on the request's timeline. */
function pointPlace(trace: Axis, at: number): { style: CSSProperties; past: undefined } {
  const left = Math.min(Math.max(((at - trace.start) / Math.max(trace.duration, 1)) * 100, 0), 100);
  return { style: { left: `${left}%` }, past: undefined };
}

/** The least of the track a run that starts after the request ended still shows, at its right edge. */
const PAST_MIN = 6;

/**
 * Where a bar sits on the request's timeline. One that runs past its end (a task runs longer than the request that
 * enqueued it, or starts after it answered) runs to the right edge and fades out there (`past`).
 */
export function barPlace(
  trace: Axis,
  begin: number,
  span: number,
): { style: CSSProperties; past: "" | undefined; before?: "" | undefined } {
  // Begun before the axis does (the waterfall's axis starts where the work does): the part on the axis.
  const start = Math.max(begin, trace.start);
  const length = Math.max(span - (start - begin), 0);
  const total = Math.max(trace.duration, 1);
  const left = Math.min(Math.max(((start - trace.start) / total) * 100, 0), 100 - PAST_MIN);
  const past = start + length > trace.start + total;
  const width = past ? 100 - left : Math.max((length / total) * 100, 0.4);
  return {
    style: { left: `${left}%`, width: `${width}%` },
    past: past ? "" : undefined,
    before: begin < trace.start ? "" : undefined,
  };
}

/**
 * How slow a call reads beside its time, as the trace's share it took: amber from a fifth, red from a half. The
 * request's own code (its view, its framework) takes most of it by nature: only calls to a system say it.
 */
export function slowness(time: number, trace: Trace, category: Category | undefined): "warn" | "error" | undefined {
  if (category === undefined || OWN_TIME.has(category)) return undefined;
  const share = time / Math.max(trace.duration, 1);
  if (share >= 0.5) return "error";
  return share >= 0.2 ? "warn" : undefined;
}

const OWN_TIME: ReadonlySet<Category> = new Set(["django", "code", "template", "signal"]);

/** A row's time, tabular, in amber or red when the call took much of the trace. */
export function RowTime({
  time,
  slow,
  title,
}: {
  time: number;
  slow: "warn" | "error" | undefined;
  title?: string | undefined;
}) {
  return (
    <span className="dt-map-time" data-slow={slow} title={title}>
      {duration(time)}
    </span>
  );
}

/** A row's alias chip: none when its name already says it (`transaction app.sqlite3`). */
export function aliasBeside(span: Span): unknown {
  const alias = aliasOf(span);
  return typeof alias === "string" && span.name.includes(alias) ? undefined : alias;
}

/** A call's database, cache or storage alias, when it has one. */
export function aliasOf(span: Span | undefined): unknown {
  return span?.attrs["db.alias"] ?? span?.attrs["cache.alias"] ?? span?.attrs["storage.alias"];
}

const TASK_SPANS = new Set(["task", "task.enqueue"]);

const ENQUEUE = "enqueue ";

/** A span's name; a task's run, or its sending, named as a task is everywhere (the kind says which). */
export function SpanName({ span }: { span: Span }) {
  if (span.kind === "task.enqueue" && span.name.startsWith(ENQUEUE)) {
    // "enqueue " stays whole: only the task's name gives way.
    return (
      <span className="dt-map-text flex">
        <span className="shrink-0 whitespace-pre">{ENQUEUE}</span>
        <TaskName name={span.name.slice(ENQUEUE.length)} />
      </span>
    );
  }
  if (TASK_SPANS.has(span.kind)) return <TaskName name={span.name} className="dt-map-text" />;
  return <OpText text={callText(span)} kind={span.kind} />;
}

// What a call does, then what to: SELECT shop_product, GET api.example.com/users, SET session:*.
const OP = /^([A-Z][A-Z_]+)( .*)$/;

/**
 * A call's text, its operation set apart: a statement's verb or a command a little stronger than what it acts on,
 * an HTTP call's method in its colour as every list shows one.
 */
export function OpText({ text, kind, className }: { text: string; kind: string | undefined; className?: string }) {
  const op = OP.exec(text);
  const classes = className ? `dt-map-text ${className}` : "dt-map-text";
  if (!op) {
    return (
      <span className={classes} title={text}>
        {text}
      </span>
    );
  }
  return (
    <span className={classes} title={text}>
      <span className="dt-map-op" data-method={kind === "http.client" ? op[1] : undefined}>
        {op[1]}
      </span>
      {op[2]}
    </span>
  );
}

/** A span's time; a call the page sent its trace before it ended, with no trace served for it, has none known. */
export function OwnTime({ span, ctx }: { span: Span; ctx: RowContext }) {
  if (answers(span) && span.duration === 0 && unfinished(span)) {
    return (
      <span className="dt-map-time" title={UNENDED_NOTE}>
        —
      </span>
    );
  }
  // Cut short, no answer yet: its time is where it was cut, not how slow it was (lib/live): never amber or red.
  if (isCut(span)) return <RowTime time={span.duration} slow={undefined} title={cutNote(span.duration)} />;
  const slow = span.parent_id === null ? undefined : slowness(span.duration, ctx.trace, ctx.categories.get(span.id));
  return <RowTime time={span.duration} slow={slow} title={timeTitle(span, ctx.trace)} />;
}

/** A bar's hover: what it is, its kind, its time, its share of the trace. */
export function barTitle(name: string, kind: string, time: number, total: number): string {
  const share = total > 0 ? Math.round((time / total) * 100) : 0;
  const of = share > 100 ? "longer than the trace" : `${share < 1 ? "<1" : share}% of the trace`;
  return `${name}\n${kind} · ${duration(time)} · ${of}`;
}

/** A span's bar; a call cut short runs to where it was cut, fading out there, never a 0-width mark. */
export function OwnBar({ span, ctx }: { span: Span; ctx: RowContext }) {
  const cut = cutLength(span, ctx.trace);
  return (
    <Bar
      trace={ctx.trace}
      start={span.start}
      length={cut ?? span.duration}
      cut={cut !== null}
      within={ctx.within}
      title={barTitle(span.name, span.kind, span.duration, ctx.trace.duration)}
    />
  );
}

// A call's method and where it went: the host, the app chip beside it says better.
const HOST = /^([A-Z]+ )(?:[a-z][a-z0-9+.-]*:\/\/)?[^/\s]+(\/\S*)?$/;

/** A merged call's text: its method and path ("POST /graphql"), the host left to the app chip. */
export function hopText(span: Span): string {
  const text = callText(span);
  const found = HOST.exec(text);
  return found ? `${found[1]}${found[2] ?? "/"}` : text;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a trace's name says no more than the call's path: "GET /authors/{id}" for GET /authors/2. */
export function sameRoute(text: string, name: string): boolean {
  const pathOf = (each: string) => (each.replace(/^[A-Z]+ /, "").split("?")[0] ?? "").replace(/(.)\/$/, "$1");
  const [path, route] = [pathOf(text), pathOf(name)];
  if (path === route) return true;
  const parts = route.split(/\{[^}]+\}|<[^>]+>|:[A-Za-z_]\w*/);
  return parts.length > 1 && new RegExp(`^${parts.map(escaped).join("[^/]+")}$`).test(path);
}

/** A call cut short, on its time's hover. */
export const CUT_NOTE =
  "The page sent its trace before this call ended (a route change, or its longest wait): its time is until the trace served for it ended";

/** A call cut short with no trace served for it: its time isn't known. */
const UNENDED_NOTE =
  "The page sent its trace before this call ended (a route change, or its longest wait): its time isn't known";

/** A merged call's time on hover: the server's part and the rest (the network, a queue), and what its clock did. */
export function hopTimes(span: Span, served: ServedRun): string {
  const server = served.run.duration;
  // Longer than the call by the caller's clock: the two clocks disagree (the note says), no network time to say.
  const split =
    server > span.duration
      ? `server ${duration(server)} by its app's clock`
      : `server ${duration(server)} · network ${duration(span.duration - server)}`;
  const note = clockNote(served);
  return note ? `${split}\n${note}` : split;
}

/** A row's look by how it went: a call by what it was answered (5xx or none red, 4xx amber), else its span's status. */
function rowStatus(node: SpanNode): string {
  if (!answers(node.span)) return node.span.status;
  const { tone } = callAnswer(node.span, node.served?.run);
  return tone ?? node.span.status;
}

/**
 * What a call was answered, beside its name: its status code as every list shows one, "failed" when no answer came
 * (a connection error, a timeout). Nothing for a call that says neither.
 */
export function CallStatus({ node }: { node: SpanNode }) {
  if (!answers(node.span)) return null;
  const { status, tone } = callAnswer(node.span, node.served?.run);
  if (status !== null) return <StatusBadge status={status} />;
  // Cut short with no trace served for it yet: still waiting, said so, as everywhere such a call shows (lib/live).
  if (isCut(node.span) && !node.served) return <NoAnswer at={node.span.duration} />;
  if (tone !== "error") return null;
  const failure = node.span.attrs["error.type"];
  return <FailedStatus failure={typeof failure === "string" ? failure : undefined} />;
}

/** A span row's button: its state, kind and share; a click selects it and opens it, the arrows fold it. */
export function spanButton(ctx: RowContext, node: SpanNode, mark: Mark | undefined, fold: boolean | undefined) {
  const { span } = node;
  return {
    className: "dt-map-row",
    ...rowState(ctx, node.key, mark),
    "data-kind": span.kind,
    "data-category": ctx.categories.get(span.id),
    "data-status": rowStatus(node),
    "data-issue": ctx.issueBySpan.has(span.id) || (node.served?.run.issue_kinds.length ?? 0) > 0 ? "" : undefined,
    "aria-expanded": fold,
    onClick: () => clickSpan(ctx, node.key, fold),
    onKeyDown: foldKeys(fold, () => ctx.onToggle(node.key)),
  };
}

/** A span row's fold and its kind's badge. */
export function SpanFold({
  ctx,
  node,
  parent,
  fold,
}: {
  ctx: RowContext;
  node: SpanNode;
  parent: Span | undefined;
  fold: boolean | undefined;
}) {
  const kind = rowKind(node.span, ctx.trace, parent);
  // The waterfall says a kind in short, as its mockup does: the names keep the room.
  const short = useWaterfall() ? (SHORT_KINDS[kind] ?? kind) : kind;
  return (
    <>
      <Caret open={fold} onToggle={() => ctx.onToggle(node.key)} />
      <KindBadge kind={short} muted={true} className="dt-map-kind" title={short === kind ? undefined : kind} />
    </>
  );
}

export const SHORT_KINDS: Record<string, string> = {
  request: "req",
  function: "fn",
  transaction: "tx",
  template: "tpl",
  handler: "hdl",
  framework: "fw",
  receiver: "rcv",
  signal: "sig",
  graphql: "gql",
  "http.client": "http",
  "task.enqueue": "enq",
  middleware: "mw",
};

/** A row's kind as its badge says it: a browser's view or action as its list names it (view, click, bg). */
function rowKind(span: Span, trace: Trace, parent: Span | undefined): string {
  if (span.kind === "page") return pageParts(span.name).badge.toLowerCase();
  return spanKindLabel(span.kind, trace.attrs, parent?.kind);
}

/** Whether a span runs inside another, however deep. */
function insideOf(ancestor: Span, byId: ReadonlyMap<string, Span>): (span: Span) => boolean {
  return (span) => {
    for (let at = byId.get(String(span.parent_id)); at; at = byId.get(String(at.parent_id))) {
      if (at.id === ancestor.id) return true;
    }
    return false;
  };
}

/** The SQL a transaction ran: its queries' time, nested ones too. */
function sqlInside(transaction: Span, trace: Trace): number {
  const inside = insideOf(transaction, new Map(trace.spans.map((span) => [span.id, span])));
  return trace.spans
    .filter((span) => span.kind === "sql" && inside(span))
    .reduce((sum, span) => sum + span.duration, 0);
}

/**
 * What a row's time is, on hover, where it isn't plain: a transaction's is how long it was open, of which the SQL
 * inside took a part; the rest is code running while it is held, not the database.
 */
function timeTitle(span: Span, trace: Trace): string | undefined {
  if (span.kind !== "transaction") return undefined;
  const sql = duration(sqlInside(span, trace));
  return `Open ${duration(span.duration)}; SQL inside took ${sql}, the rest is code running while it's held`;
}

/* ---------- the code's own time ---------- */

/**
 * The fold of a row with rows under it: a click on it opens or closes them only, without selecting the row and
 * opening its details. A row without any has the empty slot, so names line up.
 */
export function Caret({ open, onToggle }: { open: boolean | undefined; onToggle: () => void }) {
  if (open === undefined) return <span className="dt-map-caret" />;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: inside the row's button; the keyboard folds with the arrows (foldKeys).
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row's button takes the keys.
    <span
      className="dt-map-caret"
      data-toggle=""
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <ChevronRightIcon />
    </span>
  );
}

/** A row's fold: open or closed, or none for a row with nothing under it. */
export function foldOf(hasChildren: boolean, open: boolean): boolean | undefined {
  return hasChildren ? open : undefined;
}

export function TaskState({ state }: { state: string | null }) {
  return state ? <StateBadge state={state} /> : null;
}

/* ---------- details of the selected row ---------- */

/** How a run's details name it: a task a worker ran, or the trace another app served for a call. */
export const RUN_WORDS = {
  task: { what: "task", label: "Task", open: "Open the task's trace →" },
  call: { what: "served by another app", label: "Trace", open: "Open the trace it served →" },
} as const;

/** A run's numbers: its name, a task's state, its queries and issues. */
export function runRows(run: TraceSummary, label: string) {
  return [
    { label, value: run.name, copy: run.name, mono: true },
    ...(run.task_state ? [{ label: "State", value: <TaskState state={run.task_state} /> }] : []),
    { label: "Queries", value: String(run.queries) },
    ...(run.issues ? [{ label: "Issues", value: String(run.issues) }] : []),
  ];
}

/** What is under the selected row, as its details show it right under their title (see UnderThis). */
export const UnderSlot = createContext<ReactNode>(null);

export function Inside() {
  return useContext(UnderSlot);
}

/**
 * A span's info and debug records, while only warnings and worse show: how many, quietly. A click shows every
 * record (the legend's Logs chip turns on).
 */
export function HiddenLogs({ count, onShow }: { count: number | undefined; onShow: () => void }) {
  if (!count) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: inside the row's button; a click here shows the records.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the legend's Logs chip is the keyboard's way.
    <span
      className="dt-map-sub dt-map-logs"
      role="button"
      tabIndex={-1}
      title="Info and debug records here; a click shows every record"
      onClick={(event) => {
        event.stopPropagation();
        onShow();
      }}
    >
      {plural(count, "log", "logs")}
    </span>
  );
}

/** First click selects the row (and opens it); a second click closes its details (and folds it). */
function clickSpan(ctx: RowContext, key: string, fold: boolean | undefined): void {
  // Closed and not selected yet, or open and selected: the click folds it too.
  if (fold === (ctx.selected === key)) ctx.onToggle(key);
  ctx.onSelect(key);
}

/** What moving a call's trace onto this clock did, said on its time, when it did more than round off a little. */
export function clockNote(node: Extract<Node, { type: "task" }>): string | undefined {
  const { clock, run } = node;
  if (!clock) return undefined;
  const call = duration(clock.call.duration);
  if (run.duration > clock.call.duration) {
    const more = duration(run.duration - clock.call.duration);
    return `Served in ${duration(run.duration)} by its app's clock, ${more} more than the ${call} call took by this one's: the two disagree. Drawn inside the call.`;
  }
  if (Math.abs(clock.shift) < SKEW_NOTE_MIN) return undefined;
  const side = clock.shift < 0 ? "ahead of" : "behind";
  const away = duration(clock.call.duration - run.duration);
  return `Its app's clock is ${duration(Math.abs(clock.shift))} ${side} this one's: drawn centred in the ${call} call, the ${away} not spent serving it split before and after.`;
}

/** A row's state as its button says it: dimmed on the way to a filtered row, current while selected. */
export function rowState(ctx: RowContext, key: string, mark: Mark | undefined) {
  return {
    "data-dim": mark === "path" ? "" : undefined,
    "aria-current": ctx.selected === key ? ("true" as const) : undefined,
    // The row's key, for the waterfall's keys to select it as focus moves.
    "data-key": key,
  };
}
