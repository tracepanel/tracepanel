import { useEffect, useMemo, useRef, useState } from "react";
import { type Member, membersOf, type ScopedLog, type SpanScope, scopedLogs } from "../lib/scope";
import type { Chain, ChainTrace, Related, ScopeIssue, Trace } from "../types";

/** What tells two loads of a chain apart: its traces, and how much each of them holds by now. */
function signature(traces: readonly ChainTrace[]): string {
  return traces
    .map(
      (each) =>
        `${each.id}:${each.trace?.spans.length ?? 0}:${each.trace?.logs.length ?? 0}:${each.trace?.issues.length ?? 0}`,
    )
    .join(",");
}

/** How many calls of the trace another trace answered: with none, the trace is its chain alone. */
function callsOf(related: Related | undefined): number {
  return related ? related.calls.length + (related.remote_calls?.length ?? 0) : 0;
}

/**
 * The trace's chain of calls (the traces other apps served for its calls, theirs in turn), on its clock: loaded
 * whole once its links say it called anything, again as they reload (a service's trace arrives after its caller's).
 * Until then, and without `load`, the trace and the calls' traces its links bring.
 */
function useTraceChain(
  trace: Trace,
  related: Related | undefined,
  load: ((traceId: string) => Promise<Chain>) | undefined,
): { members: Member[]; issues: readonly ScopeIssue[] } {
  const [loaded, setLoaded] = useState<{ id: string; key: string; chain: Chain } | undefined>(undefined);
  const calls = callsOf(related);
  // biome-ignore lint/correctness/useExhaustiveDependencies: its links reloaded or the trace grew, the chain may have too.
  useEffect(() => {
    if (!load || calls === 0) return;
    let live = true;
    load(trace.id).then(
      (chain) => {
        if (!live) return;
        const key = `${signature(chain.traces)}|${chain.issues.length}`;
        setLoaded((current) =>
          current?.id === trace.id && current.key === key ? current : { id: trace.id, key, chain },
        );
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [load, calls, trace.id, related, trace.spans.length]);
  const chain = loaded?.id === trace.id ? loaded.chain : undefined;
  const members = useMemo(() => membersOf(trace, related, chain?.traces), [trace, related, chain]);
  return { members, issues: chain?.issues ?? NO_ISSUES };
}

/** A trace's chain, the part of it its tabs list (`scope`: all of it, or what is under a row), and its records. */
export interface TraceScope {
  members: Member[];
  scope: SpanScope | null;
  setScope: (scope: SpanScope | null) => void;
  /** The whole chain's records. */
  logs: ScopedLog[];
  /** The scope's records. */
  scoped: ScopedLog[];
  /** The chain's own issues: its N+1 across apps. */
  chainIssues: readonly ScopeIssue[];
}

const NO_ISSUES: readonly ScopeIssue[] = [];

/** What is under the trace of one app: its traces down the chain, whole (the panel's list opens a trace so). */
function underApp(members: readonly Member[], app: string): SpanScope | null {
  const targets = members.slice(1).filter((member) => member.app === app);
  return targets.length > 0 ? { targets: targets.map((member) => member.id), label: app, only: false } : null;
}

export function useTraceScope(
  trace: Trace,
  related: Related | undefined,
  load: ((traceId: string) => Promise<Chain>) | undefined,
  /** An app whose traces the scope starts as, once the chain has them ("Under library-api"). */
  under?: string | undefined,
): TraceScope {
  const { members, issues } = useTraceChain(trace, related, load);
  const [scope, setScope] = useState<SpanScope | null>(null);
  const asked = useRef(under);
  useEffect(() => {
    const app = asked.current;
    const start = app ? underApp(members, app) : null;
    if (!start) return;
    asked.current = undefined;
    setScope(start);
  }, [members]);
  const logs = useMemo(() => scopedLogs(members, null), [members]);
  const scoped = useMemo(() => (scope ? scopedLogs(members, scope) : logs), [members, scope, logs]);
  return useMemo(
    () => ({ members, scope, setScope, logs, scoped, chainIssues: issues }),
    [members, scope, logs, scoped, issues],
  );
}
