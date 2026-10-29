// The traces other apps served for a list row's calls (theirs in turn), as rows under it: an app's traces in one
// summary row ("library-api · 37 traces"), then each of them in the order they started on the caller's clock, what
// each called under it, and so on down the chain. Three or more of one route in a row fold into a run (×36), open
// while the app has few traces. Plain data, no React: built from the chain the call tree and the trace's tabs read
// (`GET /traces/{id}/chain`), so the list says the same counts, under the same limits. A call whose trace hasn't
// reached the agent yet is a row too, waiting, where that trace's row will be (`ChainWaiting`).

import type { Chain, ChainTrace, IssueKind, Span, Trace, TraceSummary } from "../types";
import { onTheClock } from "./calls";

/** One trace of an app, a row of its own: its method and actual path, its route in the tooltip. */
export interface ChainTraceRow {
  type: "trace";
  key: string;
  id: string;
  trace: Trace;
  summary: TraceSummary;
  /** Its route ("GET /authors/{author_id}"), its name where it has none. */
  route: string;
  /** When the call it served started, on the chain's clock (its own start where the call isn't known). */
  called: number;
  /** The apps it called in turn, and its calls whose traces are on their way. */
  apps: ChainEntry[];
}

/** Consecutive traces of one route (three or more): one row (×N, their time on the clock), each of them under it. */
export interface ChainRun {
  type: "run";
  key: string;
  route: string;
  summary: TraceSummary;
  ids: string[];
  traces: ChainTraceRow[];
  /** Open until it is folded: while its app has at most RUN_OPEN_LIMIT traces. */
  open: boolean;
}

/**
 * A call a trace of the chain made whose trace isn't in the chain yet: the agent stores each app's trace as it gets
 * it, so a service's can come a moment after its caller's. Its method and path, from the call's span; replaced by
 * the trace's row once it arrives (in its app's rows when another call to the same host already named the app).
 */
export interface ChainWaiting {
  type: "waiting";
  key: string;
  method: string | null;
  path: string;
  /** When the call started and ended, on the chain's clock (µs). */
  start: number;
  end: number;
}

export type ChainItem = ChainTraceRow | ChainRun | ChainWaiting;

/** What a level of the chain lists: the apps called there, and the calls still waiting for an app's trace. */
export type ChainEntry = ChainApp | ChainWaiting;

/** One app's traces at one place down the chain: the summary row ("library-api · 37 traces"). */
export interface ChainApp {
  type: "app";
  key: string;
  app: string;
  ids: string[];
  /** Their numbers added up (queries, findings), their time on the clock. */
  summary: TraceSummary;
  /** Its traces in the order they started, runs of one route folded together. */
  items: ChainItem[];
}

/** Traces of one route in a row that make a run. */
export const RUN_MIN = 3;
/**
 * How long after a call ended its trace is waited for. A call carried the trace on (its span says which span the
 * callee's trace names as its parent: `w3c.span_id`), but that alone doesn't say the service it reached records
 * traces: a third-party API, or an app without tracepanel, never sends one. An app's SDK sends a trace as its request
 * ends and the agent stores it within a second or two, so a call is waited for this long after it ended, then its row
 * goes; a trace that comes later still shows as it arrives (the list asks for the chain again while the row is new).
 */
export const WAITING_MS = 5_000;
/** An app with up to this many traces has its runs open: all of them in order, at a glance. */
export const RUN_OPEN_LIMIT = 50;

type Served = ChainTrace & { trace: Trace };

function served(each: ChainTrace): each is Served {
  return each.trace !== undefined;
}

function queriesOf(trace: Trace): number {
  return trace.spans.filter((span) => span.kind === "sql").length;
}

/** A trace as the list names a request: its method and its route (the path where it has none). */
// biome-ignore-start lint/style/useNamingConvention: builds an API object; its field names are the wire format.
function summaryOf(trace: Trace): TraceSummary {
  const attr = (key: string) => {
    const value = trace.attrs[key];
    return typeof value === "string" ? value : null;
  };
  const status = trace.attrs["http.status_code"];
  return {
    id: trace.id,
    service: typeof trace.attrs["service.name"] === "string" ? String(trace.attrs["service.name"]) : "",
    kind: trace.kind as TraceSummary["kind"],
    name: trace.name,
    start: trace.start,
    duration: trace.duration,
    status: trace.status === "error" ? "error" : "ok",
    http_status: typeof status === "number" ? status : null,
    method: attr("http.method"),
    path: attr("http.path") ?? attr("http.route"),
    route: attr("http.route"),
    view: null,
    user_id: null,
    queries: queriesOf(trace),
    db_time: 0,
    issues: trace.issues.length,
    errors: trace.errors.length,
    logs: trace.logs.length,
    mails: 0,
    issue_kinds: [...new Set(trace.issues.map((issue) => issue.kind))],
    db_aliases: [],
    cache_aliases: [],
    task_state: null,
    htmx: null,
  };
}
// biome-ignore-end lint/style/useNamingConvention: builds an API object; its field names are the wire format.

/**
 * Several traces as one row: the first's name, their queries and findings added up (the chain's own N+1 across apps
 * on the traces that made the calls), their time on the clock (from the first's start to the last's end, overlaps
 * once, as the call tree's groups say it).
 */
function together(traces: readonly Trace[], chainKinds: ReadonlyMap<string, IssueKind[]>): TraceSummary {
  const first = summaryOf(traces[0] as Trace);
  const each = traces.map(summaryOf);
  const kinds = new Set(each.flatMap((one) => one.issue_kinds));
  let issues = each.reduce((sum, one) => sum + one.issues, 0);
  for (const trace of traces) {
    for (const kind of chainKinds.get(trace.id) ?? []) {
      kinds.add(kind);
      issues += 1;
    }
  }
  return {
    ...first,
    duration: onTheClock(traces),
    status: each.some((one) => one.status === "error") ? "error" : "ok",
    queries: each.reduce((sum, one) => sum + one.queries, 0),
    issues,
    errors: each.reduce((sum, one) => sum + one.errors, 0),
    // biome-ignore lint/style/useNamingConvention: wire format.
    issue_kinds: [...kinds],
  };
}

/** What a group of traces is: its app, its kind, and its route (its name where it has none). */
function routeOf(trace: Trace): string {
  const route = trace.attrs["http.route"];
  const method = trace.attrs["http.method"];
  return typeof route === "string" && typeof method === "string" ? `${method} ${route}` : trace.name;
}

/** The kinds of span that call a service which may record a trace of its own (not a message: it runs any time later). */
const CALL_KINDS = new Set(["http.client", "grpc", "rpc", "otel"]);

function text(attrs: Span["attrs"], key: string): string | null {
  const value = attrs[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The URL a call went to, when its span says it. */
function urlOf(span: Span): URL | null {
  const full = text(span.attrs, "url.full") ?? text(span.attrs, "http.url");
  if (!full) return null;
  try {
    return new URL(full);
  } catch {
    return null;
  }
}

/** Where a call went: its host and port (local apps differ by port alone). */
function hostOf(span: Span): string | null {
  const url = urlOf(span);
  if (url) return url.host;
  const address = text(span.attrs, "server.address") ?? text(span.attrs, "net.peer.name");
  const port = span.attrs["server.port"] ?? span.attrs["net.peer.port"];
  return address ? `${address}${typeof port === "number" || typeof port === "string" ? `:${port}` : ""}` : null;
}

/** A call that carried the trace on to a service: a service that records traces answers it with one. */
function carries(span: Span): boolean {
  return CALL_KINDS.has(span.kind) && text(span.attrs, "w3c.span_id") !== null && !("messaging.system" in span.attrs);
}

/** A waiting call's row: its method and path as the span says them ("GET /authors/batch"). */
function waitingOf(span: Span, key: string): ChainWaiting {
  const method = text(span.attrs, "http.request.method") ?? text(span.attrs, "http.method");
  const [first = "", ...rest] = span.name.split(" ");
  const named = /^[A-Z]+$/.test(first);
  const path = urlOf(span)?.pathname ?? text(span.attrs, "url.path") ?? (named ? rest.join(" ") : span.name);
  return {
    type: "waiting",
    key: `${key}/waiting/${span.id}`,
    method: method ?? (named ? first : null),
    path: path || span.name,
    start: span.start,
    end: span.start + span.duration,
  };
}

/** A waiting call with the host it went to, by the trace that made it. */
type Pending = { row: ChainWaiting; host: string | null };

/**
 * The calls of the chain's traces whose traces haven't arrived (by the trace that made them): those that carried the
 * trace on, no trace of the chain names them, and they ended less than WAITING_MS ago (`now`, µs). None when a limit
 * left traces out of the chain: those calls' traces aren't missing.
 */
function waitingCalls(chain: Chain, now: number): Map<string, Pending[]> {
  const waiting = new Map<string, Pending[]>();
  if (chain.capped) return waiting;
  const answered = new Set(chain.traces.map((each) => `${each.parent}/${each.via}`));
  for (const each of chain.traces.filter(served)) {
    const calls = each.trace.spans.filter(
      (span) =>
        carries(span) &&
        !answered.has(`${each.id}/${span.id}`) &&
        now - (span.start + span.duration) < WAITING_MS * 1000,
    );
    if (calls.length === 0) continue;
    waiting.set(
      each.id,
      calls.map((span) => ({ row: waitingOf(span, each.id), host: hostOf(span) })),
    );
  }
  return waiting;
}

/** When the first of the chain's waiting calls stops being waited for (ms), if any is. */
export function waitingUntil(chain: Chain, now: number = Date.now()): number | null {
  const ends = [...waitingCalls(chain, now * 1000).values()].flat().map((each) => each.row.end / 1000 + WAITING_MS);
  return ends.length > 0 ? Math.min(...ends) : null;
}

function startOf(item: ChainItem | ChainEntry): number {
  if (item.type === "waiting") return item.start;
  if (item.type === "trace") return item.called;
  if (item.type === "run") return (item.traces[0] as ChainTraceRow).called;
  return startOf(item.items[0] as ChainItem);
}

/**
 * Rows in order with waiting calls put in by when they started, as the rows' calls did: each where its trace's row
 * will be.
 */
function inOrder<T extends ChainItem | ChainEntry>(rows: readonly T[], waiting: readonly ChainWaiting[]): T[] {
  const out = [...rows];
  for (const call of [...waiting].sort((a, b) => a.start - b.start)) {
    const at = out.findIndex((row) => startOf(row) > call.start);
    out.splice(at === -1 ? out.length : at, 0, call as T);
  }
  return out;
}

interface Context {
  children: ReadonlyMap<string, Served[]>;
  waiting: ReadonlyMap<string, Pending[]>;
  /** Each trace of the chain by its id. */
  traces: ReadonlyMap<string, Served>;
  chainKinds: ReadonlyMap<string, IssueKind[]>;
  seen: Set<string>;
}

function appsUnder(parents: ReadonlySet<string>, context: Context, path: string): ChainEntry[] {
  const { children, chainKinds, seen } = context;
  const below = [...parents].flatMap((id) => children.get(id) ?? []).filter((each) => !seen.has(each.id));
  for (const each of below) seen.add(each.id);
  below.sort((a, b) => a.trace.start - b.trace.start || a.id.localeCompare(b.id));
  const byApp = new Map<string, Served[]>();
  for (const each of below) byApp.set(each.app, [...(byApp.get(each.app) ?? []), each]);
  // A waiting call to a host an arrived call reached: that app's, among its traces. Else a row of its own.
  const hosts = new Map<string, string>();
  const calls = new Map<string, Span>();
  for (const each of below) {
    const parent = each.parent ? context.traces.get(each.parent) : undefined;
    const call = parent?.trace.spans.find((span) => span.id === each.via);
    if (!call) continue;
    calls.set(each.id, call);
    const host = hostOf(call);
    if (host) hosts.set(host, each.app);
  }
  const waiting = [...parents].flatMap((id) => context.waiting.get(id) ?? []);
  const waitingIn = (app: string | undefined): ChainWaiting[] =>
    waiting
      .filter((each) => (each.host === null ? undefined : hosts.get(each.host)) === app)
      .map((each) => ({ ...each.row, key: `${path}/${each.row.key}` }));
  const apps = [...byApp].map(([app, traces]): ChainApp => {
    const key = `${path}/${app}`;
    const rows = traces.map(
      (each): ChainTraceRow => ({
        type: "trace",
        key: `${key}/${each.id}`,
        id: each.id,
        trace: each.trace,
        summary: together([each.trace], chainKinds),
        route: routeOf(each.trace),
        called: calls.get(each.id)?.start ?? each.trace.start,
        apps: appsUnder(new Set([each.id]), context, `${key}/${each.id}`),
      }),
    );
    return {
      type: "app",
      key,
      app,
      ids: traces.map((each) => each.id),
      summary: together(
        traces.map((each) => each.trace),
        chainKinds,
      ),
      items: inOrder(runsOf(rows, key, rows.length <= RUN_OPEN_LIMIT, chainKinds), waitingIn(app)),
    };
  });
  return inOrder<ChainEntry>(apps, waitingIn(undefined));
}

/** The rows in order, three or more of one route in a row folded into a run (keyed by its first trace). */
function runsOf(
  rows: readonly ChainTraceRow[],
  key: string,
  open: boolean,
  chainKinds: ReadonlyMap<string, IssueKind[]>,
): ChainItem[] {
  const items: ChainItem[] = [];
  let at = 0;
  while (at < rows.length) {
    const route = (rows[at] as ChainTraceRow).route;
    let end = at + 1;
    while (end < rows.length && (rows[end] as ChainTraceRow).route === route) end += 1;
    const members = rows.slice(at, end);
    if (members.length >= RUN_MIN) {
      const first = members[0] as ChainTraceRow;
      items.push({
        type: "run",
        key: `${key}/run/${first.id}`,
        route,
        // Named by the route, not the first one's path: the run is all of them.
        summary: {
          ...together(
            members.map((each) => each.trace),
            chainKinds,
          ),
          path: first.summary.route,
        },
        ids: members.map((each) => each.id),
        traces: members,
        open,
      });
    } else {
      items.push(...members);
    }
    at = end;
  }
  return items;
}

/**
 * The rows under a list row whose trace called other apps: each app it called, by route, and theirs in turn. The
 * traces in `listed` are rows of the list already (a request a page made), with what is under them: left out.
 */
export function chainApps(
  chain: Chain,
  root: string,
  listed: ReadonlySet<string> = new Set(),
  /** Now, in ms: the calls that ended a moment before it are waited for. */
  now: number = Date.now(),
): ChainEntry[] {
  const children = new Map<string, Served[]>();
  for (const each of chain.traces.filter(served)) {
    if (each.parent === null || each.id === root || listed.has(each.id)) continue;
    children.set(each.parent, [...(children.get(each.parent) ?? []), each]);
  }
  // The chain's N+1 across apps is the calling trace's finding: its row says it.
  const chainKinds = new Map<string, IssueKind[]>();
  for (const issue of chain.issues) {
    chainKinds.set(issue.trace_id, [...(chainKinds.get(issue.trace_id) ?? []), issue.kind]);
  }
  chainKinds.delete(root);
  const traces = new Map(chain.traces.filter(served).map((each) => [each.id, each]));
  const waiting = waitingCalls(chain, now * 1000);
  return appsUnder(new Set([root]), { children, waiting, traces, chainKinds, seen: new Set([root]) }, root);
}
