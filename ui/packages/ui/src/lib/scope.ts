// A trace's scope: the chain of calls under it (the traces other apps served for its calls, theirs in turn) on its
// clock, and the part of it under some of its rows. The trace's tabs list and add up what is in it; the agent's
// `GET /traces/{id}/logs?span=&only=` takes the same scope (crates/store-local/src/scope.rs), and so do the MCP tools.

import type { ChainTrace, Issue, Log, Related, ScopeIssue, Span, Trace } from "../types";
import { traceRuntime } from "./runtime";

/** One trace of a chain, on the chain's clock: the trace above it and its span whose call it served. */
export interface Member {
  id: string;
  app: string;
  parent: string | null;
  via: string | null;
  trace: Trace;
}

/**
 * What is under some rows of the call tree: their span ids (a group's spans), or a trace's id for the whole of that
 * trace (a call's trace as a row). `only`: what is in those spans themselves, not in a span or a trace under them.
 * `label` says it on the scope's chip ("Book.author ×36").
 */
export interface SpanScope {
  targets: readonly string[];
  label: string;
  only: boolean;
}

/** A record of a scope, with its trace and the app that logged it. */
export type ScopedLog = Log & { traceId: string; app: string };

export function appOf(trace: Trace): string {
  const service = trace.attrs["service.name"];
  return typeof service === "string" ? service : "";
}

/** A trace with every time in it moved by `by` µs. */
export function shifted(trace: Trace, by: number): Trace {
  if (by === 0) return trace;
  return {
    ...trace,
    start: trace.start + by,
    spans: trace.spans.map((span) => ({ ...span, start: span.start + by })),
    logs: trace.logs.map((log) => ({ ...log, time: log.time + by })),
    errors: trace.errors.map((error) => ({ ...error, time: error.time + by })),
  };
}

/** How far a call's trace moves to sit centred in the call (as the call tree draws it). */
function shiftInto(call: Span, served: Trace): number {
  return Math.round(call.start + Math.max(call.duration - served.duration, 0) / 2 - served.start);
}

/** The traces the trace's own links bring whole (one level of the chain), while the whole chain hasn't come. */
function nextLevel(trace: Trace, related: Related | undefined): Member[] {
  if (!related) return [];
  const spans = new Map(trace.spans.map((span) => [span.id, span]));
  const via = new Map<string, { span: string; project?: string | undefined }>([
    ...related.calls.flatMap((call) => {
      const span = related.via[call.id];
      return span ? [[call.id, { span }] as const] : [];
    }),
    ...(related.remote_calls ?? []).map(
      (call) => [call.trace.id, { span: call.span_id, project: call.project }] as const,
    ),
  ]);
  return [...via].flatMap(([id, { span, project }]) => {
    const whole = related.call_traces?.[id];
    if (!whole) return [];
    const call = spans.get(span);
    const placed = call ? shifted(whole, shiftInto(call, whole)) : whole;
    return [{ id, app: project ?? appOf(whole), parent: trace.id, via: span, trace: placed }];
  });
}

/**
 * The trace's chain: as the agent walked it (`loaded`), or, before that came (or where nothing walks it: a
 * snapshot), the trace and the calls' traces its links bring whole. The trace itself is the one on screen.
 */
export function membersOf(trace: Trace, related: Related | undefined, loaded: readonly ChainTrace[] | undefined) {
  const root: Member = { id: trace.id, app: appOf(trace), parent: null, via: null, trace };
  if (loaded && loaded[0]?.id === trace.id) {
    return [
      root,
      ...loaded
        .slice(1)
        .flatMap((each) =>
          each.trace ? [{ id: each.id, app: each.app, parent: each.parent, via: each.via, trace: each.trace }] : [],
        ),
    ];
  }
  return [root, ...nextLevel(trace, related)];
}

/** What of one trace a scope takes: all of it, or some spans (a record in no span counts by its time). */
type Part =
  | "whole"
  | { ids: ReadonlySet<string>; windows: [number, number][]; outside: [number, number][] }
  | undefined;

/** A span's id and those of all the spans under it, in its trace. */
function subtree(trace: Trace, top: string): Set<string> {
  const ids = new Set([top]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const span of trace.spans) {
      if (span.parent_id !== null && ids.has(span.parent_id) && !ids.has(span.id)) {
        ids.add(span.id);
        grew = true;
      }
    }
  }
  return ids;
}

const extent = (span: Span): [number, number] => [span.start, span.start + span.duration];

function find(members: readonly Member[], target: string): { at: number; span: Span | undefined } | undefined {
  for (const [at, member] of members.entries()) {
    if (member.id === target) return { at, span: undefined };
    const span = member.trace.spans.find((each) => each.id === target);
    if (span) return { at, span };
  }
  return undefined;
}

function added(part: Part, ids: Set<string>, window: [number, number], outside: [number, number][]): Part {
  if (part === "whole") return part;
  if (!part) return { ids, windows: [window], outside };
  return {
    ids: new Set([...part.ids, ...ids]),
    windows: [...part.windows, window],
    outside: [...part.outside, ...outside],
  };
}

/** The span a target names, or the first span of the trace it names (`only`); null for a whole trace. */
function targetSpan(member: Member, span: Span | undefined, only: boolean): Span | null | undefined {
  if (span) return span;
  if (!only) return null;
  return member.trace.spans.find((each) => each.parent_id === null);
}

/** What one target takes of its trace, added to what the others took of it. */
function taken(part: Part, member: Member, span: Span | null, only: boolean): Part {
  if (span === null) return "whole";
  if (!only) return added(part, subtree(member.trace, span.id), extent(span), []);
  const children = member.trace.spans.filter((each) => each.parent_id === span.id).map(extent);
  return added(part, new Set([span.id]), extent(span), children);
}

/** Whether a trace served a call under what its parent's part takes. */
function under(parent: Part, member: Member): boolean {
  if (parent === "whole") return true;
  return Boolean(parent && member.via !== null && parent.ids.has(member.via));
}

/** The traces served for calls under the spans taken, and theirs, whole: each comes after the one above it. */
function withServed(members: readonly Member[], parts: Part[]): Part[] {
  const at = new Map(members.map((member, index) => [member.id, index]));
  for (const [index, member] of members.entries()) {
    if (member.parent !== null && under(parts[at.get(member.parent) ?? -1], member)) parts[index] = "whole";
  }
  return parts;
}

/** What of each trace of the chain a scope takes (none: all of every one). */
function partsOf(members: readonly Member[], scope: SpanScope | null): Part[] {
  if (!scope) return members.map(() => "whole");
  const parts: Part[] = members.map(() => undefined);
  for (const target of scope.targets) {
    const found = find(members, target);
    const member = found && members[found.at];
    const span = member && targetSpan(member, found.span, scope.only);
    if (member && span !== undefined) parts[found.at] = taken(parts[found.at], member, span, scope.only);
  }
  return scope.only ? parts : withServed(members, parts);
}

const within = (time: number, [start, end]: [number, number]) => start <= time && time <= end;

function hasLog(part: Part, trace: Trace, log: Log): boolean {
  if (!part) return false;
  if (part === "whole") return true;
  if (log.span_id !== null && trace.spans.some((span) => span.id === log.span_id)) return part.ids.has(log.span_id);
  return part.windows.some((window) => within(log.time, window)) && !part.outside.some((w) => within(log.time, w));
}

/** The scope's records in time order (on the chain's clock), each with its trace and app. */
export function scopedLogs(members: readonly Member[], scope: SpanScope | null): ScopedLog[] {
  const parts = partsOf(members, scope);
  return members
    .flatMap((member, index) =>
      member.trace.logs
        .filter((log) => hasLog(parts[index], member.trace, log))
        .map((log) => ({ ...log, traceId: member.id, app: member.app })),
    )
    .sort((a, b) => a.time - b.time);
}

/** The time a scope covers: its spans' (the first trace's for the whole chain). */
export function scopeWindow(members: readonly Member[], scope: SpanScope | null): [number, number] {
  const root = members[0]?.trace;
  const whole: [number, number] = root ? [root.start, root.start + root.duration] : [0, 0];
  const windows = (scope?.targets ?? []).flatMap((target): [number, number][] => {
    const found = find(members, target);
    const member = found && members[found.at];
    if (!(found && member)) return [];
    return [found.span ? extent(found.span) : [member.trace.start, member.trace.start + member.trace.duration]];
  });
  if (windows.length === 0) return whole;
  return [Math.min(...windows.map((w) => w[0])), Math.max(...windows.map((w) => w[1]))];
}

/** The apps of a chain, in the order their traces come (the first trace's first). */
export function appsOf(members: readonly Member[]): string[] {
  return [...new Set(members.map((member) => member.app).filter(Boolean))];
}

/** Each app's runtime label, from its first trace that says one: the mark on its chip. */
export function appRuntimes(members: readonly Member[]): Map<string, string | undefined> {
  const runtimes = new Map<string, string | undefined>();
  for (const member of members) {
    if (!runtimes.get(member.app)) runtimes.set(member.app, traceRuntime(member.trace.attrs));
  }
  return runtimes;
}

/** A span of a scope (a query, a call), with its trace and the app that made it. */
export type ScopedSpan = Span & { traceId: string; app: string };

function hasSpan(part: Part, span: string): boolean {
  return part === "whole" || Boolean(part?.ids.has(span));
}

/** The scope's spans `keep` takes, in time order (on the chain's clock), each with its trace and app. */
export function scopedSpans(
  members: readonly Member[],
  scope: SpanScope | null,
  keep: (span: Span) => boolean,
): ScopedSpan[] {
  const parts = partsOf(members, scope);
  return members
    .flatMap((member, index) =>
      member.trace.spans
        .filter((span) => keep(span) && hasSpan(parts[index], span.id))
        .map((span) => ({ ...span, traceId: member.id, app: member.app })),
    )
    .sort((a, b) => a.start - b.start);
}

/** An issue of a scope: one per fingerprint, with the trace and app it is first in, its apps, traces and times. */
export type ScopedIssue = Issue & {
  traceId: string;
  app: string;
  apps: string[];
  traces: number;
  occurrences: number;
  chain: boolean;
};

/** Issues by how much they cost a request: what failed first, then what repeats, then what is slow. */
const ISSUE_ORDER = [
  "error",
  "n+1",
  "duplicates",
  "slow-sql",
  "slow-http",
  "slow-call",
  "long-transaction",
  "in-transaction",
  "blocking-call",
  "large-result",
  "queue-wait",
  "htmx",
  "migration-risk",
];

function rank(issue: Issue): number {
  const at = ISSUE_ORDER.indexOf(issue.kind);
  return at === -1 ? ISSUE_ORDER.length : at;
}

/** Whether an issue of a trace is in what the scope takes of it: all of it, or one of its spans. */
function issueIn(part: Part, issue: Issue): boolean {
  return part === "whole" || issue.span_ids.some((span) => hasSpan(part, span));
}

/** One more trace with an issue already listed. */
function counted(group: ScopedIssue, issue: Issue, app: string): void {
  group.traces += 1;
  group.occurrences += Math.max(issue.count, 1);
  if (!group.apps.includes(app)) group.apps.push(app);
}

/**
 * The issues of the scope's traces and the chain's own (its N+1 across apps, `chain`), one per fingerprint with how
 * many traces and times and which apps; the worst first, the most first.
 */
export function scopedIssues(
  members: readonly Member[],
  scope: SpanScope | null,
  chain: readonly ScopeIssue[],
): ScopedIssue[] {
  const parts = partsOf(members, scope);
  const index = new Map(members.map((member, at) => [member.id, at]));
  const found: [number, Issue, boolean][] = [
    ...members.flatMap((member, at) =>
      member.trace.issues.map((issue): [number, Issue, boolean] => [at, issue, false]),
    ),
    ...chain.flatMap((issue): [number, Issue, boolean][] => {
      const at = index.get(issue.trace_id);
      return at === undefined ? [] : [[at, issue as Issue, true]];
    }),
  ];
  const groups = new Map<string, ScopedIssue>();
  for (const [at, issue, own] of found) {
    const member = members[at];
    if (!(member && issueIn(parts[at], issue))) continue;
    const group = groups.get(issue.fingerprint);
    if (group) {
      counted(group, issue, member.app);
      continue;
    }
    groups.set(issue.fingerprint, {
      ...issue,
      traceId: member.id,
      app: member.app,
      apps: [member.app],
      traces: 1,
      occurrences: Math.max(issue.count, 1),
      chain: own,
    });
  }
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.occurrences - a.occurrences);
}

/** The traces a scope takes any of, each with the windows of its spans taken (none: all of it). */
export function scopedParts(
  members: readonly Member[],
  scope: SpanScope | null,
): { member: Member; windows: [number, number][] | null }[] {
  const parts = partsOf(members, scope);
  return members.flatMap((member, index) => {
    const part = parts[index];
    if (!part) return [];
    return [{ member, windows: part === "whole" ? null : part.windows }];
  });
}
