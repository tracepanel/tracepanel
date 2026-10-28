import type { Counts, DataSource, ServiceApp } from "@tracepanel/ui";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useSearch } from "./data";

/**
 * Which app the console shows, when several send to one agent (service.name): one choice for every page, kept in
 * this browser. "" is all of them. The searches stay as typed; the source adds `service:` to each.
 *
 * Another app chosen, the console switches once its counts are in (`pending` until then): the menu, the switcher and
 * the pages change together, the menu with the new app's sections, never the last app's for a moment.
 */
interface Scope {
  service: string;
  setService: (service: string) => void;
  /** The app being switched to, while its counts load. */
  pending: string | null;
  /** The counts the switch loaded, for the app it switched to: the menu's until the console's own load answers. */
  switched: { service: string; counts: Counts | undefined } | null;
}

const KEY = "tracepanel:service";

const ScopeContext = createContext<Scope>({
  service: "",
  setService: () => undefined,
  pending: null,
  switched: null,
});

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function store(service: string): void {
  try {
    localStorage.setItem(KEY, service);
  } catch {
    // Blocked storage: the choice lasts until reload.
  }
}

export function ScopeProvider({ source, children }: { source: DataSource; children: ReactNode }) {
  const [service, setServiceState] = useState(read);
  const [pending, setPending] = useState<string | null>(null);
  const [switched, setSwitched] = useState<Scope["switched"]>(null);
  // Only the last choice switches: one made quickly after another doesn't end on the earlier one's answer.
  const latest = useRef(0);
  const setService = useCallback(
    (next: string) => {
      const id = ++latest.current;
      setPending(next);
      const commit = (counts: Counts | undefined) => {
        if (id !== latest.current) return;
        store(next);
        setSwitched({ service: next, counts });
        setServiceState(next);
        setPending(null);
      };
      // Counts that failed: the console switches anyway, and its menu loads as on a first visit.
      scopedSource(source, next)
        .counts()
        .then(commit, () => commit(undefined));
    },
    [source],
  );
  const value = useMemo<Scope>(
    () => ({ service, setService, pending, switched }),
    [service, setService, pending, switched],
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
    liveTasks: () => source.liveTasks(service),
    listWebsockets: (query) => source.listWebsockets(q(query)),
    listGraphql: (query) => source.listGraphql(q(query)),
    listJobs: (query) => source.listJobs(q(query)),
    listRpcs: (query) => source.listRpcs(q(query)),
    listPages: (query) => source.listPages(q(query)),
    summarizeTraces: (query) => source.summarizeTraces(q(query)),
    listServices: (query) => source.listServices(q(query)),
    listAws: (query) => source.listAws(q(query)),
    listAwsCalls: (query) => source.listAwsCalls(q(query)),
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
