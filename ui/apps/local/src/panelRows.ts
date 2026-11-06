import { ISSUE_LABELS, type IssueKind, type TraceRow, type TraceSummary } from "@tracepanel/ui";
import type { EntrySummary, TabEntry, TabHistory } from "./hooks";
import { ARRIVING_MS, type Running } from "./TraceScreen";

/** A row built from what the widget saw in the response headers, until the stored trace arrives. */
// biome-ignore-start lint/style/useNamingConvention: builds an API object; its field names are the wire format.
function fromWidget(entry: TabEntry): TraceSummary | undefined {
  const summary = entry.summary;
  if (!summary) return undefined;
  const [method, ...path] = summary.name.split(" ");
  return {
    id: entry.id,
    // Not known until the agent has the trace: the row names no app until then.
    service: "",
    kind: "http",
    name: summary.name,
    start: summary.start,
    duration: summary.duration,
    status: summary.failed || (summary.status ?? 200) >= 500 ? "error" : "ok",
    http_status: summary.status,
    queries: summary.queries,
    issues: summary.issues,
    method: method ?? "GET",
    path: path.join(" "),
    // The widget only knows what Server-Timing told it; the rest fills in once the trace loads.
    route: null,
    view: null,
    user_id: null,
    db_time: 0,
    errors: 0,
    logs: 0,
    mails: 0,
    // Named as soon as the widget knows them, so the row's chip doesn't change when the trace loads.
    issue_kinds: (summary.kinds ?? []).filter((kind): kind is IssueKind => kind in ISSUE_LABELS),
    db_aliases: [],
    cache_aliases: [],
    task_state: null,
    htmx: summary.htmx ? (summary.htmx.boosted ? "boosted" : "request") : null,
  };
}

/** A row from what the widget knows: a request, or a view or an action recorded in the browser. */
function rowFromWidget(entry: TabEntry): TraceSummary | undefined {
  return entry.summary?.kind === "page" ? pageFromWidget(entry.id, entry.summary) : fromWidget(entry);
}

/** A view or an action recorded in the browser: named by its page and what was done, not a method and a path. */
function pageFromWidget(id: string, summary: EntrySummary): TraceSummary {
  return {
    id,
    service: "",
    kind: "page",
    name: summary.name,
    start: summary.start,
    duration: summary.duration,
    status: summary.failed ? "error" : "ok",
    http_status: null,
    queries: 0,
    issues: 0,
    method: null,
    path: null,
    route: null,
    view: null,
    user_id: null,
    db_time: 0,
    errors: 0,
    logs: 0,
    mails: 0,
    issue_kinds: [],
    db_aliases: [],
    cache_aliases: [],
    task_state: null,
    htmx: null,
  };
}
// biome-ignore-end lint/style/useNamingConvention: builds an API object; its field names are the wire format.

/** Pages newest first, each followed by its own fetch/XHR requests in the order they happened. */
export function arrange(history: TabHistory, traces: readonly TraceSummary[]): TraceRow[] {
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  const stored = new Set(byId.keys());
  for (const entry of history.entries) {
    const fallback = byId.has(entry.id) ? undefined : rowFromWidget(entry);
    if (fallback) byId.set(entry.id, fallback);
  }
  for (const entry of history.entries) {
    const trace = byId.get(entry.id);
    if (trace && stored.has(entry.id)) byId.set(entry.id, waitedFor(trace, entry.summary));
  }
  const facts = new Map(history.entries.map((entry) => [entry.id, widgetFacts(entry, stored)]));
  const children = childrenOf(history, byId, facts);
  const row = (trace: TraceSummary, depth: 0 | 1): TraceRow => {
    const { htmx, ...known } = facts.get(trace.id) ?? {};
    // A boosted link loaded a page: its path names it, not the link's text.
    if (!htmx || htmx.boosted) return { trace, depth, ...known };
    return { trace, depth, trigger: htmx.trigger, target: htmx.target, ...known };
  };
  const roots = [...(children.get(null) ?? [])].reverse();
  return roots.flatMap((root) => [row(root, 0), ...(children.get(root.id) ?? []).map((trace) => row(trace, 1))]);
}

/**
 * A stored request the page made, as the page waited for it: from the call to its answer, as the browser timed it (a
 * call the browser queued behind others waited longer than its server took), never less than its trace's own time.
 * Its row says the same time in flight, once answered and once stored, as the pill does; its trace says its own.
 */
function waitedFor(trace: TraceSummary, summary: EntrySummary | undefined): TraceSummary {
  const clock = summary?.clock;
  if (!clock) return trace;
  return { ...trace, start: clock.start, duration: Math.max(clock.end - clock.start, trace.duration) };
}

/** What the widget says of a row beyond its summary. */
type WidgetFacts = Partial<
  Pick<TraceRow, "open" | "until" | "redirectedFrom" | "key" | "opens" | "host" | "loadHost" | "span" | "failed">
> & {
  htmx?: EntrySummary["htmx"];
};

/**
 * What the widget says of an entry: in flight (a request the page waits for, a view still open) until the agent has
 * it, a view's time stopped at its calls' last answer; the view the SPA was sent from at once; the id it flew under
 * (its row's identity from in flight to stored); the view a call that answered untraced opens (it has no trace of
 * its own); the host it went to (a view's calls to one host are grouped); what sent it (htmx).
 */
function widgetFacts(entry: TabEntry, stored: ReadonlySet<string>): WidgetFacts {
  const summary = entry.summary;
  if (!summary) return {};
  const open = summary.open && !stored.has(entry.id);
  return {
    ...(open ? { open: true, until: summary.until } : {}),
    ...(summary.redirectedFrom ? { redirectedFrom: summary.redirectedFrom } : {}),
    ...(summary.key ? { key: summary.key } : {}),
    ...(summary.untraced && entry.parent ? { opens: entry.parent } : {}),
    ...(open ? {} : failedFact(summary)),
    ...(summary.host ? { host: summary.host } : {}),
    ...(summary.loadHost ? { loadHost: summary.loadHost } : {}),
    ...(summary.span ? { span: summary.span } : {}),
    ...(summary.htmx ? { htmx: summary.htmx } : {}),
  };
}

/** A call that got no answer at all (a network error): "failed", as its view's trace will say it. */
function failedFact(summary: EntrySummary): Pick<WidgetFacts, "failed"> {
  return summary.untraced && summary.failed && summary.status === null ? { failed: "No answer" } : {};
}

/**
 * Each page's requests, in the order they started (made in the same millisecond, in the order they were made): a row
 * keeps its place as it lands, answers, and is stored. Under `null`, the pages.
 */
function childrenOf(
  history: TabHistory,
  byId: ReadonlyMap<string, TraceSummary>,
  facts: ReadonlyMap<string, WidgetFacts>,
): Map<string | null, TraceSummary[]> {
  const children = new Map<string | null, TraceSummary[]>();
  for (const entry of history.entries) {
    const trace = byId.get(entry.id);
    if (!trace) continue;
    const parent = entry.parent && byId.has(entry.parent) ? entry.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), trace]);
  }
  const made = (id: string) => madeAt(facts.get(id)?.key ?? id);
  for (const [parent, traces] of children) {
    if (parent !== null) traces.sort((a, b) => a.start - b.start || made(a.id) - made(b.id));
  }
  return children;
}

/** The how-manieth request of its page load a request the widget saw in flight was ("~…-7": 7); 0 for any other. */
export function madeAt(key: string): number {
  const match = /^~.*-(\d+)$/.exec(key);
  return match ? Number(match[1]) : 0;
}

/** Whether the requests come from more than one app: then each row names its own. */
export function manyApps(rows: readonly TraceRow[]): boolean {
  const apps = rows.filter((row) => row.trace.kind !== "page" && row.trace.service).map((row) => row.trace.service);
  return new Set(apps).size > 1;
}

/** Docked at the bottom, the tab's list reads oldest first, as in the Network tab; else newest first. */
export function inOrder(split: boolean, rows: readonly TraceRow[]): TraceRow[] {
  return split ? chronological(rows) : [...rows];
}

/** Oldest page first, each followed by its requests: new requests land at the bottom, as in the Network tab. */
function chronological(rows: readonly TraceRow[]): TraceRow[] {
  const pages: TraceRow[][] = [];
  for (const row of rows) {
    if (row.depth === 0 || pages.length === 0) pages.push([row]);
    else pages.at(-1)?.push(row);
  }
  return pages.reverse().flat();
}

/**
 * The rows of "this page", as the pill counts them: the page (or the SPA's view of its route), the actions done on
 * it, and their requests (lib/live: one scope everywhere).
 */
export function pageScope(history: TabHistory | null, rows: readonly TraceRow[]): TraceRow[] {
  if (!history?.current) return [];
  const scope = new Set(history.scope.length > 0 ? history.scope : [history.current]);
  const parents = new Map(history.entries.map((entry) => [entry.id, entry.parent]));
  // A view's calls from its chain: under the row above them.
  let head: string | null = null;
  return rows.filter((row) => {
    if (!row.depth) head = row.trace.id;
    const parent = parents.get(row.trace.id) ?? (row.depth ? head : null);
    return scope.has(row.trace.id) || scope.has(parent ?? "");
  });
}

/** The task runs each request led to, by its id. */
export type Runs = Readonly<Record<string, readonly TraceSummary[]>>;

export const NO_RUNS: Runs = {};

/**
 * How often while a row that just ended isn't stored yet: an app sends its trace as its request ends, and the agent
 * stores it within a moment; the row's numbers say "…" until the list knows (the pill, asking on its own, knows sooner).
 */
export const ARRIVING_POLL_MS = 400;

/** How long after its end a row not stored yet is asked for that often. */
const ARRIVING_SOON_MS = 10_000;

/** A request or an ended view of the tab the agent hasn't stored yet (`stored`), which ended a moment ago. */
export function justEnded(entry: TabEntry, stored: ReadonlySet<string>): boolean {
  const summary = entry.summary;
  if (!summary || summary.open || inFlight(entry.id) || summary.untraced || stored.has(entry.id)) return false;
  return Date.now() - (summary.start + summary.duration) / 1000 < ARRIVING_SOON_MS;
}

/**
 * Whether a trace of the tab's list is on its way to the agent: listed by the widget, not stored yet, and ended a
 * moment ago (a view still open counts from its start). Undefined for a trace the list doesn't have (a linked one).
 */
export function arrivingIn(
  rows: readonly TraceRow[],
  stored: ReadonlySet<string>,
  id: string | null,
): boolean | undefined {
  const row = rows.find((item) => item.trace.id === id);
  if (!row) return undefined;
  if (stored.has(row.trace.id)) return false;
  // Still running (a view open, a request the page waits for): on its way however long it takes.
  if (row.open) return true;
  const ended = (row.trace.start + row.trace.duration) / 1000;
  return Date.now() - ended < ARRIVING_MS;
}

/** The ids the agent may have: not a request still in flight, which has the widget's id until its answer names its trace. */
/** A row of the list still in flight (a view open, a request the page waits for): when it started, and what it is. */
export function runningIn(rows: readonly TraceRow[], id: string | null): Running | undefined {
  const row = rows.find((item) => item.trace.id === id);
  return row?.open ? { start: row.trace.start, view: row.trace.kind === "page", until: row.until } : undefined;
}

export function idsOf(history: TabHistory | null): string[] {
  return history?.entries.filter((entry) => !inFlight(entry.id)).map((entry) => entry.id) ?? [];
}

/** A request in flight, by the id the widget gives it until its answer names its trace. */
export function inFlight(id: string | null): boolean {
  return id?.startsWith("~") ?? false;
}

/* ---------- The chain under a row ---------- */

/** What a row says that its chain may have changed with: its time, queries, findings. */
export function rowKey(trace: TraceSummary): string {
  return `${trace.id}:${trace.duration}:${trace.queries}:${trace.issues}`;
}

/**
 * Each row followed by the task runs it led to, one step deeper, as they are recorded, each with its own findings: the
 * request's row doesn't count them again. A run is listed once.
 */
export function withRuns(rows: readonly TraceRow[], runs: Runs): TraceRow[] {
  const listed = new Set(rows.map((row) => row.trace.id));
  return rows.flatMap((row) => {
    const own = unlisted(runs[row.trace.id], listed);
    if (own.length === 0) return [row];
    const depth = row.depth ? 2 : 1;
    return [row, ...own.map((trace) => ({ trace, depth, run: true }) as const)];
  });
}

/** The runs not listed yet, now listed. */
function unlisted(runs: readonly TraceSummary[] = [], listed: Set<string>): TraceSummary[] {
  const fresh = runs.filter((run) => !listed.has(run.id));
  for (const run of fresh) listed.add(run.id);
  return fresh;
}

/**
 * What Follow new opens for the newest row: the row itself, or, for a request a view or an action in the browser
 * made, that view or action, stored yet or not (on its way, it says so until it is). Its call tree has all of its
 * requests, so the selection stays on it as they come and as it ends: never the request, then the view again.
 */
export function followTarget(rows: readonly TraceRow[]): string | undefined {
  const latest = rows.at(-1);
  if (latest?.depth !== 1) return latest?.trace.id;
  return groupOrRequest(rows, latest.trace.id);
}

/** The view or action heading the newest rows; else the request itself. */
function groupOrRequest(rows: readonly TraceRow[], request: string): string {
  const head = [...rows].reverse().find((row) => row.depth === 0);
  return head?.trace.kind === "page" ? head.trace.id : request;
}

/** What served the page, as its mark and name; the versions in the tooltip ("Python 3.12 · Django 6.0"). */
