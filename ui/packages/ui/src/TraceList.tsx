import { HourglassIcon, TriangleAlertIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { Badge } from "./components/ui/badge";
import { ago, duration } from "./format";
import { ChevronRightIcon, DatabaseIcon } from "./icons";
import { ISSUE_LABELS } from "./labels";
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
import { pageParts } from "./lib/page";
import { plural } from "./lib/plural";
import { traceRuntime } from "./lib/runtime";
import { RowFlame } from "./ProfileHint";
import { AppChip, IssueChip, KindBadge, MethodBadge, StatusSlot, TailPath, TaskName, Times } from "./primitives";
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
      {rows.map(({ trace, depth = 0, trigger, target, run }) => (
        <li key={trace.id}>
          <button
            type="button"
            className="dt-request-row"
            data-depth={depth}
            data-run={flag(run)}
            data-kind={trace.kind === "page" ? "page" : undefined}
            data-tone={trace.status === "error" ? "error" : trace.issues > 0 ? "warn" : "ok"}
            aria-current={trace.id === selectedId ? "true" : undefined}
            data-new={newIds?.has(trace.id) ? "" : undefined}
            onClick={() => onSelect(trace.id)}
          >
            <span className="dt-request-main">
              <RowName trace={trace} trigger={trigger} target={target} />
              <RowApp trace={trace} shown={services} />
              {trace.id === currentId ? (
                compact ? (
                  // Narrow: a dot, so the path keeps its room; the row is also highlighted.
                  <span className="dt-this-page" role="img" aria-label="This page" title="This page" />
                ) : (
                  <span className="dt-tag">this page</span>
                )
              ) : null}
            </span>
            <span className="dt-request-meta">
              {/* A view or an action has no status of its own: an empty cell keeps the columns in place. */}
              {/* No status of its own (a view, a task, a job): its slot kept, so the time lines up with a request's. */}
              <StatusSlot status={trace.kind === "page" ? null : trace.http_status} />
              <span>{duration(trace.duration)}</span>
              {compact ? <CompactMeta trace={trace} /> : <FullMeta trace={trace} />}
            </span>
          </button>
          {chains ? (
            <RowChain rowId={trace.id} level={depth + 1} chains={chains} selectedId={selectedId} onSelect={onSelect} />
          ) : null}
        </li>
      ))}
    </ul>
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
      title={`${name}: waiting for its trace. It shows here once the app that served it sends it; a service that records none is no longer waited for ${WAITING_MS / 1000} s after the call.`}
      style={{ "--dt-chain-level": level } as CSSProperties}
    >
      <span className="dt-request-main">
        <span className="dt-map-caret" />
        {call.method ? <MethodBadge method={call.method} /> : null}
        <TailPath path={call.path} title={name} />
        <span className="dt-chain-waiting">
          <HourglassIcon aria-hidden="true" />
          waiting
        </span>
      </span>
      <span className="dt-request-meta">
        <StatusSlot status={null} />
      </span>
    </div>
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
  shared,
}: ChainLevelProps & {
  listKey: string;
  items: readonly ChainItem[];
  /** A run's traces: the route they share (their rows name them by what tells them apart). */
  shared?: string | null | undefined;
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
          <ChainTraceRows key={item.key} row={item} shared={shared} {...props} />
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
          shared={run.summary.path}
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
 * One trace of an app: its method and path (its route in the tooltip), opened beside the list; what it called under
 * it. Under a run (`shared`, the run's route), the method is the run's: just its path, what tells it apart stressed.
 */
function ChainTraceRows({
  row,
  shared,
  rowId,
  level,
  chains,
  selectedId,
  onSelect,
}: ChainLevelProps & { row: ChainTraceRow; shared?: string | null | undefined }) {
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
        title={row.route}
        onClick={() => onSelect(row.id)}
        onKeyDown={foldKeys(nested ? open : undefined, toggle)}
      >
        <span className="dt-request-main">
          {nested ? <ChainCaret onToggle={toggle} /> : <span className="dt-map-caret" />}
          {shared && row.summary.path ? (
            <TailPath path={row.summary.path} shared={shared} />
          ) : (
            <RowName trace={row.summary} />
          )}
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
 * it out), then the first finding. A browser view or action runs no SQL itself: its requests, under it, do.
 */
function CompactMeta({ trace }: { trace: TraceSummary }) {
  const queries =
    trace.kind === "page" ? (
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
function FullMeta({ trace }: { trace: TraceSummary }) {
  return (
    <>
      <span>{trace.kind === "page" ? "" : `${trace.queries} ${trace.queries === 1 ? "query" : "queries"}`}</span>
      <FullChips kinds={trace.issue_kinds} issues={trace.issues} />
      <span className="dt-request-time">{ago(trace.start)}</span>
    </>
  );
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

/** A view or an action recorded in the browser: its badge, the control, then its page. */
function PageName({ name }: { name: string }) {
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
