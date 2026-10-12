import type { DataSource, ServiceApp } from "@tracepanel/ui";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useSearch } from "./data";

/**
 * Which app the console shows, when several send to one agent (service.name): one choice for every page, kept in
 * this browser. "" is all of them. The searches stay as typed; the source adds `service:` to each.
 */
interface Scope {
  service: string;
  setService: (service: string) => void;
}

const KEY = "tracepanel:service";

const ScopeContext = createContext<Scope>({ service: "", setService: () => undefined });

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [service, setServiceState] = useState(read);
  const value = useMemo<Scope>(
    () => ({
      service,
      setService: (next) => {
        try {
          localStorage.setItem(KEY, next);
        } catch {
          // Blocked storage: the choice lasts until reload.
        }
        setServiceState(next);
      },
    }),
    [service],
  );
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): Scope {
  return useContext(ScopeContext);
}

/** The query with the app's filter in front; a query that names a service itself keeps its own. */
function scoped(q: string, service: string): string {
  if (!service || /(^|\s)-?service:/.test(q)) return q;
  const filter = /[\s"]/.test(service) ? `service:"${service}"` : `service:${service}`;
  return q.trim() ? `${filter} ${q}` : filter;
}

/** The source as one app sees it: every search and the sidebar's numbers narrowed to `service`. */
export function scopedSource(source: DataSource, service: string): DataSource {
  if (!service) return source;
  const q = (query: string) => scoped(query, service);
  return {
    ...source,
    searchTraces: (query, before) => source.searchTraces(q(query), before),
    searchLogs: (query, before) => source.searchLogs(q(query), before),
    searchMails: (query, before) => source.searchMails(q(query), before),
    listCalls: (system, query) => source.listCalls(system, q(query)),
    callsSummary: (system, query) => source.callsSummary(system, q(query)),
    listEndpoints: (query) => source.listEndpoints(q(query)),
    listTasks: (query) => source.listTasks(q(query)),
    listWebsockets: (query) => source.listWebsockets(q(query)),
    listGraphql: (query) => source.listGraphql(q(query)),
    listJobs: (query) => source.listJobs(q(query)),
    summarizeTraces: (query) => source.summarizeTraces(q(query)),
    listServices: (query) => source.listServices(q(query)),
    tracesOverview: (query, group) => source.tracesOverview(q(query), group),
    listIssues: (query) => source.listIssues(q(query ?? "")),
    getIssue: (fingerprint, query) => source.getIssue(fingerprint, q(query ?? "")),
    getEndpoint: (method, route) => source.getEndpoint(method, route, service),
    getGraphqlOperation: (operation) => source.getGraphqlOperation(operation, service),
    knownValues: () => source.knownValues(service),
    counts: () => source.counts(service),
  };
}

/** One entry per app (its roles merged), with what runs it: the switcher's choices. */
export interface App {
  service: string;
  runtime: string | null;
}

/** The apps in the store, from every source's point of view (not narrowed): undefined until loaded. */
export function useApps(source: DataSource): App[] | undefined {
  const apps = useSearch(
    useCallback(() => source.listServices("kind:app"), [source]),
    "",
    3,
  ).data?.apps;
  return useMemo(() => (apps ? merge(apps) : undefined), [apps]);
}

function merge(apps: ServiceApp[]): App[] {
  const seen = new Map<string, App>();
  for (const app of apps) {
    const known = seen.get(app.service);
    if (!known) seen.set(app.service, { service: app.service, runtime: app.runtime });
    else known.runtime ??= app.runtime;
  }
  return [...seen.values()].sort((a, b) => a.service.localeCompare(b.service));
}
