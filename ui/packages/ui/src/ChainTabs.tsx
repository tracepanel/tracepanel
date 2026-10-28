// A trace's DB, HTTP calls and Issues tabs over its scope: the whole chain of calls (each row with its app), or what
// is under a row of the call tree. Over each list the scope's chip and the apps', then what the list adds up to, each
// count a filter: the same row as the Logs tab's.

import { type ReactNode, useMemo, useState } from "react";
import { CallsList } from "./CallsList";
import type { Explain } from "./CallTable";
import { duration } from "./format";
import type { TraceScope } from "./hooks/useTraceChain";
import { IssueList } from "./IssueList";
import { callTemplate, onTheClock } from "./lib/calls";
import { CALL_TABS, callsOfTab } from "./lib/callTabs";
import { plural } from "./lib/plural";
import { type ScopedIssue, type ScopedSpan, scopedIssues, scopedSpans } from "./lib/scope";
import type { TraceLinks } from "./links";
import { AppChip } from "./primitives";
import { CountChip, countBy, IssuePick, ScopeHeader, useChainApps } from "./ScopeBar";
import { Segmented } from "./Segmented";
import { SQL_MODES, SqlList, type SqlMode, sqlKey } from "./SqlList";
import type { IssueKind, Span } from "./types";

/** The table a statement reads or writes first: what a query is about at a glance. */
function tableOf(span: Span): string | undefined {
  const statement = String(span.attrs["db.statement"] ?? span.name);
  return /\b(?:FROM|INTO|UPDATE|JOIN)\s+["`[]?([\w.]+)/i.exec(statement)?.[1];
}

/** Where a call went: a query's database, a call's host. */
function targetOf(span: Span): string {
  const target = span.attrs["db.alias"] ?? span.attrs["db.name"] ?? span.attrs["server.address"];
  return typeof target === "string" ? target : "";
}

/** What narrows a list of calls beyond its scope: an app, a target, a table, the spans of an issue. */
interface CallPicks {
  app: string | null;
  target: string | null;
  table: string | null;
  issue: string | null;
}

const NO_PICKS: CallPicks = { app: null, target: null, table: null, issue: null };

function pickedCalls(spans: readonly ScopedSpan[], picks: CallPicks, issues: readonly ScopedIssue[]): ScopedSpan[] {
  const issue = issues.find((each) => each.fingerprint === picks.issue);
  const ids = new Set(issue?.span_ids ?? []);
  return spans.filter(
    (span) =>
      (picks.app === null || span.app === picks.app) &&
      (picks.target === null || targetOf(span) === picks.target) &&
      (picks.table === null || tableOf(span) === picks.table) &&
      (!issue || ids.has(span.id)),
  );
}

/** A chip a count of the list is: pressed, the list narrows to it; pressed again, all of it. */
function PickChips({
  counts,
  picked,
  onPick,
  title,
  mono = false,
}: {
  counts: ReadonlyMap<string, number>;
  picked: string | null;
  onPick: (value: string | null) => void;
  title: (value: string) => string;
  mono?: boolean;
}) {
  // One value only says nothing a filter could narrow.
  if (counts.size < 2 && picked === null) return null;
  return [...counts].slice(0, 6).map(([value, count]) => (
    <CountChip
      key={value}
      pressed={picked === value}
      count={count}
      title={title(value)}
      onPress={() => onPick(picked === value ? null : value)}
    >
      {mono ? <span className="font-mono">{value}</span> : value}
    </CountChip>
  ));
}

/** The issues of a list's spans that repeat (an N+1, duplicates), each a chip that narrows the list to its spans. */
function RepeatChips({
  issues,
  picked,
  onPick,
}: {
  issues: readonly ScopedIssue[];
  picked: string | null;
  onPick: (fingerprint: string | null) => void;
}) {
  return issues.map((issue) => (
    <IssuePick
      key={issue.fingerprint}
      kind={issue.kind}
      title={issue.title}
      count={issue.occurrences}
      pressed={picked === issue.fingerprint}
      onPress={() => onPick(picked === issue.fingerprint ? null : issue.fingerprint)}
    />
  ));
}

/**
 * A list's calls at a glance, one line: how many, how many unique, their time on the clock (overlaps once, the sum
 * on hover), the slowest.
 */
function CallStats({ tab, spans, noun }: { tab: string; spans: readonly ScopedSpan[]; noun: [string, string] }) {
  if (spans.length === 0) return null;
  const total = spans.reduce((sum, span) => sum + span.duration, 0);
  const slowest = Math.max(...spans.map((span) => span.duration));
  const unique = new Set(spans.map((span) => (tab === "sql" ? sqlKey(span) : callTemplate(span)))).size;
  return (
    <>
      {spans.length} {spans.length === 1 ? noun[0] : noun[1]} · {unique} unique ·{" "}
      <span title={`${duration(total)} total`}>{duration(onTheClock(spans))}</span> on the clock · slowest{" "}
      {duration(slowest)}
    </>
  );
}

/**
 * Over a calls tab's list (ScopeHeader): the scope's chip and the apps'; what the calls add up to; its N+1s and
 * repeats, its targets and tables, each a filter.
 */
function CallsHeader({
  chain,
  tab,
  spans,
  inApp,
  shown,
  repeats,
  picks,
  onPick,
  noun,
  end,
}: {
  chain: TraceScope;
  tab: string;
  spans: readonly ScopedSpan[];
  inApp: readonly ScopedSpan[];
  shown: readonly ScopedSpan[];
  repeats: readonly ScopedIssue[];
  picks: CallPicks;
  onPick: (picks: CallPicks) => void;
  noun: [string, string];
  end: ReactNode;
}) {
  const { apps, runtimes } = useChainApps(chain.members);
  const appCounts = useMemo(() => countBy(spans, (span) => span.app), [spans]);
  return (
    <ScopeHeader
      scope={chain.scope}
      onScope={chain.setScope}
      apps={{ apps, runtimes, counts: appCounts, picked: picks.app, onPick: (app) => onPick({ ...picks, app }) }}
      summary={<CallStats tab={tab} spans={shown} noun={noun} />}
      end={shown.length > 0 ? end : null}
      filtersLabel="What the calls add up to"
      // A trace with no traces down its calls, nothing under a row asked for: its list as it always was, its line.
      filters={
        inApp.length > 0 && (chain.members.length > 1 || chain.scope) ? (
          <>
            <RepeatChips issues={repeats} picked={picks.issue} onPick={(issue) => onPick({ ...picks, issue })} />
            <PickChips
              counts={countBy(inApp, targetOf)}
              picked={picks.target}
              onPick={(target) => onPick({ ...picks, target })}
              title={(target) => `Only ${target}`}
            />
            {tab === "sql" ? (
              <PickChips
                counts={countBy(
                  inApp.filter((span) => tableOf(span)),
                  (span) => tableOf(span) ?? "",
                )}
                picked={picks.table}
                onPick={(table) => onPick({ ...picks, table })}
                title={(table) => `Only queries on ${table}`}
                mono={true}
              />
            ) : null}
          </>
        ) : null
      }
    />
  );
}

/**
 * A DB, Cache or HTTP calls tab over the trace's scope: the scope's chip and the apps', what the calls add up to
 * (each a filter), then the list, grouped by what repeats across the chain (`SELECT author` ×36 in 36 traces).
 */
export function ScopedCalls({
  tab,
  chain,
  issueBySpan,
  focus,
  onExplain,
  links,
}: {
  tab: string;
  chain: TraceScope;
  issueBySpan: ReadonlyMap<string, IssueKind>;
  focus: ReadonlySet<string> | undefined;
  onExplain: Explain | undefined;
  links: TraceLinks | undefined;
}) {
  const [picks, setPicks] = useState<CallPicks>(NO_PICKS);
  const of = callTab(tab);
  const spans = useMemo(
    () => scopedSpans(chain.members, chain.scope, callsOfTab(tab)),
    [chain.members, chain.scope, tab],
  );
  const repeats = useMemo(() => {
    const ids = new Set(spans.map((span) => span.id));
    return scopedIssues(chain.members, chain.scope, chain.chainIssues).filter(
      (issue) => (issue.kind === "n+1" || issue.kind === "duplicates") && issue.span_ids.some((span) => ids.has(span)),
    );
  }, [spans, chain.members, chain.scope, chain.chainIssues]);
  const inApp = useMemo(
    () => pickedCalls(spans, { ...NO_PICKS, app: picks.app }, repeats),
    [spans, picks.app, repeats],
  );
  const shown = useMemo(() => pickedCalls(spans, picks, repeats), [spans, picks, repeats]);
  const [mode, setMode] = useState<SqlMode>("grouped");
  const sql = tab === "sql";
  return (
    <>
      <CallsHeader
        chain={chain}
        tab={tab}
        spans={spans}
        inApp={inApp}
        shown={shown}
        repeats={repeats}
        picks={picks}
        onPick={setPicks}
        noun={of.noun}
        end={sql ? <Segmented label="Queries shown" segments={SQL_MODES} value={mode} onChange={setMode} /> : null}
      />
      <CallsOf spans={shown} empty={emptyCalls(of.empty, chain.scope !== null)}>
        {sql ? (
          <SqlList
            spans={shown}
            issueBySpan={issueBySpan}
            focus={focus}
            onExplain={onExplain}
            links={links}
            mode={mode}
          />
        ) : (
          <CallsList spans={shown} issueBySpan={issueBySpan} focus={focus} table={`trace-${tab}`} />
        )}
      </CallsOf>
    </>
  );
}

/** What a calls tab lists: its system, its noun, what it says when empty. */
function callTab(tab: string) {
  return CALL_TABS[tab] ?? { system: tab, noun: ["call", "calls"], empty: "No calls" };
}

/** What says there is nothing in a calls tab's list: under a row, or in the whole request. */
function emptyCalls(empty: string, scoped: boolean): string {
  return scoped ? `${empty} under this.` : `${empty} in this request.`;
}

/** The list, or what says there is nothing in it. */
function CallsOf({ spans, empty, children }: { spans: readonly Span[]; empty: string; children: ReactNode }) {
  if (spans.length === 0) return <p className="dt-note">{empty}</p>;
  return children;
}

/** What an issue is across the scope: its apps, and in how many traces how many times. */
function IssueReach({ issue, runtimes }: { issue: ScopedIssue; runtimes: ReadonlyMap<string, string | undefined> }) {
  return (
    <span className="dt-issue-reach">
      {issue.apps.map((app) => (
        <AppChip key={app} name={app} runtime={runtimes.get(app)} />
      ))}
      <span className="text-muted-foreground">
        {issue.chain
          ? "across apps"
          : `in ${issue.traces} ${issue.traces === 1 ? "trace" : "traces"} · ×${issue.occurrences}`}
      </span>
    </span>
  );
}

/** "3 issues", or "1 of 3 issues" with an app picked. */
function issueCount(shown: number, all: number): string {
  return shown === all ? plural(all, "issue", "issues") : `${shown} of ${plural(all, "issue", "issues")}`;
}

/**
 * The Issues tab over the trace's scope: every trace's issues, one per fingerprint with its apps and how many
 * traces have it, and the chain's N+1 across apps; the worst first. "Show" opens the call tree at its first span.
 */
export function ScopedIssues({
  chain,
  links,
  onShowRow,
}: {
  chain: TraceScope;
  links: TraceLinks | undefined;
  onShowRow: (row: string) => void;
}) {
  const issues = useMemo(
    () => scopedIssues(chain.members, chain.scope, chain.chainIssues).filter((issue) => issue.kind !== "error"),
    [chain.members, chain.scope, chain.chainIssues],
  );
  const { apps, runtimes } = useChainApps(chain.members);
  const [app, setApp] = useState<string | null>(null);
  const shown = issues.filter((issue) => app === null || issue.apps.includes(app));
  const counts = countBy(
    issues.flatMap((issue) => issue.apps.map((each) => ({ app: each }))),
    (each) => each.app,
  );
  return (
    <>
      <ScopeHeader
        scope={chain.scope}
        onScope={chain.setScope}
        apps={{ apps, runtimes, counts, picked: app, onPick: setApp }}
        summary={shown.length > 0 ? issueCount(shown.length, issues.length) : null}
      />
      {shown.length === 0 ? (
        <p className="dt-note">{chain.scope ? "No issues under this." : "No issues in this request."}</p>
      ) : (
        <IssueList
          issues={shown}
          reach={(issue) => <IssueReach issue={issue as ScopedIssue} runtimes={runtimes} />}
          onShowSpans={(ids) => ids[0] && onShowRow(ids[0])}
          showLabel={() => "In the call tree"}
          links={links}
        />
      )}
    </>
  );
}
