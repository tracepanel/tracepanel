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

/** What a kind's spans are called that isn't a system's calls: a signal's sends, a migration's operations. */
const OWN_NOUNS: Record<string, { one: string; many: string }> = {
  signal: { one: "send", many: "sends" },
  "migration.operation": { one: "operation", many: "operations" },
  function: { one: "call", many: "calls" },
};

/** A signal's sends, a migration's operations, or a system's calls. */
function nounsOf(span: Span | undefined): { one: string; many: string } {
  return (span && OWN_NOUNS[span.kind]) ?? systemNouns(span);
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

/** The word a kind's names start with that its badge says already: `storage exists…`, `migrate shop 0012…`. */
const BADGE_WORDS: Record<string, RegExp> = { storage: /^storage /, migration: /^migrate / };

/**
 * A call as its row says it, after its kind's badge: a storage call without the word its badge says
 * (`exists avatars/1.png`), a migration applied too (`shop 0012_add_sku`, `unapply` kept), any other by its name.
 */
export function callText(span: Span): string {
  const word = BADGE_WORDS[span.kind];
  return word ? span.name.replace(word, "") : span.name;
}

/**
 * What a loop's storage calls share, as the agent groups them: the directory they look in, its ids as `{id}`
 * (`exists avatars/*`, whatever each file is called); a listing's own directory.
 */
function storageTemplate(span: Span): string {
  const op = String(span.attrs["storage.op"] ?? "");
  return [op, placeOf(op, String(span.attrs["storage.path"] ?? ""))].filter(Boolean).join(" ");
}

/** Where a storage call looks: a listing's directory, a file's directory. */
function placeOf(op: string, path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "";
  return op === "listdir" ? keyTemplate(trimmed) : directoryOf(trimmed);
}

/** The directory a file is in, as a loop's files share it: `avatars/*`, `*` at the top. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "*" : `${keyTemplate(path.slice(0, slash))}/*`;
}

const TEMPLATES: Record<string, (span: Span) => string> = {
  redis: (span) => keyTemplate(span.name),
  cache: (span) => keyTemplate(span.name),
  storage: storageTemplate,
  "http.client": (span) => endpointTemplate(span.name),
  signal: sendTemplate,
};

/** What a call is a repeat of: an HTTP call's endpoint, a key pattern, a signal and its sender, any other's name. */
export function callTemplate(span: Span | undefined): string {
  if (span === undefined) return "";
  return TEMPLATES[span.kind]?.(span) ?? span.name;
}
