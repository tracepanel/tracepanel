import type { IssueKind } from "./types";

export const ISSUE_LABELS: Record<IssueKind, string> = {
  "n+1": "N+1",
  duplicates: "Duplicates",
  "slow-sql": "Slow query",
  "slow-http": "Slow HTTP call",
  "slow-call": "Slow call",
  "long-transaction": "Long transaction",
  "in-transaction": "Before commit",
  htmx: "htmx",
  "queue-wait": "Queue wait",
  "blocking-call": "Blocking call",
  "large-result": "Large result",
  "migration-risk": "Migration risk",
  error: "Error",
};

/** An issue's title without the kind it starts with ("N+1: ", "Slow HTTP call: "): the kind is shown beside it. */
export function issueTitle(title: string): string {
  return title.replace(
    // Every system's ("Duplicate Redis commands", "Slow MongoDB query", "Slow gRPC call"): its chip names the kind.
    /^(N\+1|Duplicate [\w .+/-]+?|Slow [\w .+/-]+?|Long transaction|Queue wait|Blocking call in async code|Large result): /,
    "",
  );
}
