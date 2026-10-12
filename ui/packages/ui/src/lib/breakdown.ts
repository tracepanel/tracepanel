// Where a trace's time went, per category: plain data, no React; the console's call tree and the page widget both
// draw from it.
import type { Span, Trace } from "../types";
import { DATASTORES, MESSAGING, RPC } from "./systems";

export type Category =
  | "django"
  | "view"
  | "code"
  | "template"
  | "sql"
  | "redis"
  | "cache"
  | "datastore"
  | "messaging"
  | "http"
  | "mail";

export const CATEGORY_LABELS: Record<Category, string> = {
  django: "Framework & middleware",
  view: "View code",
  code: "Your code",
  template: "Templates",
  sql: "Database",
  redis: "Redis",
  cache: "Cache",
  datastore: "Datastores",
  messaging: "Messaging",
  http: "External calls",
  mail: "Email",
};

const BY_KIND: Record<string, Category> = {
  sql: "sql",
  redis: "redis",
  cache: "cache",
  "http.client": "http",
  ...Object.fromEntries(RPC.map((kind) => [kind, "http" as const])),
  ...Object.fromEntries(DATASTORES.map((kind) => [kind, "datastore" as const])),
  ...Object.fromEntries(MESSAGING.map((kind) => [kind, "messaging" as const])),
  mail: "mail",
  template: "template",
  view: "view",
  // A task or command root is the user's own code; so are spans they add with tracepanel.span().
  function: "code",
  "task.run": "code",
  command: "code",
};

/** A cache's Redis commands are the cache's time: what the app asked for, on whatever backend serves it. */
function servedFor(span: Span, byId: ReadonlyMap<string, Span>): Span {
  if (span.kind !== "redis") return span;
  const parent = byId.get(String(span.parent_id));
  return parent?.kind === "cache" ? parent : span;
}

function categoryOf(span: Span): Category | null {
  const category = BY_KIND[span.kind];
  if (category) return category;
  // An API framework's own steps (Django Ninja's auth, input validation, response serialization).
  if (span.parent_id === null || span.kind === "middleware" || span.kind === "framework") return "django";
  return null;
}

/**
 * Where the wall-clock time went, per category. Each moment of the trace counts once, for the deepest span
 * running then: concurrent spans (async resolvers, asyncio.gather) can't add up to more than the trace took.
 */
export function breakdown(trace: Trace): [Category, number][] {
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  const depths = new Map<string, number>();
  const depth = (span: Span): number => {
    const known = depths.get(span.id);
    if (known !== undefined) return known;
    const parent = span.parent_id ? byId.get(span.parent_id) : undefined;
    const value = parent ? depth(parent) + 1 : 0;
    depths.set(span.id, value);
    return value;
  };
  // A span without a category of its own (a transaction: the code inside atomic(), a signal…) is its owner's time.
  const owner = (span: Span): Category | null => {
    let current: Span | undefined = servedFor(span, byId);
    while (current) {
      const category = current.kind === "transaction" ? null : categoryOf(current);
      if (category) return category;
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return null;
  };
  const spans = trace.spans.filter((span) => span.duration > 0);
  const edges = [...new Set(spans.flatMap((span) => [span.start, span.start + span.duration]))].sort((a, b) => a - b);
  const totals = new Map<Category, number>();
  for (let index = 0; index + 1 < edges.length; index++) {
    const from = edges[index] ?? 0;
    const to = edges[index + 1] ?? from;
    let innermost: Span | undefined;
    for (const span of spans) {
      if (span.start > from || span.start + span.duration < to) continue;
      if (
        !innermost ||
        depth(span) > depth(innermost) ||
        (depth(span) === depth(innermost) && span.start > innermost.start)
      ) {
        innermost = span;
      }
    }
    const category = innermost ? owner(innermost) : null;
    if (category) totals.set(category, (totals.get(category) ?? 0) + (to - from));
  }
  return (Object.keys(CATEGORY_LABELS) as Category[])
    .map((category): [Category, number] => [category, totals.get(category) ?? 0])
    .filter(([, value]) => value > 0);
}
