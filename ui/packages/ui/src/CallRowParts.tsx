import { ScrollTextIcon } from "lucide-react";
import { type CSSProperties, createContext, type ReactNode, useContext } from "react";
import type { CodeInfo } from "./CallCode";
import { kindColor, type Mark, type Node, type ServedRun, SKEW_NOTE_MIN, type SpanNode } from "./callTree";
import { duration, isSlow } from "./format";
import { ChevronRightIcon } from "./icons";
import { NoAnswer } from "./LiveMarks";
import type { Category } from "./lib/breakdown";
import { answers, callAnswer, cutLength, unfinished } from "./lib/callAnswer";
import { callText } from "./lib/calls";
import { spanKindLabel } from "./lib/handler";
import { foldKeys } from "./lib/keys";
import { cutNote, isCut } from "./lib/live";
import { pageName, pageParts } from "./lib/page";
import { plural } from "./lib/plural";
import { WAITING } from "./lib/profile";
import { type Quiet, quietSpans } from "./lib/quiet";
import type { CodeStretch } from "./lib/scope";
import type { Slice, Windows } from "./lib/slice";
import { segmentsOf } from "./lib/timeShares";
import { FailedStatus, KindBadge, StateBadge, StatusBadge, TaskName } from "./primitives";
import type { IssueKind, Span, Trace, TraceSummary } from "./types";

/** A tab a row's mark opens beside the tree. */
export type TabOf = "issues" | "sql";

export interface RowContext {
  /** A click on a closed row opens it, on an open one only selects it: the arrow alone closes. */
  opensOnly?: boolean | undefined;
  /** The code row picked (its span and which of its parts), where a code row is a row to pick. */
  codeRow?: string | null | undefined;
  onCodeRow?: ((row: string, span: string, info: CodeInfo, at: CodeStretch) => void) | undefined;
  /** How many findings are in these spans and what ran under them, where a row says a count, not a name. */
  issuesIn?: ((targets: readonly string[]) => number) | undefined;
  /** Opens the findings of the row just selected. */
  /** Opens the Issues tab, or the tab a mark on the row names (its queries: "sql"). */
  onIssues?: ((tab?: TabOf) => void) | undefined;
  /** Beside the root row's name: what the whole record found, as its closed row says it. */
  rootMark?: ReactNode;
  /** The root row's time as the record's closed row (and the pill) say it: the time the page waited, its own. */
  rootTime?: number | undefined;
  trace: Trace;
  issueBySpan: ReadonlyMap<string, IssueKind>;
  selected: string | null;
  onSelect: (key: string) => void;
  collapsed: ReadonlySet<string>;
  /** The rows on the way to a kind shown that were folded by hand: open by themselves, not these. */
  pathFolded?: ReadonlySet<string> | undefined;
  onToggle: (key: string) => void;
  /** Set while filters are on: only marked rows show. */
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** The selected row's details, opened right under that row; null while they show in the side pane. */
  details: ReactNode;
  /** How many info and debug records each span has that don't show, by its id; and what shows them. */
  hiddenLogs: ReadonlyMap<string, number>;
  /** The info and debug records shown in the tree (a row's mark pressed): its mark hides them again. */
  logsShown?: boolean | undefined;
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
}: {
  trace: Trace;
  start: number;
  length: number;
  point?: boolean;
  /** A call cut short (see cutLength): it fades out where it was cut, as one that runs past the end does. */
  cut?: boolean;
  within?: Within | undefined;
}) {
  const [from, long] = clipped(start, length, within);
  const place = point ? pointPlace(trace, from) : barPlace(trace, from, long);
  const past = place.past ?? (cut ? "" : undefined);
  return (
    <span className="tp-map-track" aria-hidden="true">
      <span className="tp-map-bar" data-point={point ? "" : undefined} data-past={past} style={place.style} />
    </span>
  );
}

/** Where a point sits on the request's timeline. */
function pointPlace(trace: Trace, at: number): { style: CSSProperties; past: undefined } {
  const left = Math.min(Math.max(((at - trace.start) / Math.max(trace.duration, 1)) * 100, 0), 100);
  return { style: { left: `${left}%` }, past: undefined };
}

/** The least of the track a run that starts after the request ended still shows, at its right edge. */
const PAST_MIN = 6;

/**
 * Where a bar sits on the request's timeline. One that runs past its end (a task runs longer than the request that
 * enqueued it, or starts after it answered) runs to the right edge and fades out there (`past`).
 */
export function barPlace(trace: Trace, start: number, length: number): { style: CSSProperties; past: "" | undefined } {
  const total = Math.max(trace.duration, 1);
  const left = Math.min(Math.max(((start - trace.start) / total) * 100, 0), 100 - PAST_MIN);
  const past = start + length > trace.start + total;
  const width = past ? 100 - left : Math.max((length / total) * 100, 0.4);
  return { style: { left: `${left}%`, width: `${width}%` }, past: past ? "" : undefined };
}

/**
 * A row's time, tabular, in the text's colour: its bar says its share of the trace, and a call slow for what it is
 * has its issue (a slow query, a slow HTTP call), not a time in red that reads as a failure.
 */
export function RowTime({
  time,
  title,
  slow = false,
}: {
  time: number;
  title?: string | undefined;
  /** The record's own time, slow for what it is (isSlow): amber, as its row in a list says it. */
  slow?: boolean | undefined;
}) {
  return (
    <span className="tp-map-time" title={title} data-slow={slow ? "" : undefined}>
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
      <span className="tp-map-text flex">
        <span className="shrink-0 whitespace-pre">{ENQUEUE}</span>
        <TaskName name={span.name.slice(ENQUEUE.length)} />
      </span>
    );
  }
  if (TASK_SPANS.has(span.kind)) return <TaskName name={span.name} className="tp-map-text" />;
  // A view or an action as the list names its record: its badge says which, its name what and where.
  if (span.kind === "page") return <span className="tp-map-text">{pageName(span.name)}</span>;
  return <OpText text={callText(span)} kind={span.kind} />;
}

// What a call does, then what to: SELECT shop_product, GET api.example.com/users, SET session:*.
const OP = /^([A-Z][A-Z_]+)( .*)$/;
/** The kinds whose name starts with an HTTP method: a request served and a call made, coloured alike. */
const HTTP_KINDS: ReadonlySet<string> = new Set(["http", "http.client"]);

/**
 * A call's text, its operation set apart: a statement's verb or a command a little stronger than what it acts on,
 * an HTTP call's method in its colour as every list shows one.
 */
export function OpText({ text, kind, className }: { text: string; kind: string | undefined; className?: string }) {
  const op = OP.exec(text);
  const classes = className ? `tp-map-text ${className}` : "tp-map-text";
  if (!op) return <span className={classes}>{text}</span>;
  return (
    <span className={classes}>
      <span className="tp-map-op" data-method={kind && HTTP_KINDS.has(kind) ? op[1] : undefined}>
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
      <span className="tp-map-time" title={UNENDED_NOTE}>
        —
      </span>
    );
  }
  // Cut short, no answer yet: its time is where it was cut (lib/live).
  if (isCut(span)) return <RowTime time={span.duration} title={cutNote(span.duration)} />;
  // The record's own time, one number wherever it shows: what the page waited, what the server took on hover.
  const root = span.parent_id === null;
  if (root && ctx.rootTime !== undefined && ctx.rootTime > span.duration) {
    const title = `The page waited ${duration(ctx.rootTime)}; the server took ${duration(span.duration)}`;
    return <RowTime time={ctx.rootTime} title={title} slow={isSlow({ ...ctx.trace, duration: ctx.rootTime })} />;
  }
  return <RowTime time={span.duration} title={timeTitle(span, ctx.trace)} slow={root && isSlow(ctx.trace)} />;
}

/** A span's bar; a call cut short runs to where it was cut, fading out there, never a 0-width mark. */
export function OwnBar({ span, ctx }: { span: Span; ctx: RowContext }) {
  const cut = cutLength(span, ctx.trace);
  const pieces = cut === null && !ctx.within ? piecesOf(span, ctx.code.trace, ctx.trace) : null;
  if (pieces) return <PiecesBar pieces={pieces} />;
  return (
    <Bar trace={ctx.trace} start={span.start} length={cut ?? span.duration} cut={cut !== null} within={ctx.within} />
  );
}

/** A piece of a span's bar: where in the trace (% of it), and what ran then. */
interface Piece {
  left: number;
  width: number;
  category: Category;
  waiting: boolean;
}

/** Narrower than this (% of the trace), a piece joins the one before it: never a sliver of a colour. */
const PIECE_MIN = 0.6;

/**
 * A span's time in what ran under it, as the strip draws the trace's (lib/timeShares): its own code, its queries,
 * its calls, its waits, each in its share's colour. None for a span with one kind of time: its plain bar says it.
 */
function piecesOf(span: Span, owner: Trace, trace: Trace): Piece[] | null {
  // Once per span and clock: the rows draw again on every hover and tick, the trace's segments don't change.
  const known = PIECES.get(owner)?.get(trace);
  const key = span.id;
  if (known?.has(key)) return known.get(key) ?? null;
  const pieces = cutPieces(span, owner, trace);
  const byTrace = PIECES.get(owner) ?? new WeakMap<Trace, Map<string, Piece[] | null>>();
  const bySpan = byTrace.get(trace) ?? new Map<string, Piece[] | null>();
  bySpan.set(key, pieces);
  byTrace.set(trace, bySpan);
  PIECES.set(owner, byTrace);
  return pieces;
}

const PIECES = new WeakMap<Trace, WeakMap<Trace, Map<string, Piece[] | null>>>();
const SORTED = new WeakMap<Trace, Segments>();

/** The owner's segments by their start, once: a span's are found from where it starts, not by a walk of all. */
function sortedSegments(owner: Trace): Segments {
  let sorted = SORTED.get(owner);
  if (!sorted) {
    sorted = [...segmentsOf(owner)].sort((a, b) => a.from - b.from);
    SORTED.set(owner, sorted);
  }
  return sorted;
}

type Segments = ReturnType<typeof segmentsOf>;

/** The first segment that may reach into a stretch from `from` on: a binary search on where they end. */
function firstReaching(segments: Segments, from: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((segments[mid]?.to ?? 0) <= from) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** A segment's part of the span, on the trace's clock in % of it; none where it doesn't reach into the span. */
function pieceIn(
  segment: Segments[number],
  [from, to]: readonly [number, number],
  { offset, total }: { offset: number; total: number },
): Piece | null {
  const start = Math.max(segment.from, from);
  const end = Math.min(segment.to, to);
  if (end <= start) return null;
  const waiting = segment.share === WAITING;
  return {
    left: ((start + offset) / total) * 100,
    width: ((end - start) / total) * 100,
    category: waiting ? ("waiting" as Category) : segment.category,
    waiting,
  };
}

/** A piece added on: one with the one before it where they touch and are alike, or it is too thin to show. */
function addPiece(pieces: Piece[], piece: Piece): void {
  const last = pieces.at(-1);
  const touches = last !== undefined && Math.abs(last.left + last.width - piece.left) < 0.05;
  if (last && touches && (last.category === piece.category || piece.width < PIECE_MIN)) {
    last.width = piece.left + piece.width - last.left;
  } else pieces.push(piece);
}

function cutPieces(span: Span, owner: Trace, trace: Trace): Piece[] | null {
  // The span's own trace has its segments (a call's trace, under the page's): on this trace's clock from its start.
  const clock = { offset: owner.start - trace.start, total: Math.max(trace.duration, 1) };
  const from = span.start - owner.start;
  const stretch = [from, from + span.duration] as const;
  const segments = sortedSegments(owner);
  const pieces: Piece[] = [];
  for (let at = firstReaching(segments, from); at < segments.length; at++) {
    const segment = segments[at];
    if (!segment || segment.from >= stretch[1]) break;
    const piece = pieceIn(segment, stretch, clock);
    if (piece) addPiece(pieces, piece);
  }
  return pieces.length > 1 ? pieces : null;
}

function PiecesBar({ pieces }: { pieces: readonly Piece[] }) {
  return (
    <span className="tp-map-track" aria-hidden="true">
      {pieces.map((piece) => (
        <span
          key={piece.left}
          className="tp-map-bar"
          data-piece=""
          data-category={piece.category}
          data-quiet={piece.waiting ? "" : undefined}
          data-waiting={piece.waiting ? "" : undefined}
          style={{ left: `${piece.left}%`, width: `${Math.max(piece.width, 0.2)}%` }}
        />
      ))}
    </span>
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
    className: "tp-map-row",
    ...rowState(ctx, node.key, mark),
    "data-kind": span.kind,
    "data-category": ctx.categories.get(span.id),
    "data-status": rowStatus(node),
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
  return (
    <>
      <Caret open={fold} onToggle={() => ctx.onToggle(node.key)} />
      <KindBadge
        kind={rowKind(node.span, ctx.trace, parent)}
        muted={true}
        className="tp-map-kind"
        {...badgeColour(node)}
      />
    </>
  );
}

/**
 * A badge in its kind's colour, as the Show menu has it (SQL and transactions blue, calls green, GraphQL and
 * functions code's): the row's bar keeps its share's. A failed or warned row keeps the badge in its status's.
 */
function badgeColour(node: SpanNode): { "data-kind-colour"?: string; style?: CSSProperties } {
  return ["error", "warn"].includes(rowStatus(node)) ? {} : kindBadgeColour(node.span.kind);
}

/** A kind's badge in its kind's colour, where the Show menu gives it one. */
export function kindBadgeColour(kind: string | undefined): { "data-kind-colour"?: string; style?: CSSProperties } {
  const colour = kind ? kindColor(kind) : undefined;
  if (!colour) return {};
  const value = `var(--tp-k-${colour})`;
  return { "data-kind-colour": colour, style: { "--tp-k": value, "--tp-k-ink": value } as CSSProperties };
}

/** A row's kind as its badge says it: a browser's view or action as its list names it (view, click, bg). */
export function rowKind(span: Span, trace: Trace, parent: Span | undefined): string {
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
  if (open === undefined) return <span className="tp-map-caret" />;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: inside the row's button; the keyboard folds with the arrows (foldKeys).
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row's button takes the keys.
    <span
      className="tp-map-caret"
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
export function HiddenLogs({
  count,
  shown = false,
  onShow,
}: {
  count: number | undefined;
  shown?: boolean | undefined;
  onShow: () => void;
}) {
  if (!count) return null;
  const records = plural(count, "info or debug record", "info or debug records");
  return (
    // biome-ignore lint/a11y/useSemanticElements: inside the row's button; a click shows or hides the records.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the legend's Logs chip is the keyboard's way.
    <span
      className="tp-map-sub tp-map-logs"
      role="button"
      tabIndex={-1}
      aria-label={plural(count, "log", "logs")}
      aria-pressed={shown}
      data-shown={shown ? "" : undefined}
      title={`${records} · click to ${shown ? "hide" : "show"}`}
      onClick={(event) => {
        event.stopPropagation();
        onShow();
      }}
    >
      <ScrollTextIcon aria-hidden="true" />
      {count}
    </span>
  );
}

/** First click selects the row (and opens it); a second click closes its details (and folds it). */
function clickSpan(ctx: RowContext, key: string, fold: boolean | undefined): void {
  // Closed and not selected yet, or open and selected: the click folds it too.
  if (ctx.opensOnly ? fold === false : fold === (ctx.selected === key)) ctx.onToggle(key);
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
    "aria-current": ctx.selected === key && !ctx.codeRow ? ("true" as const) : undefined,
  };
}
