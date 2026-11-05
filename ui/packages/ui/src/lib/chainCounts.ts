// What a trace's chain of calls adds up to, as its tabs count it in the panel: the queries (DB), the HTTP calls and the
// issues of every trace down its calls. The page's pill says them for a browser's view, whose own trace has none: its
// calls went to other apps, and what they did is theirs. The panel's list says the same on each row: a row with a
// chain under it (the view's, an app's, a run's) what all of it did, a trace with nothing under it its own.

import type { Chain, IssueKind, ScopeIssue } from "../types";
import { CALL_TABS, callsOfTab } from "./callTabs";
import { plural } from "./plural";
import { type Member, membersOf, scopedIssues, scopedSpans } from "./scope";

/** What a row of a list says of its whole chain, as the agent's list answers it, or counted from the chain. */
export type RowCounts = Pick<ChainCounts, "queries" | "issues" | "kinds" | "traces">;

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
  /** Of `calls`, the first trace's own (the view's, the request's): the rest are the apps' it called. */
  ownCalls: number;
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
    ownCalls: members[0] ? scopedSpans(members.slice(0, 1), null, callsOfTab("http")).length : 0,
  };
}

/**
 * What a chain's count of a tab's calls covers, said where the count shows (a tab's tooltip, the pill's): "23 HTTP
 * calls down its chain of calls: 3 by this view, 20 by the apps it called". A count of its own alone when the apps it
 * called made none. `whose`: "this view", "this request".
 */
export function chainScope(tab: string, total: number, own: number, whose: string): string {
  const [one, many] = CALL_TABS[tab]?.noun ?? ["call", "calls"];
  const all = plural(total, one, many);
  if (own >= total) return all;
  return `${all} down its chain of calls: ${own} by ${whose}, ${total - own} by the apps it called`;
}

/** What a trace is to its own chain, in words: "this view", "this request". */
export function whoseOwn(kind: string): string {
  if (kind === "page") return "this view";
  if (kind === "http" || kind === "rpc") return "this request";
  return kind === "task" ? "this task" : "this trace";
}

/** The chain's counts, from `GET /traces/{id}/chain` (its first trace is the one asked for). */
export function chainCounts(chain: Chain): ChainCounts | null {
  const first = chain.traces[0]?.trace;
  if (!first) return null;
  return countsOf(membersOf(first, undefined, chain.traces), chain.issues);
}
