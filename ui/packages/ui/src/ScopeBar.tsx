// The filter row over a trace tab's list when the trace is a chain of calls or the list is what is under a row of
// the call tree: the scope's chip ("Under Book.author ×36", which lets go back to the whole chain) and a chip per app
// that narrows the list to it. One row on every tab that lists the chain (Logs; DB, HTTP calls and Issues next).

import { ArrowUpRightIcon, DatabaseIcon, FlameIcon, ScrollTextIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { UnderSubject } from "./CallMap";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { CloseIcon } from "./icons";
import { callsOfTab } from "./lib/callTabs";
import { scopedProfiles } from "./lib/chainProfile";
import { appRuntimes, appsOf, type Member, type SpanScope, scopedIssues, scopedLogs, scopedSpans } from "./lib/scope";
import { AppChip, IssueChip } from "./primitives";
import type { IssueKind, ScopeIssue } from "./types";

/** What is under a row of the call tree, said: its menu has "Only this span"; × goes back to the whole chain. */
function ScopeChip({ scope, onChange }: { scope: SpanScope | null; onChange: (scope: SpanScope | null) => void }) {
  if (!scope) return null;
  return (
    <li>
      <span className="dt-map-filter dt-scope-chip" data-only={scope.only ? "" : undefined}>
        <DropdownMenu>
          <DropdownMenuTrigger className="dt-scope-chip-name" title="What is under this row of the call tree">
            {scope.only ? "In" : "Under"} {scope.label}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuCheckboxItem
              checked={scope.only}
              onCheckedChange={(only) => onChange({ ...scope, only: only === true })}
            >
              Only this span
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          className="dt-map-filter-x"
          aria-label="Back to the whole chain"
          title="Back to the whole chain"
          onClick={() => onChange(null)}
        >
          <CloseIcon />
        </button>
      </span>
    </li>
  );
}

/** A chip that narrows the list to what it counts; pressed again, all of it. */
export function CountChip({
  pressed,
  count,
  onPress,
  title,
  children,
}: {
  pressed: boolean;
  count: number;
  onPress: () => void;
  title?: string | undefined;
  children: ReactNode;
}) {
  return (
    <li>
      <button type="button" className="dt-map-filter" aria-pressed={pressed} title={title} onClick={onPress}>
        {children}
        <span className="dt-map-filter-count">{count}</span>
      </button>
    </li>
  );
}

/**
 * Each app of the chain with how many of the list it has, after "All apps" with all of them: one narrows the list to
 * it. Only for two apps or more. Each the app's own chip (AppChip), as the call tree and the lists name it.
 */
function AppChips({ apps, counts, picked, onPick, runtimes }: AppPicks) {
  // An app with none of the list (a scope under the BFF's step: the browser's) has no chip.
  const some = apps.filter((app) => (counts.get(app) ?? 0) > 0 || app === picked);
  if (some.length < 2) return null;
  const all = some.reduce((sum, app) => sum + (counts.get(app) ?? 0), 0);
  return (
    <>
      <CountChip pressed={picked === null} count={all} title="Every app" onPress={() => onPick(null)}>
        All apps
      </CountChip>
      {some.map((app) => (
        <li key={app}>
          <AppChip
            name={app}
            runtime={runtimes?.get(app)}
            pick={{
              count: counts.get(app) ?? 0,
              pressed: picked === app,
              title: picked === app ? "Every app" : `Only ${app}`,
              onPress: () => onPick(picked === app ? null : app),
            }}
          />
        </li>
      ))}
    </>
  );
}

/** The apps of a list a filter picks from: each with how many of the list it has, the one picked. */
export interface AppPicks {
  apps: readonly string[];
  counts: ReadonlyMap<string, number>;
  picked: string | null;
  onPick: (app: string | null) => void;
  /** Each app's runtime label (lib/runtime traceRuntime): its mark on its chip. */
  runtimes?: ReadonlyMap<string, string | undefined> | undefined;
}

/**
 * Over every list of a trace's tabs (DB, HTTP calls, Issues, Logs, Profile), one look: the scope's chip and the
 * apps' ("All apps", then each app), when there is a scope or more than one app; one line of what the list adds up
 * to, with what the tab offers at its end; then the chips that narrow it (its issues first). Each row only when it
 * has something.
 */
export function ScopeHeader({
  scope,
  onScope,
  apps,
  summary,
  end,
  filters,
  filtersLabel,
}: {
  scope: SpanScope | null;
  onScope: (scope: SpanScope | null) => void;
  apps: AppPicks;
  /** One line: how many, their time; nothing for an empty list. */
  summary?: ReactNode;
  end?: ReactNode;
  filters?: ReactNode;
  filtersLabel?: string | undefined;
}) {
  return (
    <div className="dt-scope-head">
      <ScopeAndApps scope={scope} onScope={onScope} apps={apps} />
      <SummaryLine summary={summary} end={end} />
      {filters ? (
        <ul className="dt-scope-row" aria-label={filtersLabel}>
          {filters}
        </ul>
      ) : null}
    </div>
  );
}

/** The header's first row: the scope's chip and the apps', when there is a scope or more than one app. */
function ScopeAndApps({
  scope,
  onScope,
  apps,
}: {
  scope: SpanScope | null;
  onScope: (scope: SpanScope | null) => void;
  apps: AppPicks;
}) {
  const several = apps.apps.filter((app) => (apps.counts.get(app) ?? 0) > 0 || app === apps.picked).length > 1;
  if (!(scope || several)) return null;
  return (
    <ul className="dt-scope-row" aria-label="Scope">
      <ScopeChip scope={scope} onChange={onScope} />
      <AppChips {...apps} />
    </ul>
  );
}

/** The header's line of what the list adds up to, what the tab offers at its end. */
function SummaryLine({ summary, end }: { summary: ReactNode; end: ReactNode }) {
  if (!(summary || end)) return null;
  return (
    <div className="dt-scope-summary">
      <span className="dt-scope-summary-text">{summary}</span>
      {end ? <div className="dt-scope-summary-end">{end}</div> : null}
    </div>
  );
}

/**
 * An issue of the list as a filter: its badge ("N+1"), what it is in the UI's words, how many; its whole title on
 * hover. Pressed, the list narrows to its spans.
 */
export function IssuePick({
  kind,
  title,
  count,
  pressed,
  onPress,
}: {
  kind: IssueKind;
  title: string;
  count: number;
  pressed: boolean;
  onPress: () => void;
}) {
  return (
    <CountChip pressed={pressed} count={count} title={title} onPress={onPress}>
      <IssueChip kind={kind} />
      <span className="dt-issue-pick-title">{title.replace(/^[^:]*:\s*/, "")}</span>
    </CountChip>
  );
}

/** The chain's apps in order, and each one's runtime label: the chips AppChips draws. */
export function useChainApps(members: readonly Member[]): {
  apps: string[];
  runtimes: ReadonlyMap<string, string | undefined>;
} {
  return useMemo(() => ({ apps: appsOf(members), runtimes: appRuntimes(members) }), [members]);
}

/** Counts by a key, most first (ties in their first order). */
export function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return new Map([...counts].sort((a, b) => b[1] - a[1]));
}

/** The tabs "Inside this span" leads to, in the trace's tabs' order: each chip's icon, the tab's name in its tooltip. */
const UNDER_TABS = {
  issues: { tab: "Issues", icon: TriangleAlertIcon, noun: ["issue", "issues"] },
  sql: { tab: "DB", icon: DatabaseIcon, noun: ["query", "queries"] },
  http: { tab: "HTTP calls", icon: ArrowUpRightIcon, noun: ["HTTP call", "HTTP calls"] },
  logs: { tab: "Logs", icon: ScrollTextIcon, noun: ["log", "logs"] },
  profile: { tab: "Profile", icon: FlameIcon, noun: ["profile", "profiles"] },
} as const;

/** The tabs "Inside this span" leads to. */
export type UnderTab = keyof typeof UNDER_TABS;

/** One count of what is under a row, and the tab it opens filtered to it. */
export interface UnderCount {
  tab: UnderTab;
  count: number;
  onOpen: () => void;
}

/** A chip's words: "5 queries"; one profile is the row's "Profile". */
function underText({ tab, count }: UnderCount): string {
  if (tab === "profile" && count === 1) return "Profile";
  const [one, many] = UNDER_TABS[tab].noun;
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Under a row's details' title: what is under it, a chip each (the trace's tabs' icons and order, issues in their
 * tone), each opening its tab on the row.
 */
export function UnderThis({ counts, subject }: { counts: readonly UnderCount[]; subject: UnderSubject }) {
  const some = counts.filter((each) => each.count > 0);
  if (some.length === 0) return null;
  return (
    <div className="dt-under-this">
      <span className="dt-under-this-caption">Inside {subject}</span>
      <ul className="dt-under-this-chips" aria-label={`Inside ${subject}`}>
        {some.map((each) => {
          const { tab, icon: Icon } = UNDER_TABS[each.tab];
          return (
            <li key={each.tab}>
              <button
                type="button"
                className="dt-map-filter"
                data-tone={each.tab === "issues" ? "warn" : undefined}
                title={`Open the ${tab} tab scoped to ${subject}`}
                onClick={each.onOpen}
              >
                <Icon aria-hidden="true" />
                {underText(each)}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Whether a scope is one span with nothing under it: no span of its trace, no trace served for it. */
function isLeaf(members: readonly Member[], under: SpanScope): boolean {
  const [target] = under.targets;
  if (under.targets.length !== 1 || target === undefined) return false;
  const owner = members.find((member) => member.trace.spans.some((span) => span.id === target));
  if (!owner) return false;
  return (
    !owner.trace.spans.some((span) => span.parent_id === target) &&
    !members.some((member) => member.parent === owner.id && member.via === target)
  );
}

/**
 * What is under a row, counted for its "Inside this span" chips: its issues, queries, HTTP calls, records and
 * profiles, each count opening its tab on the scope.
 */
export function underCounts(
  members: readonly Member[],
  under: SpanScope,
  chainIssues: readonly ScopeIssue[],
  setScope: (scope: SpanScope) => void,
  open: (tab: UnderTab) => void,
): UnderCount[] {
  // A leaf (a query, a call no app answered here): nothing under it but itself.
  if (isLeaf(members, under)) return [];
  const opener = (tab: UnderTab) => () => {
    setScope(under);
    open(tab);
  };
  const issues = scopedIssues(members, under, chainIssues).filter((issue) => issue.kind !== "error");
  return [
    { tab: "issues", count: issues.length, onOpen: opener("issues") },
    { tab: "sql", count: scopedSpans(members, under, callsOfTab("sql")).length, onOpen: opener("sql") },
    { tab: "http", count: scopedSpans(members, under, callsOfTab("http")).length, onOpen: opener("http") },
    { tab: "logs", count: scopedLogs(members, under).length, onOpen: opener("logs") },
    { tab: "profile", count: scopedProfiles(members, under).length, onOpen: opener("profile") },
  ];
}
