// Outgoing calls (HTTP, cache) shown like queries: one row per call, and a template that groups the calls a loop
// makes (`GET api.example.com/users/{id}`), as a statement's fingerprint groups its queries.
import type { Span } from "../types";

/** What one span of a kind is called, and several. */
const NOUNS: Record<string, [string, string]> = {
  sql: ["query", "queries"],
  cache: ["cache call", "cache calls"],
  "http.client": ["HTTP call", "HTTP calls"],
};
const QUERIES: [string, string] = ["query", "queries"];

/** What a group of similar calls is called: "queries", "cache calls", "HTTP calls" (one of them, for a count of 1). */
export function groupNoun(span: Span | undefined, count = 2): string {
  const [one, many] = NOUNS[String(span?.kind)] ?? QUERIES;
  return count === 1 ? one : many;
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/** A URL path with its id-like segments as `{id}`: numbers, UUIDs, hex hashes of 16 or more (as the agent has it). */
export function pathTemplate(path: string): string {
  return path
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? "{id}" : segment))
    .join("/");
}

/** What a call is a repeat of: an HTTP call's method, host and path template; any other span's name. */
export function callTemplate(span: Span | undefined): string {
  if (span === undefined) return "";
  if (span.kind !== "http.client") return span.name;
  const [method = "", target = ""] = span.name.split(" ", 2);
  const slash = target.indexOf("/");
  return slash < 0 ? span.name : `${method} ${target.slice(0, slash)}${pathTemplate(target.slice(slash))}`;
}
