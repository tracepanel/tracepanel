// The filter row over a trace tab's list when the trace is a chain of calls or the list is what is under a row of
// the call tree: the scope's chip ("Under Book.author ×36", which lets go back to the whole chain) and a chip per app
// that narrows the list to it. One row on every tab that lists the chain (Logs; DB, HTTP calls and Issues next).

import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { CloseIcon } from "./icons";
import { callsOfTab } from "./lib/callTabs";
import { scopedProfiles } from "./lib/chainProfile";
import { type Member, type SpanScope, scopedIssues, scopedLogs, scopedSpans } from "./lib/scope";
import type { ScopeIssue } from "./types";

/** What is under a row of the call tree, said: its menu has "Only this span"; × goes back to the whole chain. */
export function ScopeChip({
  scope,
  onChange,
}: {
  scope: SpanScope | null;
  onChange: (scope: SpanScope | null) => void;
}) {
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

/** Each app of the chain with how many of the list it has: one narrows the list to it. Only for two apps or more. */
export function AppChips({
  apps,
  counts,
  picked,
  onPick,
}: {
  apps: readonly string[];
  counts: ReadonlyMap<string, number>;
  picked: string | null;
  onPick: (app: string | null) => void;
}) {
  // An app with none of the list (a scope under the BFF's step: the browser's) has no chip.
  const some = apps.filter((app) => (counts.get(app) ?? 0) > 0 || app === picked);
  if (some.length < 2) return null;
  return some.map((app) => (
    <CountChip
      key={app}
      pressed={picked === app}
      count={counts.get(app) ?? 0}
      title={picked === app ? "Every app" : `Only ${app}`}
      onPress={() => onPick(picked === app ? null : app)}
    >
      {app}
    </CountChip>
  ));
}

/** Counts by a key, most first (ties in their first order). */
export function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return new Map([...counts].sort((a, b) => b[1] - a[1]));
}

/** One count of what is under a row, and the tab it opens filtered to it. */
export interface UnderCount {
  noun: [one: string, many: string];
  count: number;
  onOpen: () => void;
}

/** Over a row's details in the call tree: what is under it, each count a way to the tab that lists it. */
export function UnderThis({ counts }: { counts: readonly UnderCount[] }) {
  const some = counts.filter((each) => each.count > 0);
  if (some.length === 0) return null;
  return (
    <p className="dt-under-this">
      <span className="text-muted-foreground">Under this:</span>
      {some.map((each, index) => (
        <span key={each.noun[1]}>
          {index > 0 ? <span className="text-muted-foreground"> · </span> : null}
          <button type="button" className="dt-under-this-link" onClick={each.onOpen}>
            {each.count} {each.count === 1 ? each.noun[0] : each.noun[1]}
          </button>
        </span>
      ))}
    </p>
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

/** The tabs "Under this" leads to. */
export type UnderTab = "sql" | "http" | "logs" | "issues" | "profile";

/**
 * What is under a row, counted for its "Under this" line: its queries, HTTP calls, records and issues, each count
 * opening its tab on the scope.
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
    { noun: ["query", "queries"], count: scopedSpans(members, under, callsOfTab("sql")).length, onOpen: opener("sql") },
    {
      noun: ["HTTP call", "HTTP calls"],
      count: scopedSpans(members, under, callsOfTab("http")).length,
      onOpen: opener("http"),
    },
    { noun: ["log", "logs"], count: scopedLogs(members, under).length, onOpen: opener("logs") },
    { noun: ["issue", "issues"], count: issues.length, onOpen: opener("issues") },
    { noun: ["profile", "profiles"], count: scopedProfiles(members, under).length, onOpen: opener("profile") },
  ];
}
