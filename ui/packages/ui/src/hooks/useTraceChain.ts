import { useEffect, useMemo, useState } from "react";
import { type Member, membersOf, type ScopedLog, type SpanScope, scopedLogs } from "../lib/scope";
import type { ChainTrace, Related, Trace } from "../types";

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
export function useTraceChain(
  trace: Trace,
  related: Related | undefined,
  load: ((traceId: string) => Promise<ChainTrace[]>) | undefined,
): Member[] {
  const [loaded, setLoaded] = useState<{ id: string; key: string; traces: ChainTrace[] } | undefined>(undefined);
  const calls = callsOf(related);
  // biome-ignore lint/correctness/useExhaustiveDependencies: its links reloaded or the trace grew, the chain may have too.
  useEffect(() => {
    if (!load || calls === 0) return;
    let live = true;
    load(trace.id).then(
      (traces) => {
        if (!live) return;
        const key = signature(traces);
        setLoaded((current) =>
          current?.id === trace.id && current.key === key ? current : { id: trace.id, key, traces },
        );
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [load, calls, trace.id, related, trace.spans.length]);
  const traces = loaded?.id === trace.id ? loaded.traces : undefined;
  return useMemo(() => membersOf(trace, related, traces), [trace, related, traces]);
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
}

export function useTraceScope(
  trace: Trace,
  related: Related | undefined,
  load: ((traceId: string) => Promise<ChainTrace[]>) | undefined,
): TraceScope {
  const members = useTraceChain(trace, related, load);
  const [scope, setScope] = useState<SpanScope | null>(null);
  const logs = useMemo(() => scopedLogs(members, null), [members]);
  const scoped = useMemo(() => (scope ? scopedLogs(members, scope) : logs), [members, scope, logs]);
  return { members, scope, setScope, logs, scoped };
}
