import { duration } from "./format";
import { onTheClock } from "./lib/calls";
import { llmFacts } from "./lib/llm";
import { memoryFacts } from "./lib/memory";
import { plural } from "./lib/plural";
import { type SystemCalls, systemCalls } from "./systemCalls";
import type { Span, Trace } from "./types";

/** What a system's calls add after their time: SQL's unique statements, a cache's hits. */
const DETAILS: Record<string, (spans: Span[]) => string | null> = {
  sql: (spans) => `${new Set(spans.map((span) => span.attrs["db.fingerprint"])).size} unique`,
  cache: (spans) => {
    const gets = spans.filter((span) => span.attrs["cache.op"] === "get");
    const hits = gets.filter((span) => span.attrs["cache.hit"] === true).length;
    return gets.length > 0 ? `${hits}/${gets.length} hits` : null;
  },
  llm: llmFacts,
};

/** What a system's calls are called, one and many; a system not here, "<its name> calls". */
const NOUNS: Record<string, readonly [string, string]> = {
  sql: ["query", "queries"],
  redis: ["Redis command", "Redis commands"],
  cache: ["cache call", "cache calls"],
  storage: ["storage call", "storage calls"],
  llm: ["LLM call", "LLM calls"],
  "http.client": ["HTTP call", "HTTP calls"],
};

function nouns(calls: SystemCalls): readonly [string, string] {
  return NOUNS[calls.key] ?? [`${calls.label} call`, `${calls.label} calls`];
}

/**
 * "139 queries 29 ms · 3 unique": how many calls, their time on the clock (calls side by side counted once), what
 * the system adds.
 */
function said(calls: SystemCalls): string {
  const [one, many] = nouns(calls);
  const detail = DETAILS[calls.key]?.(calls.spans);
  const time = duration(onTheClock(calls.spans));
  return [`${plural(calls.spans.length, one, many)} ${time}`, detail].filter(Boolean).join(" · ");
}

/** What calls that ran side by side add up to, where that is more than their time on the clock: for the tooltip. */
function totals(all: readonly SystemCalls[]): string | undefined {
  const lines = all
    .filter((calls) => calls.total > onTheClock(calls.spans))
    .map((calls) => `${plural(calls.spans.length, ...nouns(calls))}: ${duration(calls.total)} total`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * The trace with only the calls the app made itself: an LLM call's HTTP requests are the model's, as the time strip
 * counts them, not HTTP calls of their own.
 */
function ownCalls(trace: Trace): Trace {
  const llm = new Set(trace.spans.filter((span) => span.kind === "llm").map((span) => span.id));
  if (llm.size === 0) return trace;
  return {
    ...trace,
    spans: trace.spans.filter((span) => !(span.kind === "http.client" && llm.has(String(span.parent_id)))),
  };
}

/**
 * The trace's calls in its header, after how long it took: one quiet line, system by system ("· 139 queries 29 ms
 * · 3 unique"), then, profiled, its memory and the collector's pauses ("· ↑ 42 MB peak · GC 3× 12 ms"). Nothing for a
 * trace that called nothing and wasn't profiled.
 */
export function HeadFacts({ trace }: { trace: Trace }) {
  const calls = systemCalls(ownCalls(trace));
  const facts = [...calls.map(said), ...memoryFacts(trace.profile)];
  if (facts.length === 0) return null;
  return (
    <span className="dt-trace-facts" title={totals(calls)}>
      {facts.map((fact) => `· ${fact}`).join(" ")}
    </span>
  );
}
