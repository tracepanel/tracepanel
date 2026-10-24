import { duration } from "./format";
import { plural } from "./lib/plural";
import { type SystemCalls, systemCalls } from "./systemCalls";
import type { Span } from "./types";

/** What a system's calls add after their time: SQL's unique statements, a cache's hits. */
const DETAILS: Record<string, (spans: Span[]) => string | null> = {
  sql: (spans) => `${new Set(spans.map((span) => span.attrs["db.fingerprint"])).size} unique`,
  cache: (spans) => {
    const gets = spans.filter((span) => span.attrs["cache.op"] === "get");
    const hits = gets.filter((span) => span.attrs["cache.hit"] === true).length;
    return gets.length > 0 ? `${hits}/${gets.length} hits` : null;
  },
};

/** What a system's calls are called, one and many; a system not here, "<its name> calls". */
const NOUNS: Record<string, readonly [string, string]> = {
  sql: ["query", "queries"],
  redis: ["Redis command", "Redis commands"],
  cache: ["cache call", "cache calls"],
  "http.client": ["HTTP call", "HTTP calls"],
};

/** "139 queries 29 ms · 3 unique": how many calls, their time, what the system adds. */
function said(calls: SystemCalls): string {
  const [one, many] = NOUNS[calls.key] ?? [`${calls.label} call`, `${calls.label} calls`];
  const detail = DETAILS[calls.key]?.(calls.spans);
  return [`${plural(calls.spans.length, one, many)} ${duration(calls.total)}`, detail].filter(Boolean).join(" · ");
}

/**
 * The trace's calls in its header, after how long it took: one quiet line, system by system ("· 139 queries 29 ms
 * · 3 unique"). Nothing for a trace that called nothing.
 */
export function HeadFacts({ trace }: { trace: Parameters<typeof systemCalls>[0] }) {
  const systems = systemCalls(trace);
  if (systems.length === 0) return null;
  return <span className="dt-trace-facts">{systems.map((calls) => `· ${said(calls)}`).join(" ")}</span>;
}
