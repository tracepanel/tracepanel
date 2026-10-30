// What a trace's chain of calls adds up to, as its tabs count it in the panel: the queries (DB), the HTTP calls and the
// issues of every trace down its calls. The page's pill says them for a browser's view, whose own trace has none: its
// calls went to other apps, and what they did is theirs. The panel's list says the same on each row: a row with a
// chain under it (the view's, an app's, a run's) what all of it did, a trace with nothing under it its own.

import type { Chain, IssueKind, ScopeIssue } from "../types";
import { callsOfTab } from "./callTabs";
import { type Member, membersOf, scopedIssues, scopedSpans } from "./scope";

export interface ChainCounts {
  queries: number;
  calls: number;
  /**
   * What could be better (the Issues tab's: one per finding, however many traces have it), the chain's N+1 across
   * apps too; errors are the Error tab's.
   */
  issues: number;
  /** Their kinds, the worst first. */
  kinds: IssueKind[];
  /** How many traces the chain has, the view's own among them. */
  traces: number;
}

/** What some traces of a chain add up to (`chain`: the chain's own issues, kept for the traces among them). */
export function countsOf(members: readonly Member[], chain: readonly ScopeIssue[]): ChainCounts {
  const count = (tab: string) => scopedSpans(members, null, callsOfTab(tab)).length;
  const issues = scopedIssues(members, null, chain).filter((issue) => issue.kind !== "error");
  return {
    queries: count("sql"),
    calls: count("http"),
    issues: issues.length,
    kinds: [...new Set(issues.map((issue) => issue.kind))],
    traces: members.length,
  };
}

/** The chain's counts, from `GET /traces/{id}/chain` (its first trace is the one asked for). */
export function chainCounts(chain: Chain): ChainCounts | null {
  const first = chain.traces[0]?.trace;
  if (!first) return null;
  return countsOf(membersOf(first, undefined, chain.traces), chain.issues);
}
