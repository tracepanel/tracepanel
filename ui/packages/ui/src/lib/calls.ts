// Outgoing calls (HTTP, cache) shown like queries: one row per call, and a template that groups the calls a loop
// makes (`GET api.example.com/users/{id}`), as a statement's fingerprint groups its queries.
import type { Span } from "../types";
import { sendTemplate } from "./signals";
import { SYSTEMS, type System, systemOfSpan } from "./systems";

const SQL = SYSTEMS[0] as System;

/** What a group of similar calls is called: "queries", "Redis commands", "HTTP calls" (one of them, for a count of 1). */
export function groupNoun(span: Span | undefined, count = 2): string {
  const nouns = nounsOf(span);
  return count === 1 ? nouns.one : nouns.many;
}

const SENDS = { one: "send", many: "sends" };

/** A signal's sends, or a system's calls. */
function nounsOf(span: Span | undefined): { one: string; many: string } {
  return span?.kind === "signal" ? SENDS : systemNouns(span);
}

function systemNouns(span: Span | undefined): System {
  return (span && systemOfSpan(span)) ?? SQL;
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/** A URL path with its id-like segments as `{id}`: numbers, UUIDs, hex hashes of 16 or more (as the agent has it). */
export function pathTemplate(path: string): string {
  return path
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? "{id}" : segment))
    .join("/");
}

// An id inside a key (`post:42:views`, `session:9f3a…`): a number, a UUID, a long hex hash.
const ID_IN_KEY = /\b(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})\b/gi;

/** A Redis command or a cache operation with its key's ids as `{id}`: `GET post:{id}:views`, `get user:{id}`. */
function keyTemplate(name: string): string {
  return name.replace(ID_IN_KEY, "{id}");
}

/** An HTTP call's method, host and path template: `GET api.example.com/users/{id}`. */
function endpointTemplate(name: string): string {
  const [method = "", target = ""] = name.split(" ", 2);
  const slash = target.indexOf("/");
  return slash < 0 ? name : `${method} ${target.slice(0, slash)}${pathTemplate(target.slice(slash))}`;
}

const TEMPLATES: Record<string, (span: Span) => string> = {
  redis: (span) => keyTemplate(span.name),
  cache: (span) => keyTemplate(span.name),
  "http.client": (span) => endpointTemplate(span.name),
  signal: sendTemplate,
};

/** What a call is a repeat of: an HTTP call's endpoint, a key pattern, a signal and its sender, any other's name. */
export function callTemplate(span: Span | undefined): string {
  if (span === undefined) return "";
  return TEMPLATES[span.kind]?.(span) ?? span.name;
}
