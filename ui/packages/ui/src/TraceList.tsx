import { ago, duration } from "./format";
import { DatabaseIcon } from "./icons";
import { ISSUE_LABELS } from "./labels";
import { IssueChip, MethodBadge, RoutePath, StatusBadge } from "./primitives";
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
  onSelect: (id: string) => void;
}

export function TraceList({ rows, selectedId, currentId, newIds, compact, onSelect }: TraceListProps) {
  return (
    <ul className="dt-requests" data-compact={compact ? "" : undefined}>
      {rows.map(({ trace, depth = 0, trigger, target }) => (
        <li key={trace.id}>
          <button
            type="button"
            className="dt-request-row"
            data-depth={depth}
            data-tone={trace.status === "error" ? "error" : trace.issues > 0 ? "warn" : "ok"}
            aria-current={trace.id === selectedId ? "true" : undefined}
            data-new={newIds?.has(trace.id) ? "" : undefined}
            onClick={() => onSelect(trace.id)}
          >
            <span className="dt-request-main">
              {/* A GraphQL request is its operation ("GraphQL query PostList"), not POST /graphql/. */}
              <MethodBadge
                method={trace.name.startsWith("GraphQL ") ? "GQL" : (trace.method ?? trace.name.split(" ")[0])}
                htmx={trace.htmx}
              />
              <span className="dt-request-path">
                {trace.name.startsWith("GraphQL ")
                  ? trace.name.slice("GraphQL ".length)
                  : (trace.path ?? <RoutePath path={trace.name.split(" ").slice(1).join(" ")} />)}
                {/* An htmx request: the element that sent it and where the answer went, after the path. */}
                {trigger ? (
                  <span className="dt-request-trigger">
                    {" "}
                    · {trigger}
                    {target ? ` → ${target}` : ""}
                  </span>
                ) : null}
              </span>
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
              <StatusBadge status={trace.http_status} />
              <span>{duration(trace.duration)}</span>
              {compact ? (
                // A column of numbers: the database icon says what they count, the tooltip spells it out.
                <span
                  className="dt-request-queries"
                  data-zero={trace.queries === 0 ? "" : undefined}
                  title={`${trace.queries} SQL ${trace.queries === 1 ? "query" : "queries"}`}
                >
                  <DatabaseIcon size={12} />
                  {trace.queries}
                </span>
              ) : (
                <span>{`${trace.queries} ${trace.queries === 1 ? "query" : "queries"}`}</span>
              )}
              {compact ? (
                <CompactChips kinds={trace.issue_kinds} issues={trace.issues} />
              ) : (
                <>
                  {(trace.issue_kinds ?? []).map((kind) => (
                    <IssueChip key={kind} kind={kind} />
                  ))}
                  {trace.issue_kinds === undefined && trace.issues > 0 ? (
                    <span className="dt-chip" data-kind="n+1">
                      {trace.issues} {trace.issues === 1 ? "issue" : "issues"}
                    </span>
                  ) : null}
                </>
              )}
              {compact ? null : <span className="dt-request-time">{ago(trace.start)}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The narrow list's last column (empty on a clean row, so the columns stay in place): the first finding, "+N" for
 * the rest, all of them in the tooltip. An error shows as its status and the red edge, not here.
 */
function CompactChips({ kinds, issues }: { kinds: IssueKind[] | undefined; issues: number }) {
  const shown = (kinds ?? []).filter((kind) => kind !== "error");
  const [first, ...rest] = shown;
  return (
    <span className="dt-request-chips" title={shown.map((kind) => ISSUE_LABELS[kind]).join(", ") || undefined}>
      {first ? (
        <IssueChip kind={first} />
      ) : issues > 0 ? (
        // Findings of kinds not known yet (a row from the widget's summary, before its trace loads): their count.
        <span className="dt-chip" data-kind="n+1">
          {issues} {issues === 1 ? "issue" : "issues"}
        </span>
      ) : null}
      {rest.length > 0 ? <span className="dt-request-chips-more">+{rest.length}</span> : null}
    </span>
  );
}
