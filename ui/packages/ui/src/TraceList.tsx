import { CornerDownRightIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { ago, duration } from "./format";
import { DatabaseIcon } from "./icons";
import { ISSUE_LABELS } from "./labels";
import { pageParts } from "./lib/page";
import { AppChip, IssueChip, KindBadge, MethodBadge, RoutePath, StatusSlot, TaskName } from "./primitives";
import type { IssueKind, TraceSummary } from "./types";

export interface TraceRow {
  trace: TraceSummary;
  /** 1 for fetch/XHR requests shown under their page; a task run is one deeper than the request it came from. */
  depth?: 0 | 1 | 2 | undefined;
  /** A task run the row above it led to (it enqueued it, or one of its runs did): it ran later, in a worker. */
  run?: boolean | undefined;
  /** On a request: what its task runs found, counted apart from its own. */
  runIssues?: RunIssues | undefined;
  /** For an htmx request, the element that sent it ("Reload (fixed)") and where the answer went ("#rows-todo"). */
  trigger?: string | undefined;
  target?: string | undefined;
}

/** The findings of a request's task runs: how many, of which kinds. */
export interface RunIssues {
  count: number;
  kinds: IssueKind[];
}

/** What a request's runs found, together: their findings counted and their kinds once each; none when clean. */
export function runIssues(runs: readonly TraceSummary[]): RunIssues | undefined {
  const count = runs.reduce((sum, run) => sum + run.issues, 0);
  if (count === 0) return undefined;
  return { count, kinds: [...new Set(runs.flatMap((run) => run.issue_kinds))] };
}

/** "2 issues in its tasks: N+1, Long transaction". */
export function runIssuesLabel({ count, kinds }: RunIssues): string {
  const names = kinds.map((kind) => ISSUE_LABELS[kind]).join(", ");
  return `${count} ${count === 1 ? "issue" : "issues"} in its tasks${names ? `: ${names}` : ""}`;
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
  onSelect: (id: string) => void;
}

export function TraceList({ rows, selectedId, currentId, newIds, compact, services, onSelect }: TraceListProps) {
  return (
    <ul className="dt-requests" data-compact={compact ? "" : undefined}>
      {rows.map(({ trace, depth = 0, trigger, target, run, runIssues: below }) => (
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
              {compact ? <CompactMeta trace={trace} below={below} /> : <FullMeta trace={trace} below={below} />}
            </span>
          </button>
        </li>
      ))}
    </ul>
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
function CompactMeta({ trace, below }: { trace: TraceSummary; below: RunIssues | undefined }) {
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
      <CompactChips kinds={trace.issue_kinds} issues={trace.issues} below={below} />
    </>
  );
}

/** The wide list's numbers after the time: the queries, every finding, when it happened. */
function FullMeta({ trace, below }: { trace: TraceSummary; below: RunIssues | undefined }) {
  return (
    <>
      <span>{trace.kind === "page" ? "" : `${trace.queries} ${trace.queries === 1 ? "query" : "queries"}`}</span>
      <FullChips kinds={trace.issue_kinds} issues={trace.issues} />
      <RunIssuesMark issues={below} />
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
function CompactChips({
  kinds,
  issues,
  below,
}: {
  kinds: IssueKind[] | undefined;
  issues: number;
  below?: RunIssues | undefined;
}) {
  const shown = (kinds ?? []).filter((kind) => kind !== "error");
  // Findings of kinds not known yet (a row from the widget's summary, before its trace loads) count by their number.
  const count = shown.length || issues;
  const mark = <RunIssuesMark issues={below} />;
  if (count === 0) return <span className="dt-request-chips">{mark}</span>;
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
      {mark}
    </span>
  );
}

/**
 * A request's task runs found something: a mark of its own, beside (never added to) the request's own findings, an
 * outline in their amber with the corner the runs hang from, so it reads "below, in its tasks". It counts as the
 * row's own mark does, by kind; the title has every finding.
 */
function RunIssuesMark({ issues }: { issues: RunIssues | undefined }) {
  if (!issues) return null;
  const label = runIssuesLabel(issues);
  return (
    <span className="dt-run-issues" role="img" title={label} aria-label={label}>
      <CornerDownRightIcon aria-hidden="true" />
      {issues.kinds.length || issues.count}
    </span>
  );
}
