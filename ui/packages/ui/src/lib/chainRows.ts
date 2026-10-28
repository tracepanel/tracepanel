// The traces other apps served for a list row's calls (theirs in turn), as rows under it: an app's traces in one
// summary row, then by route (36 calls of GET /authors/{author_id} one row, ×36), then what those called, and so on
// down the chain. Plain data, no React: built from the chain the call tree and the trace's tabs read
// (`GET /traces/{id}/chain`), so the list says the same counts, under the same limits.

import type { Chain, ChainTrace, IssueKind, Trace, TraceSummary } from "../types";
import { onTheClock } from "./calls";

/** Traces of one route of one app, called from the same traces: one row (×N), the first of them opened from it. */
export interface ChainGroup {
  key: string;
  /** The first trace as a list row names it (its method and route), with the group's numbers. */
  summary: TraceSummary;
  ids: string[];
  /** The apps those traces called in turn. */
  apps: ChainApp[];
}

/** One app's traces at one place down the chain: the summary row ("library-api · 37 traces"). */
export interface ChainApp {
  key: string;
  app: string;
  ids: string[];
  /** Their numbers added up (queries, findings), their time on the clock. */
  summary: TraceSummary;
  groups: ChainGroup[];
}

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
    path: attr("http.route") ?? attr("http.path"),
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
  below.sort((a, b) => a.trace.start - b.trace.start);
  const byApp = new Map<string, Served[]>();
  for (const each of below) byApp.set(each.app, [...(byApp.get(each.app) ?? []), each]);
  return [...byApp].map(([app, traces]) => {
    const key = `${path}/${app}`;
    const byRoute = new Map<string, Served[]>();
    for (const each of traces) {
      const route = routeOf(each.trace);
      byRoute.set(route, [...(byRoute.get(route) ?? []), each]);
    }
    const groups = [...byRoute].map(([route, members]): ChainGroup => {
      const ids = members.map((each) => each.id);
      const groupKey = `${key}/${route}`;
      return {
        key: groupKey,
        summary: together(
          members.map((each) => each.trace),
          chainKinds,
        ),
        ids,
        apps: appsUnder(new Set(ids), children, chainKinds, seen, groupKey),
      };
    });
    return {
      key,
      app,
      ids: traces.map((each) => each.id),
      summary: together(
        traces.map((each) => each.trace),
        chainKinds,
      ),
      groups,
    };
  });
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
