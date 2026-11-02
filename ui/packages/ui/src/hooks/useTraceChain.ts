import { useEffect, useMemo, useRef, useState } from "react";
import { type ChainWaiting, waitingIn } from "../lib/chainRows";
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

/** While calls of the chain wait for their traces, it is asked for again this often: they show as they arrive. */
const WAITING_ASK_MS = 2_000;

/**
 * The trace's chain of calls (the traces other apps served for its calls, theirs in turn), on its clock: loaded
 * whole once its links say it called anything, again as they reload (a service's trace arrives after its caller's),
 * and every WAITING_ASK_MS while a call of it waits for its trace. Until then, and without `load`, the trace and the
 * calls' traces its links bring.
 */
function useTraceChain(
  trace: Trace,
  related: Related | undefined,
  load: ((traceId: string) => Promise<Chain>) | undefined,
): { members: Member[]; issues: readonly ScopeIssue[]; waiting: readonly ChainWaiting[] } {
  const [loaded, setLoaded] = useState<{ id: string; key: string; chain: Chain } | undefined>(undefined);
  const [asked, setAsked] = useState(0);
  const calls = callsOf(related);
  // Calls of its own whose traces its links don't bring yet: the chain is asked for at once, it may have them.
  const unlinked = useMemo(() => waitingIn([{ id: trace.id, parent: null, via: null, trace }]).length, [trace]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: its links reloaded, the trace grew or a call still waits: the chain may have grown too.
  useEffect(() => {
    if (!load || (calls === 0 && asked === 0 && unlinked === 0)) return;
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
  }, [load, calls, trace.id, related, trace.spans.length, asked, unlinked]);
  const chain = loaded?.id === trace.id ? loaded.chain : undefined;
  const members = useMemo(() => membersOf(trace, related, chain?.traces), [trace, related, chain]);
  // Read again at each ask: a call stops being waited for in time, with no new answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked`, each ask, is a new now.
  const waiting = useMemo(() => waitingIn(members, chain?.capped ?? false), [members, chain, asked]);
  // More on its way: asked for again until it is all there (or no longer waited for).
  useEffect(() => {
    if (!load || waiting.length === 0) return;
    const timer = window.setTimeout(() => setAsked((count) => count + 1), WAITING_ASK_MS);
    return () => window.clearTimeout(timer);
  }, [load, waiting]);
  return { members, issues: chain?.issues ?? NO_ISSUES, waiting };
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
  /** Its calls whose traces are still on their way: while there are any, the chain is partial. */
  waiting: readonly ChainWaiting[];
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
  const { members, issues, waiting } = useTraceChain(trace, related, load);
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
    () => ({ members, scope, setScope, logs, scoped, chainIssues: issues, waiting }),
    [members, scope, logs, scoped, issues, waiting],
  );
}
