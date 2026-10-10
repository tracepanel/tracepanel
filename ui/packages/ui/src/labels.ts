import type { IssueKind } from "./types";

export const ISSUE_LABELS: Record<IssueKind, string> = {
  "n+1": "N+1",
  duplicates: "Duplicates",
  "slow-sql": "Slow query",
  "long-transaction": "Long transaction",
  "in-transaction": "Before commit",
  htmx: "htmx",
  error: "Error",
};
