import { DatabaseIcon } from "./icons";
import { IssueChip } from "./primitives";
import type { TraceSummary } from "./types";

/**
 * What a linked trace holds, as the lists show it: each finding by name, then its queries. On the row that leads to
 * it (a task's run in the call tree, a related trace), so its N+1 is seen before it is opened. Its time and state are
 * the row's own.
 */
export function RunChips({ trace }: { trace: TraceSummary }) {
  if (trace.issue_kinds.length === 0 && trace.queries === 0) return null;
  return (
    <span className="dt-run-chips">
      {trace.issue_kinds.map((kind) => (
        <IssueChip key={kind} kind={kind} />
      ))}
      <Queries count={trace.queries} />
    </span>
  );
}

/** Its SQL queries, as the narrow list counts them: the database icon and how many. */
function Queries({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="dt-request-queries" title={`${count} SQL ${count === 1 ? "query" : "queries"}`}>
      <DatabaseIcon size={12} />
      {count}
    </span>
  );
}
