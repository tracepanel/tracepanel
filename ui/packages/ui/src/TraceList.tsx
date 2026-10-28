import { TriangleAlertIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { Badge } from "./components/ui/badge";
import { ago, duration } from "./format";
import { ChevronRightIcon, DatabaseIcon } from "./icons";
import { ISSUE_LABELS } from "./labels";
import type { ChainApp, ChainGroup } from "./lib/chainRows";
import { foldKeys } from "./lib/keys";
import { pageParts } from "./lib/page";
import { plural } from "./lib/plural";
import { AppChip, IssueChip, KindBadge, MethodBadge, RoutePath, StatusSlot, TaskName, Times } from "./primitives";
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
  /** By the row's trace id: the apps it called (lib/chainRows). */
  apps: ReadonlyMap<string, readonly ChainApp[]>;
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
            <ChainRows
              rowId={trace.id}
              apps={chains.apps.get(trace.id)}
              level={depth + 1}
              chains={chains}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

interface ChainRowsProps {
  rowId: string;
  apps: readonly ChainApp[] | undefined;
  /** How deep the rows sit: one step under the row they are under. */
  level: number;
  chains: ListChains;
  selectedId: string | null | undefined;
  onSelect: (id: string) => void;
}

/**
 * The apps a row's trace called, a row each ("library-api · 37 traces"), folded; open, its traces by route (×36), each
 * open in turn to what it called. A trace's row opens it beside the list; an app's row opens the row's trace with
 * its tabs under that app.
 */
function ChainRows({ rowId, apps, level, chains, selectedId, onSelect }: ChainRowsProps) {
  if (!apps?.length) return null;
  return apps.map((app) => {
    const open = chains.open.has(app.key);
    return (
      <ChainAppRows
        key={app.key}
        app={app}
        open={open}
        rowId={rowId}
        level={level}
        chains={chains}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    );
  });
}

function ChainAppRows({
  app,
  open,
  rowId,
  level,
  chains,
  selectedId,
  onSelect,
}: Omit<ChainRowsProps, "apps"> & { app: ChainApp; open: boolean }) {
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
          <AppChip name={app.app} />
          <span className="dt-request-trigger">{traces}</span>
        </span>
        <span className="dt-request-meta">
          <StatusSlot status={null} />
          <span title={`${traces} on the clock`}>{duration(app.summary.duration)}</span>
          <CompactMeta trace={app.summary} />
        </span>
      </button>
      {open
        ? app.groups.map((group) => (
            <ChainGroupRows
              key={group.key}
              group={group}
              rowId={rowId}
              level={level + 1}
              chains={chains}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  );
}

function ChainGroupRows({
  group,
  rowId,
  level,
  chains,
  selectedId,
  onSelect,
}: Omit<ChainRowsProps, "apps"> & { group: ChainGroup }) {
  const nested = group.apps.length > 0;
  const open = nested && chains.open.has(group.key);
  const toggle = () => chains.onToggle(group.key);
  const count = group.ids.length;
  const first = group.ids[0] as string;
  return (
    <>
      <button
        type="button"
        className="dt-request-row"
        data-chain="group"
        data-tone={toneOf(group.summary)}
        style={{ "--dt-chain-level": level } as CSSProperties}
        aria-current={selectedId != null && group.ids.includes(selectedId) ? "true" : undefined}
        aria-expanded={nested ? open : undefined}
        title={count > 1 ? `${count} traces, on the clock from the first's start to the last's end` : undefined}
        onClick={() => onSelect(first)}
        onKeyDown={foldKeys(nested ? open : undefined, toggle)}
      >
        <span className="dt-request-main">
          {nested ? <ChainCaret onToggle={toggle} /> : <span className="dt-map-caret" />}
          <RowName trace={group.summary} />
        </span>
        <span className="dt-request-meta">
          {count > 1 ? <Times count={count} /> : <StatusSlot status={group.summary.http_status} />}
          <span>{duration(group.summary.duration)}</span>
          <CompactMeta trace={group.summary} />
        </span>
      </button>
      {open ? (
        <ChainRows
          rowId={rowId}
          apps={group.apps}
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
  return shown && trace.kind !== "page" && trace.service ? <AppChip name={trace.service} /> : null;
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

/** What a request is named by: its GraphQL operation (not POST /graphql/), its path, else its name's path. */
function requestPath(trace: TraceSummary) {
  if (trace.name.startsWith("GraphQL ")) return trace.name.slice("GraphQL ".length);
  return trace.path ?? <RoutePath path={trace.name.split(" ").slice(1).join(" ")} />;
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
  return (
    <>
      {/* A GraphQL operation's badge is its kind's, as in the console's lists. */}
      {graphql ? (
        <KindBadge kind="graphql" />
      ) : (
        <MethodBadge method={trace.method ?? trace.name.split(" ")[0]} htmx={trace.htmx} />
      )}
      <span className="dt-request-path">
        {requestPath(trace)}
        {trigger ? <HtmxTrigger trigger={trigger} target={target} /> : null}
      </span>
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
