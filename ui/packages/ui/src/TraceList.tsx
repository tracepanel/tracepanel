import { CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { Beside } from "./beside";
import { indentOf } from "./CallCode";
import { Badge } from "./components/ui/badge";
import { ago, dayTime, duration, isSlow } from "./format";
import { ChevronRightIcon, DatabaseIcon } from "./icons";
import { NoAnswer, Pending, Running } from "./LiveMarks";
import { ISSUE_LABELS } from "./labels";
import { type RowCounts, withChain } from "./lib/chainCounts";
import {
  type ChainApp,
  type ChainEntry,
  type ChainItem,
  type ChainRun,
  type ChainTraceRow,
  type ChainWaiting,
  WAITING_MS,
  waitingSummary,
} from "./lib/chainRows";
import { spanKindLabel } from "./lib/handler";
import { foldKeys } from "./lib/keys";
import { cutNote, NO_ANSWER } from "./lib/live";
import { pageParts, redirectNote } from "./lib/page";
import { plural } from "./lib/plural";
import { traceRuntime } from "./lib/runtime";
import { cn } from "./lib/utils";
import { RowFlame } from "./ProfileHint";
import {
  AppChip,
  FailedStatus,
  KindBadge,
  KindWords,
  MethodBadge,
  StatusSlot,
  TailPath,
  TaskName,
  Times,
  WATERFALL_KINDS,
} from "./primitives";
import { Queries } from "./RunChips";
import type { IssueKind, TraceSummary } from "./types";
import { untracedNote } from "./Untraced";

export interface TraceRow {
  trace: TraceSummary;
  /** 1 for fetch/XHR requests shown under their page; a task run is one deeper than the request it came from. */
  depth?: 0 | 1 | 2 | undefined;
  /** A task run the row above it led to (it enqueued it, or one of its runs did): it ran later, in a worker. */
  run?: boolean | undefined;
  /** For an htmx request, the element that sent it ("Reload (fixed)") and where the answer went ("#rows-todo"). */
  trigger?: string | undefined;
  target?: string | undefined;
  /** In flight (lib/live): a request the page waits for, a view still open. Its time ticks, its numbers are pending. */
  open?: boolean | undefined;
  /** An open view whose calls have all answered: its time stops at the last answer (epoch µs) until it ends. */
  until?: number | undefined;
  /** A view the SPA was sent to at once from another route ("/sms-campaigns"): the list shows that one no more. */
  redirectedFrom?: string | undefined;
  /**
   * The row's identity while its trace id changes: a request keeps the id it flew under ("~…"), a view's call its
   * call's, so it stays one row, in its place, from in flight to stored (never a new row, nor a flash).
   */
  key?: string | undefined;
  /** A call with no trace of its own to open (its trace on its way, or none): a click opens this one, its view's. */
  opens?: string | undefined;
  /**
   * One of a view's or an action's calls as its chain has it (lib/chainRows, chainCalls): the trace that answered it,
   * the call while its trace is on its way, the call no trace answered ("not traced"), or the call that got no answer.
   */
  call?: "trace" | "waiting" | "untraced" | "failed" | undefined;
  /**
   * A call that got no answer (a connection error, a timeout, an abort): what failed ("No answer" where nothing says
   * more). Its status says "failed", as the call tree's does, answered and stored alike; no numbers to wait for.
   */
  failed?: string | undefined;
  /** Its numbers counted with everything under it, as the trace's tabs count them: known, never pending. */
  counted?: boolean | undefined;
  /** A view whose calls' numbers are still on their way: its own pending, never a part of them (its time stays). */
  awaiting?: boolean | undefined;
  /** Not stored yet, on its way (it ended moments ago): not a record the store let go. */
  arriving?: boolean | undefined;
  /** Cut short with no answer yet: its time so far (µs), as a call's row of a view's chain says it. */
  cut?: number | null | undefined;
  /** For a call no trace answered: the host it went to. */
  host?: string | undefined;
  /** The page's own load under its view: the host that served it (its app names a group of calls to that host). */
  loadHost?: string | undefined;
  /**
   * The W3C span id the call carried on (its traceparent), when the widget saw it: its identity in its view's trace,
   * which the view's chain matches it by (never by its name or its place).
   */
  span?: string | undefined;
  /** What it called is folded under it until opened, as a chain's trace row is (a view's call). */
  folded?: boolean | undefined;
  /**
   * A view's calls to one host, as one row over them (`trace` adds them up): named by the host while no trace of
   * theirs says which app served them, then by that app ("graphql-router ×5"). Its calls are the rows under it.
   */
  group?: CallGroup | undefined;
  /** What served it runs on (a view's call), for its group's chip. */
  runtime?: string | undefined;
  /** When the call itself started and ended (µs), as the browser timed it: its group's time on the clock. */
  clock?: { start: number; end: number } | undefined;
}

/** A view's calls to one host (TraceRow.group). */
export interface CallGroup {
  /** The view or action that made them. */
  view: string;
  host: string;
  /** The app their traces name, once one came. */
  app: string | null;
  runtime?: string | undefined;
  count: number;
  /** No trace answered any of them and none will: no numbers to say. */
  untraced?: boolean | undefined;
}

export interface TraceListProps {
  rows: readonly TraceRow[];
  /** The selected record, in its place: what it opens to (its call tree). */
  openContent: ReactNode;
  /** Older rows to show: called as the list's end scrolls into view. */
  onMore?: (() => void) | undefined;
  selectedId?: string | null | undefined;
  /** Requests that just arrived: briefly highlighted. */
  newIds?: ReadonlySet<string> | undefined;
  /** One line per request, for short lists next to a trace. */
  compact?: boolean | undefined;
  /** What each record's chain added up to, and which are still on their way. */
  chains?: ListChains | undefined;
  onSelect: (id: string) => void;
}

/** The traces other apps served for the rows' calls, and which of their rows are open. */
export interface ListChains {
  /** By the row's trace id: the apps it called, and its calls whose traces are on their way (lib/chainRows). */
  apps: ReadonlyMap<string, readonly ChainEntry[]>;
  /** The rows whose chain is still being loaded, the first time: placeholders under them until it is. */
  loading?: ReadonlySet<string> | undefined;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** An app's row: the row's trace, its tabs listing what that app's traces did. */
  onApp: (rowId: string, app: string) => void;
  /**
   * By the row's trace id: what its whole chain did (lib/chainCounts), as the pill and the trace's tabs count it. The
   * row says it, a view's too, whose own trace ran nothing.
   */
  counts?: ReadonlyMap<string, RowCounts> | undefined;
  /**
   * The rows whose chain has loaded once: until then a row's numbers are pending, not a definite 0 that jumps once
   * its calls' traces are counted. Undefined where chains aren't loaded at all: a row's own numbers are all there is.
   */
  settled?: ReadonlySet<string> | undefined;
  /** By the row's trace id: where its trace was cut with a call still waiting for its answer (lib/live). */
  cut?: ReadonlyMap<string, number> | undefined;
  /** What a trace's row says it opens on (TraceListProps), for the chain's trace rows. */
  opensOn?: ((trace: TraceSummary) => string | undefined) | undefined;
}

/** The list's end: in view, it asks for older rows (and again, once they came, while it still is). */
function MoreRows({ onMore }: { onMore: () => void }) {
  const end = useRef<HTMLLIElement>(null);
  const latest = useRef(onMore);
  latest.current = onMore;
  useEffect(() => {
    const node = end.current;
    if (!node) return;
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((each) => each.isIntersecting)) latest.current();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <li ref={end} className="tp-requests-more">
      Older requests…
    </li>
  );
}

/**
 * The time closed records' bars are shares of: the longest but for the slowest tenth, so that one stuck request (a
 * 15 s timeout) doesn't flatten every other bar to a dot; those few reach the end. Linear: 300 ms is half of 600.
 */
function typicalLongest(durations: readonly number[]): number {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9));
  return Math.max(1, sorted[at] ?? 1);
}

export function TraceList({
  rows,
  selectedId,
  newIds,
  compact,
  chains,
  onSelect,
  openContent,
  onMore,
}: TraceListProps) {
  const longest = typicalLongest(rows.map((row) => row.trace.duration));
  const props = { longest, openContent, chains, selectedId, newIds, onSelect };
  return (
    <ul className="tp-requests" data-compact={compact ? "" : undefined}>
      {/* A trace opened from elsewhere (the one a call was served by) that isn't a row here: still open, first. */}
      {selectedId && !rows.some((row) => row.trace.id === selectedId) ? (
        <li>
          <div className="tp-requests-open">{openContent}</div>
        </li>
      ) : null}
      {rows.map((row) => (
        <ListItem key={row.key ?? row.trace.id} row={row} {...props} />
      ))}
      {/* Anew with each page: an end still in view once the rows came asks again. */}
      {onMore ? <MoreRows key={rows.length} onMore={onMore} /> : null}
    </ul>
  );
}

/** One record of the list: its row, or, open, what it opens to. */
function ListItem({
  row,
  chains,
  selectedId,
  newIds,
  onSelect,
  longest,
  openContent,
}: Pick<TraceListProps, "chains" | "selectedId" | "newIds" | "onSelect" | "openContent"> & {
  /** The scale of closed records' bars: the longest listed but for a few far longer (see typicalLongest). */
  longest?: number;
  row: TraceRow;
}) {
  const counts = chains?.counts?.get(row.trace.id);
  const trace = withChain(row.trace, counts);
  const fresh = newIds?.has(row.key ?? trace.id) ?? false;
  const share = Math.min(trace.duration / (longest ?? trace.duration), 1);
  // Open, its row is the first of what it opens to.
  if (trace.id === selectedId) {
    return (
      <li>
        {/* On the list's scale: its bars as long as its closed row's, what it called within them. */}
        <div className="tp-requests-open" style={{ "--record-share": share } as CSSProperties}>
          {openContent}
        </div>
      </li>
    );
  }
  return (
    <li>
      <RecordRow
        row={{ ...row, trace }}
        fresh={fresh}
        onSelect={onSelect}
        share={share}
        pending={recordPending(row)}
        // Asked for its chain and none came: its traces have left the local store.
        gone={isGone(row, chains?.counts)}
      />
    </li>
  );
}

/** One row of the list: its name, status and time, then its numbers (its chain's, `chained`). */
/**
 * A record that opens in place, as one row: closed, its tree's first row with how long ago in place of its
 * bar's scale; `live`, open with no tree yet (still running, or on its way), a bar that breathes and its time.
 */

const GONE_NOTE = "Not in the local store anymore: newer traces took its place.";

/** Asked for and not in the local store, nor on its way: newer traces took its place. */
export function isGone(row: TraceRow, counts: ReadonlyMap<string, RowCounts> | undefined): boolean {
  return counts !== undefined && !counts.has(row.trace.id) && !row.open && !row.awaiting && !row.arriving;
}

/** A record still waiting for its calls' traces: a view still open, or one whose calls' numbers are on their way. */
export function recordPending(row: TraceRow): boolean {
  return Boolean(row.open || row.awaiting);
}

/**
 * What a record found, a column each, the same on every row: its marks line up down the list, empty or not. Its
 * closed row and its open tree's first row say the same; "…" while its calls' traces are on their way.
 */
export function RecordMarks({
  trace,
  pending,
  className,
}: {
  trace: TraceSummary;
  pending: boolean;
  className?: string | undefined;
}) {
  return (
    <span className={cn("tp-record-marks", className)}>
      <span className="tp-record-errors">
        <Errors count={trace.errors} />
      </span>
      <span className="tp-record-issues">
        {pending ? null : <CompactChips kinds={trace.issue_kinds} issues={trace.issues} />}
      </span>
      <span className="tp-record-queries" data-opens="sql">
        {pending ? <Pending what="Queries down its calls" /> : <Queries count={trace.queries} time={trace.db_time} />}
      </span>
    </span>
  );
}

export function RecordRow({
  row: { trace, open, until, target: _target, opens: target, failed },
  fresh,
  onSelect,
  live = false,
  share,
  depth = 0,
  gone = false,
  pending = false,
  current = false,
}: {
  /** The record open: its row the list's current one, live or not. */
  current?: boolean | undefined;
  /** Its traces are no longer in the local store: said, the row quiet. */
  gone?: boolean | undefined;
  /** Its calls' traces still on their way: no numbers yet, never a part of them. */
  pending?: boolean | undefined;
  /** How far in it sits: a call of a view still open shows under it. */
  depth?: number | undefined;
  /** Closed: its time against the list's typical longest, linear; a far longer one reaches the end. */
  share?: number | undefined;
  row: TraceRow;
  fresh: boolean;
  onSelect: (id: string) => void;
  live?: boolean | undefined;
}) {
  const page = trace.kind === "page" ? pageParts(trace.name) : null;
  return (
    <KindWords.Provider value={WATERFALL_KINDS}>
      <button
        type="button"
        className="tp-map-row tp-record"
        data-record={trace.id}
        {...recordState({ gone, live, current, fresh })}
        data-kind={trace.kind}
        // Its badge in its open tree's root colour: a view's is its code's, as the tree's first row has it.
        data-category={page ? "code" : undefined}
        // Gone from the store, there is nothing to open: it stays a quiet line, its note on hover.
        onClick={() => (gone ? undefined : onSelect(target ?? trace.id))}
      >
        <span className="tp-map-name" style={indentOf(depth)}>
          <RecordLead trace={trace} page={page} ago={!(live || depth > 0)} />
          {/* Its status the pill its call's row has in the tree, and with the tree's numbers: none while they are on
              their way. A failure shows at once: its call may never send a trace. */}
          <Beside value={true}>
            {failed === undefined ? (
              <StatusSlot status={page || pending ? null : trace.http_status} />
            ) : (
              <FailedStatus failure={failed} />
            )}
          </Beside>
          <RecordMarks trace={trace} pending={pending} className="tp-map-chips" />
        </span>
        <RecordTrack live={live} share={share} />
        <span className="tp-map-time">
          <RowTime trace={trace} open={open} until={until} />
        </span>
      </button>
    </KindWords.Provider>
  );
}

/** A record row's state, as its attributes say it: gone, live, the open one, just arrived. */
function recordState({
  gone,
  live,
  current,
  fresh,
}: {
  gone: boolean;
  live: boolean;
  current: boolean;
  fresh: boolean;
}) {
  return {
    "data-gone": gone ? "" : undefined,
    title: gone ? GONE_NOTE : undefined,
    "data-live": live ? "" : undefined,
    "aria-current": live || current ? ("true" as const) : undefined,
    "data-new": fresh ? "" : undefined,
    "aria-disabled": gone || undefined,
  };
}

/** A record's caret, badge and name, and when it was. */
function RecordLead({
  trace,
  page,
  ago: when,
}: {
  trace: TraceSummary;
  page: ReturnType<typeof pageParts> | null;
  /** A record says when; a call under the open one is a row of its tree, as its stored tree will say it. */
  ago: boolean;
}) {
  return (
    <span className="tp-map-lead">
      <span className="tp-map-caret" data-toggle="">
        <ChevronRightIcon />
      </span>
      <KindBadge
        kind={page ? page.badge.toLowerCase() : spanKindLabel(trace.kind, {})}
        muted={true}
        className="tp-map-kind"
      />
      <span className="tp-map-text">{page ? [page.label, page.page].filter(Boolean).join(" ") : trace.name}</span>
      {/* On hover its moment: records alike ("VIEW / 4m ago") still part by when each was. */}
      {when ? (
        <span className="tp-record-ago" title={dayTime(trace.start)}>
          {ago(trace.start)}
        </span>
      ) : null}
    </span>
  );
}

/** A record's bar: running while it runs, its time on the list's scale once closed. */
function RecordTrack({ live, share }: { live: boolean; share: number | undefined }) {
  return (
    <span className="tp-map-track">
      {live ? <span className="tp-map-bar tp-record-live" /> : null}
      {share === undefined ? null : (
        <span className="tp-map-bar tp-record-share" style={{ left: 0, width: `${Math.max(share * 100, 1)}%` }} />
      )}
    </span>
  );
}

/** A call no trace answered and none will, as the call tree says it: muted, its reason in the tooltip. */
function NotTracedMark({ host }: { host: string }) {
  return (
    <span className="tp-not-traced" data-state="untraced" title={untracedNote(host)}>
      not traced
    </span>
  );
}

/**
 * A row's time: ticking while it runs, else its time. A trace that went out with a call unanswered says "no answer"
 * beside its name, never here: its time is where it was cut, and the column keeps a time's width for every row.
 */
function RowTime({
  trace,
  open,
  until,
}: {
  trace: TraceSummary;
  open: boolean | undefined;
  until: number | undefined;
}) {
  if (open) return <Running start={trace.start} until={until} />;
  // Slow for what it is, as the agent counts it: amber, not red (slow is no failure).
  return <span data-slow={isSlow(trace) ? "" : undefined}>{duration(trace.duration)}</span>;
}

interface ChainRowsProps {
  rowId: string;
  apps: readonly ChainEntry[] | undefined;
  /** How deep the rows sit: one step under the row they are under. */
  level: number;
  chains: ListChains;
  selectedId: string | null | undefined;
  onSelect: (id: string) => void;
}

/**
 * The apps a row's trace called, a row each ("library-api ×37"), open; its traces in the order they
 * started, each open in turn to what it called. A trace's row opens it beside the list; an app's row opens the row's
 * trace with its tabs under that app.
 */
function ChainRows({ rowId, apps, level, chains, selectedId, onSelect }: ChainRowsProps) {
  if (!apps?.length) return null;
  return apps.map((app) =>
    app.type === "waiting" ? (
      <ChainWaitingRow key={app.key} call={app} level={level} />
    ) : (
      <ChainAppRows
        key={app.key}
        app={app}
        rowId={rowId}
        level={level}
        chains={chains}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    ),
  );
}

/**
 * A call whose trace hasn't arrived yet: dimmed, its method and path as the call says them, an hourglass. Its trace's
 * row takes its place once the agent has it; a call to a service that sends none is waited for WAITING_MS.
 */
function ChainWaitingRow({ call, level }: { call: ChainWaiting; level: number }) {
  const summary = waitingSummary(call);
  const name = rowName(summary);
  // Once no trace will come: the same row, "not traced", as the call tree says it; no numbers to wait for.
  const untraced = call.untraced;
  return (
    <div
      className="tp-request-row"
      data-chain={untraced === undefined ? "waiting" : "untraced"}
      aria-disabled="true"
      title={untraced === undefined ? waitingTitle(name, call.cut) : `${name}: ${untracedNote(untraced)}`}
      style={{ "--tp-chain-level": level } as CSSProperties}
    >
      <span className="tp-request-main">
        <span className="tp-map-caret" />
        <RowName trace={summary} />
        {call.cut === null ? null : <NoAnswer at={call.cut} />}
        {untraced === undefined ? null : <NotTracedMark host={untraced} />}
      </span>
      {/* As the row of its trace will be: its status and time, its numbers pending until that trace comes. */}
      <span className="tp-request-meta">
        <StatusSlot status={summary.http_status} />
        <span>{duration(summary.duration)}</span>
        <CompactMeta trace={summary} pending={untraced === undefined} blank={untraced !== undefined} />
      </span>
    </div>
  );
}

/** A waiting call's tooltip: a call cut short still waits for its answer (lib/live), an ended one for its trace. */
function waitingTitle(name: string, cut: number | null): string {
  if (cut !== null) return `${name}: still waiting. ${cutNote(cut)}`;
  return `${name}: waiting for its trace. It shows here once the app that served it sends it; a service that records none is no longer waited for ${WAITING_MS / 1000} s after the last call to it.`;
}

type ChainLevelProps = Omit<ChainRowsProps, "apps">;

/** What an app runs on, from its first trace: the mark on its chip, as the call tree's has it. */
function chainAppRuntime(app: ChainApp): string | undefined {
  const first = app.items.find((item) => item.type !== "waiting");
  const trace = first?.type === "run" ? first.traces[0]?.trace : first?.trace;
  return trace ? traceRuntime(trace.attrs) : undefined;
}

function ChainAppRows({ app, rowId, level, chains, selectedId, onSelect }: ChainLevelProps & { app: ChainApp }) {
  // Open until it is folded: the stored rows say what the user changed.
  const open = !chains.open.has(app.key);
  const toggle = () => chains.onToggle(app.key);
  const traces = plural(app.ids.length, "trace", "traces");
  return (
    <>
      <button
        type="button"
        className="tp-request-row"
        data-chain="app"
        data-tone={toneOf(app.summary)}
        style={{ "--tp-chain-level": level } as CSSProperties}
        aria-expanded={open}
        title={`${app.app}: ${traces} for this request's calls. Opens its call tree where ${app.app}'s part starts, its tabs under ${app.app}.`}
        onClick={() => chains.onApp(rowId, app.app)}
        onKeyDown={foldKeys(open, toggle)}
      >
        <span className="tp-request-main">
          <ChainCaret onToggle={toggle} />
          <AppChip name={app.app} runtime={chainAppRuntime(app)} compact />
        </span>
        <span className="tp-request-meta">
          {/* How many, as a run's row counts its traces: in the status column. */}
          {app.ids.length > 1 ? <Times count={app.ids.length} /> : <StatusSlot status={null} />}
          <span title={`${traces} on the clock`}>{duration(app.summary.duration)}</span>
          <CompactMeta trace={app.summary} />
        </span>
      </button>
      {open ? (
        <ChainItems
          listKey={app.key}
          items={app.items}
          rowId={rowId}
          level={level + 1}
          chains={chains}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ) : null}
    </>
  );
}

/** Rows shown at once in one list under an app (its traces, or a run's): the rest behind "Show all". */
const SHOWN_FIRST = 50;

/** An app's traces (or a run's) in order: the first SHOWN_FIRST, then a row that shows them all. */
function ChainItems({
  listKey,
  items,
  rowId,
  level,
  chains,
  selectedId,
  onSelect,
}: ChainLevelProps & {
  listKey: string;
  items: readonly ChainItem[];
}) {
  const allKey = `${listKey}/all`;
  const all = items.length <= SHOWN_FIRST || chains.open.has(allKey);
  const shown = all ? items : items.slice(0, SHOWN_FIRST);
  const props = { rowId, level, chains, selectedId, onSelect };
  return (
    <>
      {shown.map((item) =>
        item.type === "run" ? (
          <ChainRunRows key={item.key} run={item} {...props} />
        ) : item.type === "waiting" ? (
          <ChainWaitingRow key={item.key} call={item} level={level} />
        ) : (
          <ChainTraceRows key={item.key} row={item} {...props} />
        ),
      )}
      {all ? null : (
        <button
          type="button"
          className="tp-request-row"
          data-chain="more"
          style={{ "--tp-chain-level": level } as CSSProperties}
          onClick={() => chains.onToggle(allKey)}
        >
          <span className="tp-request-main">
            <span className="tp-map-caret" />
            <span className="tp-request-trigger">Show all {items.length}</span>
          </span>
        </button>
      )}
    </>
  );
}

/**
 * Three or more traces of one route in a row: one row (×36, their time on the clock), open while the app has few
 * traces, each of them under it in order. A click opens or folds it.
 */
function ChainRunRows({ run, rowId, level, chains, selectedId, onSelect }: ChainLevelProps & { run: ChainRun }) {
  // Its fold kept as a change from where it starts (open or folded), so the stored rows say what the user did.
  const open = chains.open.has(run.key) !== run.open;
  const toggle = () => chains.onToggle(run.key);
  const count = run.ids.length;
  const time = duration(run.summary.duration);
  const holdsSelected = !open && selectedId != null && run.ids.includes(selectedId);
  return (
    <>
      <button
        type="button"
        className="tp-request-row"
        data-chain="run"
        data-tone={toneOf(run.summary)}
        style={{ "--tp-chain-level": level } as CSSProperties}
        aria-current={holdsSelected ? "true" : undefined}
        aria-expanded={open}
        title={`${run.route} ×${count} in a row · ${time} on the clock, from the first's start to the last's end`}
        onClick={toggle}
        onKeyDown={foldKeys(open, toggle)}
      >
        <span className="tp-request-main">
          <ChainCaret onToggle={toggle} />
          <RowName trace={run.summary} />
        </span>
        <span className="tp-request-meta">
          <Times count={count} />
          <span>{time}</span>
          <CompactMeta trace={run.summary} />
        </span>
      </button>
      {open ? (
        <ChainItems
          listKey={run.key}
          items={run.traces}
          rowId={rowId}
          level={level + 1}
          chains={chains}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ) : null}
    </>
  );
}

/**
 * One trace of an app: named as the list names a request (its GraphQL operation, or its method and path; its route
 * in the tooltip), the same under a run as anywhere; opened beside the list; what it called under it.
 */
function ChainTraceRows({ row, rowId, level, chains, selectedId, onSelect }: ChainLevelProps & { row: ChainTraceRow }) {
  const nested = row.apps.length > 0;
  const open = nested && chains.open.has(row.key);
  const toggle = () => chains.onToggle(row.key);
  return (
    <>
      <button
        type="button"
        className="tp-request-row"
        data-chain="trace"
        data-tone={toneOf(row.summary)}
        style={{ "--tp-chain-level": level } as CSSProperties}
        aria-current={row.id === selectedId ? "true" : undefined}
        aria-expanded={nested ? open : undefined}
        aria-label={traceLabel(row.summary)}
        title={[row.route, chains.opensOn?.(row.summary)].filter(Boolean).join("\n")}
        onClick={() => onSelect(row.id)}
        onKeyDown={foldKeys(nested ? open : undefined, toggle)}
      >
        <span className="tp-request-main">
          {nested ? <ChainCaret onToggle={toggle} /> : <span className="tp-map-caret" />}
          <RowName trace={row.summary} />
          <RowFlame trace={row.trace} />
        </span>
        <span className="tp-request-meta">
          <StatusSlot status={row.summary.http_status} />
          <span>{duration(row.summary.duration)}</span>
          <CompactMeta trace={row.summary} />
        </span>
      </button>
      {open ? (
        <ChainRows
          rowId={rowId}
          apps={row.apps}
          level={level + 1}
          chains={chains}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ) : null}
    </>
  );
}

function toneOf(trace: TraceSummary): "error" | "warn" | "ok" {
  return trace.status === "error" ? "error" : trace.issues > 0 ? "warn" : "ok";
}

/** The fold of a chain's row, as the call tree's: a click opens or closes it only; the row's own click is the row's. */
function ChainCaret({ onToggle }: { onToggle: () => void }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: inside the row's button; the keyboard folds with the arrows.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row's button takes the keys (foldKeys).
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

/**
 * The narrow list's numbers after the time: the queries (the database icon says what they count, the tooltip spells
 * it out), then the first finding. A browser view or action runs no SQL itself: its chain's, when it has one
 * (`chained`), else none.
 */
function CompactMeta({
  trace,
  chained = false,
  pending = false,
  blank = false,
}: {
  trace: TraceSummary;
  chained?: boolean;
  pending?: boolean | undefined;
  blank?: boolean | undefined;
}) {
  if (blank) {
    return (
      <>
        <span />
        <span className="tp-request-chips" />
      </>
    );
  }
  if (pending) {
    return (
      <>
        <span className="tp-request-queries" data-zero="">
          <DatabaseIcon size={12} />
          <Pending what="SQL queries" />
        </span>
        <span className="tp-request-chips" />
      </>
    );
  }
  const queries =
    trace.kind === "page" && !chained ? (
      <span />
    ) : (
      <span
        className="tp-request-queries"
        data-zero={trace.queries === 0 ? "" : undefined}
        title={`${trace.queries} SQL ${trace.queries === 1 ? "query" : "queries"}`}
      >
        <DatabaseIcon size={12} />
        <span className="tp-request-queries-n">{trace.queries}</span>
      </span>
    );
  return (
    <>
      {queries}
      <CompactChips kinds={trace.issue_kinds} issues={trace.issues} />
    </>
  );
}

/**
 * What a request is named by: its GraphQL operation (not POST /graphql/), its path, else its name's path (a route,
 * its parameters dimmed).
 */
function requestPath(trace: TraceSummary): { path: string; route: boolean } {
  if (trace.name.startsWith("GraphQL ")) return { path: trace.name.slice("GraphQL ".length), route: false };
  if (trace.path) return { path: trace.path, route: false };
  return { path: trace.name.split(" ").slice(1).join(" "), route: true };
}

/** A row's name in words: what the badge and the path say, as one string. */
function rowName(trace: TraceSummary): string {
  if (trace.kind === "page") return trace.name;
  if (trace.kind === "http") {
    if (trace.name.startsWith("GraphQL ")) return trace.name;
    const method = trace.method ?? trace.name.split(" ")[0] ?? "";
    return `${method} ${requestPath(trace).path}`.trim();
  }
  const kind = trace.kind === "command" ? "job" : trace.kind;
  return `${kind} ${trace.name.replace(/^WS /, "")}`;
}

/**
 * A row's accessible name, one clean line: its method and whole path (its badge and its path are separate boxes, and
 * a path cut at its start reads in pieces), how it ended, how long it took, its findings, what sent it.
 */
export function traceLabel(
  trace: TraceSummary,
  extra: {
    trigger?: string | undefined;
    target?: string | undefined;
    current?: boolean;
    open?: boolean | undefined;
    cut?: boolean | undefined;
    redirectedFrom?: string | undefined;
  } = {},
): string {
  const from = extra.redirectedFrom ? redirectNote(extra.redirectedFrom) : undefined;
  if (extra.open) {
    return [rowName(trace), from, "running", extra.current ? "this page" : undefined].filter(Boolean).join(", ");
  }
  const outcome =
    trace.task_state ??
    (trace.kind !== "page" && typeof trace.http_status === "number"
      ? String(trace.http_status)
      : trace.status === "error"
        ? "failed"
        : undefined);
  const sent = extra.trigger ? `sent by ${extra.trigger}${extra.target ? ` → ${extra.target}` : ""}` : undefined;
  return [
    rowName(trace),
    from,
    outcome,
    duration(trace.duration),
    extra.cut ? NO_ANSWER : undefined,
    trace.issues > 0 ? plural(trace.issues, "issue", "issues") : undefined,
    sent,
    extra.current ? "this page" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

/** An htmx request: the element that sent it and where the answer went, after the path. */
function HtmxTrigger({ trigger, target }: { trigger: string; target?: string | undefined }) {
  return (
    <span className="tp-request-trigger">
      {" "}
      · {trigger}
      {target ? ` → ${target}` : ""}
    </span>
  );
}

/** A request: its method (GQL for a GraphQL operation) and its path, and what sent it for htmx. */
function RequestName({
  trace,
  trigger,
  target,
}: {
  trace: TraceSummary;
  trigger?: string | undefined;
  target?: string | undefined;
}) {
  const graphql = trace.name.startsWith("GraphQL ");
  const { path, route } = requestPath(trace);
  return (
    <>
      {/* A GraphQL operation's badge is its kind's, as in the console's lists. */}
      {graphql ? (
        <KindBadge kind="graphql" />
      ) : (
        <MethodBadge method={trace.method ?? trace.name.split(" ")[0]} htmx={trace.htmx} />
      )}
      <TailPath path={path} params={route}>
        {trigger ? <HtmxTrigger trigger={trigger} target={target} /> : null}
      </TailPath>
    </>
  );
}

/** What a row is named by, as the console's lists name it: a request, a view or an action, else its kind and name. */
function RowName({
  trace,
  trigger,
  target,
  redirectedFrom,
}: {
  trace: TraceSummary;
  trigger?: string | undefined;
  target?: string | undefined;
  redirectedFrom?: string | undefined;
}) {
  if (trace.kind === "page") return <PageName name={trace.name} redirectedFrom={redirectedFrom} />;
  if (trace.kind === "http") return <RequestName trace={trace} trigger={trigger} target={target} />;
  return (
    <>
      <KindBadge kind={trace.kind} />
      {trace.kind === "task" ? (
        <TaskName name={trace.name} className="tp-request-path" />
      ) : (
        <span className="tp-request-path">{trace.name.replace(/^WS /, "")}</span>
      )}
    </>
  );
}

/**
 * A view or an action recorded in the browser: its badge, the control, then its page. One name wherever it shows. A
 * view the SPA was sent to at once says where from ("redirected from /sms-campaigns").
 */
export function PageName({ name, redirectedFrom }: { name: string; redirectedFrom?: string | undefined }) {
  const { badge, label, page } = pageParts(name);
  return (
    <>
      <MethodBadge method={badge} />
      <span className="tp-request-path">
        {label}
        {page ? <span className="tp-request-trigger"> · {page}</span> : null}
        {redirectedFrom ? <span className="tp-request-trigger"> · {redirectNote(redirectedFrom)}</span> : null}
      </span>
    </>
  );
}

/**
 * The narrow list's last column (empty on a clean row, so the columns stay in place): the first finding, "+N" for
 * the rest, all of them in the tooltip. An error shows as its status and the red edge, not here.
 */
/**
 * The narrow list's findings: a mark and how many, in the first kind's colour, their names in its title. A label per
 * finding ("Before commit +3") took the row's room from its path.
 */
/** Its errors, the chain's too: a mark and how many, in red; nothing for none. */
function Errors({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge
      variant="error"
      size="compact"
      className="gap-[0.1875rem] px-[0.375rem] tabular-nums"
      title={plural(count, "error", "errors")}
    >
      <CircleXIcon aria-hidden="true" />
      {count}
    </Badge>
  );
}

export function CompactChips({ kinds, issues }: { kinds: IssueKind[] | undefined; issues: number }) {
  const shown = (kinds ?? []).filter((kind) => kind !== "error");
  // Its findings, as its Issues tab counts them (three N+1s are three), not their kinds; before its trace loads (a
  // row from the widget's summary) the number is all there is.
  const count = issues || shown.length;
  if (count === 0) return <span className="tp-request-chips" />;
  const names = shown.map((kind) => ISSUE_LABELS[kind]).join(", ");
  return (
    <span className="tp-request-chips">
      <Badge
        variant="warn"
        size="compact"
        className="gap-[0.1875rem] px-[0.375rem] tabular-nums"
        title={names || `${count} ${count === 1 ? "issue" : "issues"}`}
      >
        <TriangleAlertIcon aria-hidden="true" />
        {count}
      </Badge>
    </span>
  );
}
