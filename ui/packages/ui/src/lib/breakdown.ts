// Where a trace's time went, per category: plain data, no React; the console's call tree and the page widget both
// draw from it.
import type { Span, Trace } from "../types";
import { isReceiver } from "./signals";
import { DATASTORES, MESSAGING, RPC } from "./systems";

export type Category =
  | "django"
  | "code"
  | "signal"
  | "template"
  | "sql"
  | "redis"
  | "cache"
  | "datastore"
  | "messaging"
  | "http"
  | "storage"
  | "llm"
  | "mail";

const CATEGORY_LABELS: Record<Category, string> = {
  django: "Framework & middleware",
  code: "Your code",
  signal: "Signals",
  template: "Templates",
  sql: "Database",
  redis: "Redis",
  cache: "Cache",
  datastore: "Datastores",
  messaging: "Messaging",
  http: "External calls",
  storage: "Storage",
  llm: "LLM",
  mail: "Email",
};

/**
 * A category as the trace says it: the framework's time is a request's middleware too. The code's own time is "Your
 * code" in every kind of trace: a view's or a handler's, a task's, a job's.
 */
export function categoryLabel(category: Category, trace: Pick<Trace, "attrs"> & { kind?: string }): string {
  return category === "django" ? frameworkLabel(trace.kind) : CATEGORY_LABELS[category];
}

/** Middleware is a request's: a task's, a job's or a consumer's own time is its framework's. */
function frameworkLabel(kind: string | undefined): string {
  return (kind ?? "http") === "http" ? CATEGORY_LABELS.django : "Framework";
}

const BY_KIND: Record<string, Category> = {
  sql: "sql",
  redis: "redis",
  cache: "cache",
  "http.client": "http",
  ...Object.fromEntries(RPC.map((kind) => [kind, "http" as const])),
  ...Object.fromEntries(DATASTORES.map((kind) => [kind, "datastore" as const])),
  ...Object.fromEntries(MESSAGING.map((kind) => [kind, "messaging" as const])),
  storage: "storage",
  llm: "llm",
  mail: "mail",
  template: "template",
  signal: "signal",
  // The view or handler, a task's or a command's root are the user's own code; so are spans they add with
  // tracepanel.span().
  view: "code",
  function: "code",
  task: "code",
  "task.run": "code",
  command: "code",
};

/** The calls a backend makes for another: a cache's Redis commands, an LLM call's HTTP requests. */
const SERVED_FOR: Record<string, string> = { redis: "cache", "http.client": "llm" };

/**
 * A cache's Redis commands are the cache's time, an LLM call's HTTP requests the model's: what the app asked for, on
 * whatever serves it.
 */
function servedFor(span: Span, byId: ReadonlyMap<string, Span>): Span {
  const owner = SERVED_FOR[span.kind];
  if (!owner) return span;
  const parent = byId.get(String(span.parent_id));
  return parent?.kind === owner ? parent : span;
}

function categoryOf(span: Span, byId: ReadonlyMap<string, Span>, handled: boolean): Category | null {
  // A receiver is the signal's time: what sending it cost, the work it does (its queries aside) included.
  if (isReceiver(span, byId.get(String(span.parent_id)))) return "signal";
  return BY_KIND[span.kind] ?? frameworkOf(span, handled);
}

/**
 * The request's root, its middleware, and an API framework's own steps (Django Ninja's auth, validation). With no
 * view or handler recorded (`handled`), the root's own time can't be told from the code's: it is the code's then.
 */
function frameworkOf(span: Span, handled: boolean): Category | null {
  if (span.parent_id === null) return handled ? "django" : "code";
  return FRAMEWORK_KINDS.has(span.kind) ? "django" : null;
}

const FRAMEWORK_KINDS = new Set(["middleware", "framework"]);

/** A span without a category of its own (a transaction: the code inside atomic()) is its owner's time. */
function ownerFinder(byId: ReadonlyMap<string, Span>): (span: Span) => Category | null {
  const handled = [...byId.values()].some((span) => span.kind === "view");
  return (span) => {
    for (let current: Span | undefined = servedFor(span, byId); current; current = parentOf(current, byId)) {
      const category = ownCategory(current, byId, handled);
      if (category) return category;
    }
    return null;
  };
}

/** A span's own category: none for a transaction, whose code is its owner's. */
function ownCategory(span: Span, byId: ReadonlyMap<string, Span>, handled: boolean): Category | null {
  return span.kind === "transaction" ? null : categoryOf(span, byId, handled);
}

function parentOf(span: Span, byId: ReadonlyMap<string, Span>): Span | undefined {
  return span.parent_id ? byId.get(span.parent_id) : undefined;
}

/** Each span's category, by its id: the share of the time it counts in. */
export function spanCategories(trace: Trace): Map<string, Category> {
  const owner = ownerFinder(new Map(trace.spans.map((span) => [span.id, span])));
  return new Map(
    trace.spans.flatMap((span): [string, Category][] => {
      const category = owner(span);
      return category ? [[span.id, category]] : [];
    }),
  );
}

/** How deep a span is in its trace: its root is 0. Remembered, a trace's spans are walked once. */
function depthFinder(byId: ReadonlyMap<string, Span>): (span: Span) => number {
  const depths = new Map<string, number>();
  const depth = (span: Span): number => {
    const known = depths.get(span.id);
    if (known !== undefined) return known;
    const parent = parentOf(span, byId);
    const value = parent ? depth(parent) + 1 : 0;
    depths.set(span.id, value);
    return value;
  };
  return depth;
}

/** Whether `span` runs inside `best` rather than beside it: deeper, or as deep and started later. */
function deeper(span: Span, best: Span | undefined, depth: (span: Span) => number): boolean {
  if (!best) return true;
  return depth(span) > depth(best) || (depth(span) === depth(best) && span.start > best.start);
}

function covers(span: Span, from: number, to: number): boolean {
  return span.start <= from && span.start + span.duration >= to;
}

/** The deepest span running all the way from `from` to `to`. */
function innermostAt(spans: readonly Span[], from: number, to: number, depth: (span: Span) => number) {
  let innermost: Span | undefined;
  for (const span of spans) {
    if (covers(span, from, to) && deeper(span, innermost, depth)) innermost = span;
  }
  return innermost;
}

/**
 * A stretch of the trace's time, in microseconds since it started: the category it went to, and whether it was
 * quiet: spent in a span that made calls, but none then (its own code, between or after them).
 */
export interface Stretch {
  from: number;
  to: number;
  category: Category;
  quiet: boolean;
  /** The span running then, deepest. */
  span: string;
}

/** A stretch after the last: the same as it, it makes it longer. */
function extend(list: Stretch[], next: Stretch): void {
  const last = list.at(-1);
  if (last && continues(last, next)) last.to = next.to;
  else list.push(next);
}

function continues(last: Stretch, next: Stretch): boolean {
  return last.to === next.from && last.span === next.span && last.quiet === next.quiet;
}

/**
 * Where the wall-clock time went, moment by moment. Each moment of the trace counts once, for the deepest span
 * running then: concurrent spans (async resolvers, asyncio.gather) can't add up to more than the trace took.
 */
export function stretches(trace: Trace): Stretch[] {
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  const owner = ownerFinder(byId);
  const depth = depthFinder(byId);
  const callers = new Set(trace.spans.map((span) => span.parent_id));
  const spans = trace.spans.filter((span) => span.duration > 0);
  const edges = [...new Set(spans.flatMap((span) => [span.start, span.start + span.duration]))].sort((a, b) => a - b);
  // What ran from one edge to the next: the deepest span's category, and whether it was quiet.
  const at = (from: number, to: number): Stretch | null => {
    const innermost = innermostAt(spans, from, to, depth);
    const category = innermost ? owner(innermost) : null;
    if (!(innermost && category)) return null;
    const quiet = callers.has(innermost.id);
    return { from: from - trace.start, to: to - trace.start, category, quiet, span: innermost.id };
  };
  const list: Stretch[] = [];
  edges.slice(1).forEach((to, index) => {
    const next = at(edges[index] ?? to, to);
    if (next) extend(list, next);
  });
  return list;
}

/** Where the wall-clock time went, per category: the stretches added up. */
export function breakdown(trace: Trace): [Category, number][] {
  const totals = new Map<Category, number>();
  for (const { from, to, category } of stretches(trace)) totals.set(category, (totals.get(category) ?? 0) + to - from);
  return (Object.keys(CATEGORY_LABELS) as Category[])
    .map((category): [Category, number] => [category, totals.get(category) ?? 0])
    .filter(([, value]) => value > 0);
}
