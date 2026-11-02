import { TriangleAlertIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { Badge } from "./components/ui/badge";
import { ago, duration } from "./format";
import { ChevronRightIcon, DatabaseIcon } from "./icons";
import { NoAnswer, Pending, Running } from "./LiveMarks";
import { ISSUE_LABELS } from "./labels";
import type { ChainCounts } from "./lib/chainCounts";
import {
  type ChainApp,
  type ChainEntry,
  type ChainItem,
  type ChainRun,
  type ChainTraceRow,
  type ChainWaiting,
  WAITING_MS,
} from "./lib/chainRows";
import { foldKeys } from "./lib/keys";
import { cutNote, NO_ANSWER } from "./lib/live";
import { pageParts } from "./lib/page";
import { plural } from "./lib/plural";
import { traceRuntime } from "./lib/runtime";
import { RowFlame } from "./ProfileHint";
import {
  AppChip,
  IssueChip,
  KindBadge,
  MethodBadge,
  StatusSlot,
  TailPath,
  TaskName,
  Times,
  WaitingIcon,
} from "./primitives";
import type { IssueKind, TraceSummary } from "./types";

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
}

export interface TraceListProps {
  rows: readonly TraceRow[];
  selectedId?: string | null | undefined;
  /** The page currently open in the browser tab. */
  currentId?: string | null | undefined;
  /** Requests that just arrived: briefly highlighted. */
  newIds?: ReadonlySet<string> | undefined;
  /** One line per request, for short lists next to a trace. */
  compact?: boolean | undefined;
  /** Several apps in the list: each request names the app that served it (a view or an action is the browser's). */
  services?: boolean | undefined;
  /** Under a row whose trace called other apps (the narrow list): their traces, folded in a row per app. */
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
  onApp: (rowId: string, app: ChainApp) => void;
  /**
   * By the row's trace id: what its whole chain did (lib/chainCounts), as the pill and the trace's tabs count it. The
   * row says it, a view's too, whose own trace ran nothing.
   */
  counts?: ReadonlyMap<string, ChainCounts> | undefined;
  /**
   * The rows whose chain has loaded once: until then a row's numbers are pending, not a definite 0 that jumps once
   * its calls' traces are counted. Undefined where chains aren't loaded at all: a row's own numbers are all there is.
   */
  settled?: ReadonlySet<string> | undefined;
  /** By the row's trace id: where its trace was cut with a call still waiting for its answer (lib/live). */
  cut?: ReadonlyMap<string, number> | undefined;
}

/**
 * Whether a row's numbers aren't known yet: it runs, or its chain hasn't loaded once. A task run under a request
 * is listed with its own numbers: no chain is loaded for it.
 */
function pendingIn(chains: ListChains | undefined, row: TraceRow): boolean {
  if (row.open) return true;
  return !row.run && chains?.settled !== undefined && !chains.settled.has(row.trace.id);
}

/** A row's summary with what its chain did, when it has one: its own trace's numbers are part of it. */
function withChain(trace: TraceSummary, counts: ChainCounts | undefined): TraceSummary {
  if (!counts || counts.traces < 2) return trace;
  // biome-ignore lint/style/useNamingConvention: wire format.
  return { ...trace, queries: counts.queries, issues: counts.issues, issue_kinds: counts.kinds };
}

export function TraceList({
  rows,
  selectedId,
  currentId,
  newIds,
  compact,
  services,
  chains,
  onSelect,
}: TraceListProps) {
  return (
    <ul className="dt-requests" data-compact={compact ? "" : undefined}>
      {rows.map((row) => {
        const counts = chains?.counts?.get(row.trace.id);
        const trace = withChain(row.trace, counts);
        const depth = row.depth ?? 0;
        const fold = chains ? rowFold(chains, trace.id) : undefined;
        return (
          <li key={trace.id}>
            <ListRow
              row={{ ...row, trace }}
              fold={fold}
              chained={counts !== undefined && counts.traces > 1}
              pending={pendingIn(chains, row)}
              cut={chains?.cut?.get(trace.id) ?? null}
              selected={trace.id === selectedId}
              current={trace.id === currentId}
              fresh={newIds?.has(trace.id) ?? false}
              compact={compact}
              services={services}
              onSelect={onSelect}
            />
            {chains && fold?.open !== false ? (
              <RowChain
                rowId={trace.id}
                level={depth + 1}
                chains={chains}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** One row of the list: its name, status and time, then its numbers (its chain's, `chained`). */
function ListRow({
  row: { trace, depth = 0, trigger, target, run, open, until },
  fold,
  chained,
  pending,
  cut,
  selected,
  current,
  fresh,
  compact,
  services,
  onSelect,
}: {
  row: TraceRow;
  /** Its chain's rows under it (the narrow list): open or folded, a caret; a placeholder for a row without. */
  fold?: RowFold | null | undefined;
  chained: boolean;
  /** Its numbers aren't known yet: "…" in their place. */
  pending: boolean;
  /** Where its trace was cut with a call unanswered, if it was. */
  cut: number | null;
  selected: boolean;
  current: boolean;
  fresh: boolean;
  compact: boolean | undefined;
  services: boolean | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="dt-request-row"
      data-depth={depth}
      data-run={flag(run)}
      data-kind={trace.kind === "page" ? "page" : undefined}
      {...liveProps(trace, open, cut)}
      aria-current={selected ? "true" : undefined}
      aria-label={traceLabel(trace, { trigger, target, current, open, cut: cut !== null })}
      {...foldProps(fold)}
      data-new={fresh ? "" : undefined}
      onClick={() => onSelect(trace.id)}
    >
      <span className="dt-request-main">
        <RowCaret fold={fold} />
        <RowName trace={trace} trigger={trigger} target={target} />
        <RowApp trace={trace} shown={services} />
        {current ? <ThisPage compact={compact} /> : null}
      </span>
      <RowMeta
        trace={trace}
        open={open}
        until={until}
        cut={cut}
        chained={chained}
        pending={pending}
        compact={compact}
      />
    </button>
  );
}

/** A row's tone and its state (lib/live): running has no tone yet, a cut one says so. */
function liveProps(trace: TraceSummary, open: boolean | undefined, cut: number | null) {
  if (open) return { "data-state": "running" };
  return { "data-tone": toneOf(trace), "data-state": cut === null ? undefined : "cut" };
}

/** A row's status, time and numbers: none of a status while it runs, its numbers pending until known. */
function RowMeta({
  trace,
  open,
  until,
  cut,
  chained,
  pending,
  compact,
}: {
  trace: TraceSummary;
  open: boolean | undefined;
  until: number | undefined;
  cut: number | null;
  chained: boolean;
  pending: boolean;
  compact: boolean | undefined;
}) {
  const Meta = compact ? CompactMeta : FullMeta;
  return (
    <span className="dt-request-meta">
      {/* No status of its own (a view, a task, a job): its slot kept, so the time lines up with a request's. */}
      <StatusSlot status={trace.kind === "page" || open ? null : trace.http_status} />
      <RowTime trace={trace} open={open} until={until} cut={cut} />
      <Meta trace={trace} chained={chained} pending={pending} />
    </span>
  );
}

/**
 * A row's time: ticking while it runs; its time and "no answer" when its trace went out with a call unanswered (its
 * time is where it was cut, not how slow it was); else its time.
 */
function RowTime({
  trace,
  open,
  until,
  cut,
}: {
  trace: TraceSummary;
  open: boolean | undefined;
  until: number | undefined;
  cut: number | null;
}) {
  if (open) return <Running start={trace.start} until={until} />;
  if (cut === null) return <span>{duration(trace.duration)}</span>;
  return (
    <span className="dt-request-cut">
      {duration(trace.duration)}
      <NoAnswer at={cut} short={true} />
    </span>
  );
}

/** A row's chain folded or not: open until folded, as an app's row; null for a row whose trace called no app. */
interface RowFold {
  open: boolean;
  onToggle: () => void;
}

/** A foldable row's state and keys; a row of a list without chains, none. */
function foldProps(fold: RowFold | null | undefined) {
  if (fold === undefined) return {};
  return {
    "aria-expanded": fold ? fold.open : undefined,
    "data-fold": "",
    onKeyDown: fold ? foldKeys(fold.open, fold.onToggle) : undefined,
  };
}

/** Its caret, or the caret's room for a row with no chain, so the names line up. */
function RowCaret({ fold }: { fold: RowFold | null | undefined }) {
  if (fold === undefined) return null;
  return fold ? <ChainCaret onToggle={fold.onToggle} /> : <span className="dt-map-caret" />;
}

function rowFold(chains: ListChains, id: string): RowFold | null {
  if (!chains.apps.get(id)?.length) return null;
  const key = `row:${id}`;
  return { open: !chains.open.has(key), onToggle: () => chains.onToggle(key) };
}

/** The page open in the browser tab: narrow, a dot, so the path keeps its room (the row is also highlighted). */
function ThisPage({ compact }: { compact: boolean | undefined }) {
  return compact ? (
    <span className="dt-this-page" role="img" aria-label="This page" title="This page" />
  ) : (
    <span className="dt-tag">this page</span>
  );
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

/** Under a list's row: its chain's rows, or a placeholder while they load the first time. */
function RowChain({ rowId, level, chains, selectedId, onSelect }: Omit<ChainRowsProps, "apps">) {
  const apps = chains.apps.get(rowId);
  if (!apps && chains.loading?.has(rowId)) return <ChainLoading level={level} />;
  return (
    <ChainRows rowId={rowId} apps={apps} level={level} chains={chains} selectedId={selectedId} onSelect={onSelect} />
  );
}

/**
 * While a row's chain loads the first time (and it is slow): a placeholder where its apps' rows would go, as tall as
 * one, so the list says something is coming and nothing jumps when it is there.
 */
function ChainLoading({ level }: { level: number }) {
  return (
    <div
      className="dt-request-row"
      data-chain="loading"
      role="status"
      aria-label="Loading the traces of this request's calls"
      title="Loading the traces of this request's calls"
      style={{ "--dt-chain-level": level } as CSSProperties}
    >
      <span className="dt-request-main">
        <span className="dt-map-caret" />
        {/* In a path's line box: the row is as tall as one with a name. */}
        <span className="dt-request-path">
          <span className="dt-skeleton dt-chain-skeleton" style={{ width: "4.5rem" }} />
        </span>
        <span className="dt-request-path">
          <span className="dt-skeleton dt-chain-skeleton" style={{ width: "7rem" }} />
        </span>
      </span>
      <span className="dt-request-meta">
        <StatusSlot status={null} />
      </span>
    </div>
  );
}

/**
 * A call whose trace hasn't arrived yet: dimmed, its method and path as the call says them, an hourglass. Its trace's
 * row takes its place once the agent has it; a call to a service that sends none is waited for WAITING_MS.
 */
function ChainWaitingRow({ call, level }: { call: ChainWaiting; level: number }) {
  const name = `${call.method ? `${call.method} ` : ""}${call.path}`;
  return (
    <div
      className="dt-request-row"
      data-chain="waiting"
      aria-disabled="true"
      title={waitingTitle(name, call.cut)}
      style={{ "--dt-chain-level": level } as CSSProperties}
    >
      <span className="dt-request-main">
        <span className="dt-map-caret" />
        {call.method ? <MethodBadge method={call.method} /> : null}
        <TailPath path={call.path} title={name} />
        <WaitingMark cut={call.cut} />
      </span>
      <span className="dt-request-meta">
        <StatusSlot status={null} />
      </span>
    </div>
  );
}

/** A waiting call's tooltip: a call cut short still waits for its answer (lib/live), an ended one for its trace. */
function waitingTitle(name: string, cut: number | null): string {
  if (cut !== null) return `${name}: still waiting. ${cutNote(cut)}`;
  return `${name}: waiting for its trace. It shows here once the app that served it sends it; a service that records none is no longer waited for ${WAITING_MS / 1000} s after the call.`;
}

/** "waiting" for an ended call's trace; "no answer yet" for a call cut short. */
function WaitingMark({ cut }: { cut: number | null }) {
  if (cut !== null) return <NoAnswer at={cut} />;
  return (
    <span className="dt-chain-waiting">
      <WaitingIcon />
      waiting
    </span>
  );
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
        className="dt-request-row"
        data-chain="app"
        data-tone={toneOf(app.summary)}
        style={{ "--dt-chain-level": level } as CSSProperties}
        aria-expanded={open}
        title={`${app.app}: ${traces} for this request's calls. Opens it with its tabs under ${app.app}.`}
        onClick={() => chains.onApp(rowId, app)}
        onKeyDown={foldKeys(open, toggle)}
      >
        <span className="dt-request-main">
          <ChainCaret onToggle={toggle} />
          <AppChip name={app.app} runtime={chainAppRuntime(app)} compact />
        </span>
        <span className="dt-request-meta">
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
          className="dt-request-row"
          data-chain="more"
          style={{ "--dt-chain-level": level } as CSSProperties}
          onClick={() => chains.onToggle(allKey)}
        >
          <span className="dt-request-main">
            <span className="dt-map-caret" />
            <span className="dt-request-trigger">Show all {items.length}</span>
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
        className="dt-request-row"
        data-chain="run"
        data-tone={toneOf(run.summary)}
        style={{ "--dt-chain-level": level } as CSSProperties}
        aria-current={holdsSelected ? "true" : undefined}
        aria-expanded={open}
        title={`${run.route} ×${count} in a row · ${time} on the clock, from the first's start to the last's end`}
        onClick={toggle}
        onKeyDown={foldKeys(open, toggle)}
      >
        <span className="dt-request-main">
          <ChainCaret onToggle={toggle} />
          <RowName trace={run.summary} />
        </span>
        <span className="dt-request-meta">
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
        className="dt-request-row"
        data-chain="trace"
        data-tone={toneOf(row.summary)}
        style={{ "--dt-chain-level": level } as CSSProperties}
        aria-current={row.id === selectedId ? "true" : undefined}
        aria-expanded={nested ? open : undefined}
        aria-label={traceLabel(row.summary)}
        title={row.route}
        onClick={() => onSelect(row.id)}
        onKeyDown={foldKeys(nested ? open : undefined, toggle)}
      >
        <span className="dt-request-main">
          {nested ? <ChainCaret onToggle={toggle} /> : <span className="dt-map-caret" />}
          <RowName trace={row.summary} />
          <RowFlame trace={row.trace} />
        </span>
        <span className="dt-request-meta">
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

/** A data attribute that is there or not. */
function flag(on: boolean | undefined): "" | undefined {
  return on ? "" : undefined;
}

/** The app a request came from, when the list holds several and the agent has the request (a view is the browser's). */
function RowApp({ trace, shown }: { trace: TraceSummary; shown: boolean | undefined }) {
  return shown && trace.kind !== "page" && trace.service ? <AppChip name={trace.service} compact /> : null;
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
}: {
  trace: TraceSummary;
  chained?: boolean;
  pending?: boolean | undefined;
}) {
  if (pending) {
    return (
      <>
        <span className="dt-request-queries" data-zero="">
          <DatabaseIcon size={12} />
          <Pending what="SQL queries" />
        </span>
        <span className="dt-request-chips" />
      </>
    );
  }
  const queries =
    trace.kind === "page" && !chained ? (
      <span />
    ) : (
      <span
        className="dt-request-queries"
        data-zero={trace.queries === 0 ? "" : undefined}
        title={`${trace.queries} SQL ${trace.queries === 1 ? "query" : "queries"}`}
      >
        <DatabaseIcon size={12} />
        <span className="dt-request-queries-n">{trace.queries}</span>
      </span>
    );
  return (
    <>
      {queries}
      <CompactChips kinds={trace.issue_kinds} issues={trace.issues} />
    </>
  );
}

/** The wide list's numbers after the time: the queries, every finding, when it happened. */
function FullMeta({ trace, chained, pending }: { trace: TraceSummary; chained: boolean; pending: boolean }) {
  return (
    <>
      <span>{pending ? <Pending what="SQL queries" /> : queriesText(trace, chained)}</span>
      {pending ? <span /> : <FullChips kinds={trace.issue_kinds} issues={trace.issues} />}
      <span className="dt-request-time">{ago(trace.start)}</span>
    </>
  );
}

/** "3 queries"; nothing for a view or an action, which runs none itself, unless its chain's are counted. */
function queriesText(trace: TraceSummary, chained: boolean): string {
  if (trace.kind === "page" && !chained) return "";
  return plural(trace.queries, "query", "queries");
}

/** Every finding by name; just their count while the kinds aren't known yet. */
function FullChips({ kinds, issues }: { kinds: IssueKind[] | undefined; issues: number }) {
  if (kinds === undefined) {
    return issues > 0 ? (
      <Badge variant="warn" size="compact">
        {issues} {issues === 1 ? "issue" : "issues"}
      </Badge>
    ) : null;
  }
  return (
    <>
      {kinds.map((kind) => (
        <IssueChip key={kind} kind={kind} />
      ))}
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
  } = {},
): string {
  if (extra.open) {
    return [rowName(trace), "running", extra.current ? "this page" : undefined].filter(Boolean).join(", ");
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
    <span className="dt-request-trigger">
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
}: {
  trace: TraceSummary;
  trigger?: string | undefined;
  target?: string | undefined;
}) {
  if (trace.kind === "page") return <PageName name={trace.name} />;
  if (trace.kind === "http") return <RequestName trace={trace} trigger={trigger} target={target} />;
  return (
    <>
      <KindBadge kind={trace.kind} />
      {trace.kind === "task" ? (
        <TaskName name={trace.name} className="dt-request-path" />
      ) : (
        <span className="dt-request-path">{trace.name.replace(/^WS /, "")}</span>
      )}
    </>
  );
}

/** A view or an action recorded in the browser: its badge, the control, then its page. One name wherever it shows. */
export function PageName({ name }: { name: string }) {
  const { badge, label, page } = pageParts(name);
  return (
    <>
      <MethodBadge method={badge} />
      <span className="dt-request-path">
        {label}
        {page ? <span className="dt-request-trigger"> · {page}</span> : null}
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
function CompactChips({ kinds, issues }: { kinds: IssueKind[] | undefined; issues: number }) {
  const shown = (kinds ?? []).filter((kind) => kind !== "error");
  // Its findings, as its Issues tab counts them (three N+1s are three), not their kinds; before its trace loads (a
  // row from the widget's summary) the number is all there is.
  const count = issues || shown.length;
  if (count === 0) return <span className="dt-request-chips" />;
  const names = shown.map((kind) => ISSUE_LABELS[kind]).join(", ");
  return (
    <span className="dt-request-chips">
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
