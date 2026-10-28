// The traces other apps served for a list row's calls (theirs in turn), as rows under it: an app's traces in one
// summary row ("library-api · 37 traces"), then each of them in the order they started on the caller's clock, what
// each called under it, and so on down the chain. Three or more of one route in a row fold into a run (×36), open
// while the app has few traces. Plain data, no React: built from the chain the call tree and the trace's tabs read
// (`GET /traces/{id}/chain`), so the list says the same counts, under the same limits.

import type { Chain, ChainTrace, IssueKind, Trace, TraceSummary } from "../types";
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
  /** The apps it called in turn. */
  apps: ChainApp[];
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

export type ChainItem = ChainTraceRow | ChainRun;

/** One app's traces at one place down the chain: the summary row ("library-api · 37 traces"). */
export interface ChainApp {
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

function appsUnder(
  parents: ReadonlySet<string>,
  children: ReadonlyMap<string, Served[]>,
  chainKinds: ReadonlyMap<string, IssueKind[]>,
  seen: Set<string>,
  path: string,
): ChainApp[] {
  const below = [...parents].flatMap((id) => children.get(id) ?? []).filter((each) => !seen.has(each.id));
  for (const each of below) seen.add(each.id);
  below.sort((a, b) => a.trace.start - b.trace.start || a.id.localeCompare(b.id));
  const byApp = new Map<string, Served[]>();
  for (const each of below) byApp.set(each.app, [...(byApp.get(each.app) ?? []), each]);
  return [...byApp].map(([app, traces]) => {
    const key = `${path}/${app}`;
    const rows = traces.map(
      (each): ChainTraceRow => ({
        type: "trace",
        key: `${key}/${each.id}`,
        id: each.id,
        trace: each.trace,
        summary: together([each.trace], chainKinds),
        route: routeOf(each.trace),
        apps: appsUnder(new Set([each.id]), children, chainKinds, seen, `${key}/${each.id}`),
      }),
    );
    return {
      key,
      app,
      ids: traces.map((each) => each.id),
      summary: together(
        traces.map((each) => each.trace),
        chainKinds,
      ),
      items: runsOf(rows, key, rows.length <= RUN_OPEN_LIMIT, chainKinds),
    };
  });
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
export function chainApps(chain: Chain, root: string, listed: ReadonlySet<string> = new Set()): ChainApp[] {
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
  return appsUnder(new Set([root]), children, chainKinds, new Set([root]), root);
}
