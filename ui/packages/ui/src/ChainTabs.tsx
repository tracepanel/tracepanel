// A trace's DB, HTTP calls and Issues tabs over its scope: the whole chain of calls (each row with its app), or what
// is under a row of the call tree. Over each list the scope's chip and the apps', then what the list adds up to, each
// count a filter: the same row as the Logs tab's.

import { type ReactNode, useMemo, useState } from "react";
import { CallsList } from "./CallsList";
import type { Explain } from "./CallTable";
import { duration } from "./format";
import type { TraceScope } from "./hooks/useTraceChain";
import { IssueList } from "./IssueList";
import { onTheClock } from "./lib/calls";
import { CALL_TABS, callsOfTab } from "./lib/callTabs";
import { appsOf, type ScopedIssue, type ScopedSpan, scopedIssues, scopedSpans } from "./lib/scope";
import type { TraceLinks } from "./links";
import { AppChip } from "./primitives";
import { AppChips, CountChip, countBy, ScopeChip } from "./ScopeBar";
import { SqlList } from "./SqlList";
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
    <CountChip
      key={issue.fingerprint}
      pressed={picked === issue.fingerprint}
      count={issue.occurrences}
      title={issue.title}
      onPress={() => onPick(picked === issue.fingerprint ? null : issue.fingerprint)}
    >
      <span className="text-warn">{issue.kind === "n+1" ? "N+1" : "Repeated"}</span>
      <span className="dt-calls-repeat">{issue.title.replace(/^[^:]*:\s*/, "")}</span>
    </CountChip>
  ));
}

/** A list's calls at a glance: how many, their time, on the clock (overlaps once), the slowest. */
function CallStats({ spans, noun }: { spans: readonly ScopedSpan[]; noun: [string, string] }) {
  const total = spans.reduce((sum, span) => sum + span.duration, 0);
  const slowest = spans.reduce<ScopedSpan | undefined>(
    (worst, span) => (!worst || span.duration > worst.duration ? span : worst),
    undefined,
  );
  return (
    <li className="dt-calls-stats">
      <b>{spans.length}</b> {spans.length === 1 ? noun[0] : noun[1]} ·{" "}
      <b title={`${duration(total)} total`}>{duration(onTheClock(spans))}</b> on the clock
      {slowest ? (
        <>
          {" "}
          · slowest <b>{duration(slowest.duration)}</b> <AppChip name={slowest.app} />
        </>
      ) : null}
    </li>
  );
}

/** Over a calls tab's list: the scope's chip and the apps', then what the calls add up to, each a filter. */
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
}) {
  const apps = useMemo(() => appsOf(chain.members), [chain.members]);
  const appCounts = useMemo(() => countBy(spans, (span) => span.app), [spans]);
  // A trace with no traces down its calls, nothing under a row asked for: its list as it always was.
  if (chain.members.length < 2 && chain.scope === null) return null;
  return (
    <div className="dt-scope-bar dt-scope-bar-calls">
      {chain.scope || apps.length > 1 ? (
        <ul className="dt-breakdown-legend" aria-label="Scope">
          <ScopeChip scope={chain.scope} onChange={chain.setScope} />
          <AppChips apps={apps} counts={appCounts} picked={picks.app} onPick={(app) => onPick({ ...picks, app })} />
        </ul>
      ) : null}
      {inApp.length > 0 ? (
        <ul className="dt-breakdown-legend" aria-label="What the calls add up to">
          <CallStats spans={shown} noun={noun} />
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
          <RepeatChips issues={repeats} picked={picks.issue} onPick={(issue) => onPick({ ...picks, issue })} />
        </ul>
      ) : null}
    </div>
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
  const of = CALL_TABS[tab] ?? { system: tab, noun: ["call", "calls"], empty: "No calls" };
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
      />
      <CallsOf tab={tab} spans={shown} empty={chain.scope ? `${of.empty} under this.` : `${of.empty} in this request.`}>
        {tab === "sql" ? (
          <SqlList spans={shown} issueBySpan={issueBySpan} focus={focus} onExplain={onExplain} links={links} />
        ) : (
          <CallsList spans={shown} issueBySpan={issueBySpan} focus={focus} table={`trace-${tab}`} />
        )}
      </CallsOf>
    </>
  );
}

/** The list, or what says there is nothing in it. */
function CallsOf({
  spans,
  empty,
  children,
}: {
  tab: string;
  spans: readonly Span[];
  empty: string;
  children: ReactNode;
}) {
  if (spans.length === 0) return <p className="dt-note">{empty}</p>;
  return children;
}

/** What an issue is across the scope: its apps, and in how many traces how many times. */
function IssueReach({ issue }: { issue: ScopedIssue }) {
  return (
    <span className="dt-issue-reach">
      {issue.apps.map((app) => (
        <AppChip key={app} name={app} />
      ))}
      <span className="text-muted-foreground">
        {issue.chain
          ? "across apps"
          : `in ${issue.traces} ${issue.traces === 1 ? "trace" : "traces"} · ×${issue.occurrences}`}
      </span>
    </span>
  );
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
  const apps = useMemo(() => appsOf(chain.members), [chain.members]);
  const [app, setApp] = useState<string | null>(null);
  const shown = issues.filter((issue) => app === null || issue.apps.includes(app));
  return (
    <>
      {chain.scope || apps.length > 1 ? (
        <div className="dt-scope-bar dt-scope-bar-calls">
          <ul className="dt-breakdown-legend" aria-label="Scope">
            <ScopeChip scope={chain.scope} onChange={chain.setScope} />
            <AppChips
              apps={apps}
              counts={countBy(
                issues.flatMap((issue) => issue.apps.map((each) => ({ app: each }))),
                (each) => each.app,
              )}
              picked={app}
              onPick={setApp}
            />
          </ul>
        </div>
      ) : null}
      {shown.length === 0 ? (
        <p className="dt-note">{chain.scope ? "No issues under this." : "No issues in this request."}</p>
      ) : (
        <IssueList
          issues={shown}
          reach={(issue) => <IssueReach issue={issue as ScopedIssue} />}
          onShowSpans={(ids) => ids[0] && onShowRow(ids[0])}
          showLabel={() => "In the call tree"}
          links={links}
        />
      )}
    </>
  );
}
