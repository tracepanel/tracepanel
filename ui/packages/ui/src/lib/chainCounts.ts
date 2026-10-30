// What a trace's chain of calls adds up to, as its tabs count it in the panel: the queries (DB), the HTTP calls and the
// issues of every trace down its calls. The page's pill says them for a browser's view, whose own trace has none: its
// calls went to other apps, and what they did is theirs.

import type { Chain } from "../types";
import { callsOfTab } from "./callTabs";
import { membersOf, scopedIssues, scopedSpans } from "./scope";

export interface ChainCounts {
  queries: number;
  calls: number;
  /** What could be better (the Issues tab's), the chain's N+1 across apps too; errors are the Error tab's. */
  issues: number;
  /** How many traces the chain has, the view's own among them. */
  traces: number;
}

/** The chain's counts, from `GET /traces/{id}/chain` (its first trace is the one asked for). */
export function chainCounts(chain: Chain): ChainCounts | null {
  const first = chain.traces[0]?.trace;
  if (!first) return null;
  const members = membersOf(first, undefined, chain.traces);
  const count = (tab: string) => scopedSpans(members, null, callsOfTab(tab)).length;
  const issues =
    members.length < 2
      ? first.issues.filter((issue) => issue.kind !== "error").length
      : scopedIssues(members, null, chain.issues).filter((issue) => issue.kind !== "error").length;
  return { queries: count("sql"), calls: count("http"), issues, traces: members.length };
}
