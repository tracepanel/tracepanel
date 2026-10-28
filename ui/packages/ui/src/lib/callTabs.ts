// The tabs of a trace that list its calls to one system, and what those calls are called there.

import type { Span } from "../types";
import { systemOfSpan } from "./systems";

/** Which tab lists a system's calls, and what they are called. */
export const CALL_TABS: Record<string, { system: string; noun: [string, string]; empty: string }> = {
  sql: { system: "sql", noun: ["query", "queries"], empty: "No database queries" },
  cache: { system: "cache", noun: ["cache call", "cache calls"], empty: "No cache calls" },
  http: { system: "http.client", noun: ["HTTP call", "HTTP calls"], empty: "No HTTP calls" },
};

/** Whether a span is a call to the system a tab lists. */
export function callsOfTab(tab: string): (span: Span) => boolean {
  const system = CALL_TABS[tab]?.system;
  return (span) => systemOfSpan(span)?.kind === system;
}
