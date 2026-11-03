import { useEffect, useMemo, useRef, useState } from "react";
import { type ChainWaiting, untracedIn, waitingIn } from "../lib/chainRows";
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
 * While calls of the chain wait for their traces, it is asked for again this often: they show as they arrive (a
 * service's trace comes a second or so after its caller's). Calls cut short wait minutes for theirs: less often.
 */
const WAITING_ASK_MS = 1_000;
const CUT_ASK_MS = 2_000;

/**
 * The trace's chain of calls (the traces other apps served for its calls, theirs in turn), on its clock: loaded
 * whole once its links say it called anything, again as they reload (a service's trace arrives after its caller's),
 * and every WAITING_ASK_MS while a call of it waits for its trace (CUT_ASK_MS while only calls cut short do). Until then, and without `load`, the trace and the
 * calls' traces its links bring.
 */
function useTraceChain(
  trace: Trace,
  related: Related | undefined,
  load: ((traceId: string) => Promise<Chain>) | undefined,
): {
  members: Member[];
  issues: readonly ScopeIssue[];
  waiting: readonly ChainWaiting[];
  untraced: ReadonlyMap<string, string>;
} {
  const [loaded, setLoaded] = useState<{ id: string; key: string; chain: Chain } | undefined>(undefined);
  // When the chain was last asked for again while calls of it wait (ms); 0 before.
  const [asked, setAsked] = useState(0);
  const calls = callsOf(related);
  // Calls of its own whose traces its links don't bring yet: the chain is asked for at once, it may have them.
  const unlinked = useMemo(() => waitingIn([{ id: trace.id, parent: null, via: null, trace }]).length, [trace]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: its links reloaded or the trace grew, the chain may have too.
  useEffect(() => {
    if (!load || calls + asked + unlinked === 0) return;
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
  // Read again at each ask, at its time: a call stops being waited for in time, with no new answer.
  const capped = chain?.capped ?? false;
  const waiting = useMemo(() => waitingIn(members, capped, asked || Date.now()), [members, capped, asked]);
  // Said only once the chain is all there is to know: loaded, or none to load (no call any trace answered).
  const settled = chain !== undefined || !load || calls + unlinked === 0;
  const untraced = useMemo(
    () => (settled ? untracedIn(members, capped, asked || Date.now()) : NO_UNTRACED),
    [settled, members, capped, asked],
  );
  // More on its way: asked for again until it is all there (or no longer waited for).
  useEffect(() => {
    if (!load || waiting.length === 0) return;
    const cut = waiting.every((call) => call.cut !== null);
    const timer = window.setTimeout(() => setAsked(Date.now()), cut ? CUT_ASK_MS : WAITING_ASK_MS);
    return () => window.clearTimeout(timer);
  }, [load, waiting]);
  return { members, issues: chain?.issues ?? NO_ISSUES, waiting, untraced };
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
  /** Its calls no trace answered and none will, by span id: the host each went to (lib/chainRows, untracedIn). */
  untraced: ReadonlyMap<string, string>;
}

const NO_ISSUES: readonly ScopeIssue[] = [];
const NO_UNTRACED: ReadonlyMap<string, string> = new Map();

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
  const { members, issues, waiting, untraced } = useTraceChain(trace, related, load);
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
    () => ({ members, scope, setScope, logs, scoped, chainIssues: issues, waiting, untraced }),
    [members, scope, logs, scoped, issues, waiting, untraced],
  );
}
