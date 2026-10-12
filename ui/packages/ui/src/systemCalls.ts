import { FAMILY_ORDER, type Family, systemOfSpan } from "./lib/systems";
import type { Span, Trace } from "./types";

/** The request's calls to one system: its key ("sql", "redis", "neo4j"), what it is called, its spans. */
export interface SystemCalls {
  key: string;
  label: string;
  family: Family;
  spans: Span[];
  total: number;
}

/** The systems the request called, by family (as the sidebar lists them), then by name. */
export function systemCalls(trace: Trace): SystemCalls[] {
  const bySystem = new Map<string, SystemCalls>();
  for (const span of trace.spans) {
    const system = systemOfSpan(span);
    if (!system) continue;
    const calls = bySystem.get(system.kind) ?? {
      key: system.kind,
      label: system.label,
      family: system.family,
      spans: [],
      total: 0,
    };
    calls.spans.push(span);
    calls.total += span.duration;
    bySystem.set(system.kind, calls);
  }
  const rank = (calls: SystemCalls) => FAMILY_ORDER.indexOf(calls.family);
  return [...bySystem.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** The system a span's issue points at, to open its tab. */
export function systemOfIssue(trace: Trace, spanId: string | undefined): string | undefined {
  const span = trace.spans.find((each) => each.id === spanId);
  return span ? systemOfSpan(span)?.kind : undefined;
}
