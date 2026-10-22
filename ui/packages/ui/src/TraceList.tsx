import { TriangleAlertIcon } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { ago, duration } from "./format";
import { DatabaseIcon } from "./icons";
import { ISSUE_LABELS } from "./labels";
import { pageParts } from "./lib/page";
import { AppChip, IssueChip, KindBadge, MethodBadge, RoutePath, StatusBadge, TaskName } from "./primitives";
import type { IssueKind, TraceSummary } from "./types";

export interface TraceRow {
  trace: TraceSummary;
  /** 1 for fetch/XHR requests shown under their page. */
  depth?: 0 | 1 | undefined;
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
  onSelect: (id: string) => void;
}

export function TraceList({ rows, selectedId, currentId, newIds, compact, services, onSelect }: TraceListProps) {
  return (
    <ul className="dt-requests" data-compact={compact ? "" : undefined}>
      {rows.map(({ trace, depth = 0, trigger, target }) => (
        <li key={trace.id}>
          <button
            type="button"
            className="dt-request-row"
            data-depth={depth}
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
              {trace.kind === "page" ? <span /> : <StatusBadge status={trace.http_status} />}
              <span>{duration(trace.duration)}</span>
              {compact ? <CompactMeta trace={trace} /> : <FullMeta trace={trace} />}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
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
  // Findings of kinds not known yet (a row from the widget's summary, before its trace loads) count by their number.
  const count = shown.length || issues;
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
