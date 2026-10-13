import type { Snapshot } from "./snapshot";
import type {
  CallRow,
  CallsSummary,
  Counts,
  EndpointDetail,
  EndpointRow,
  ExplainPlan,
  GraphqlDetail,
  GraphqlRow,
  IssueDetail,
  IssueRow,
  JobRow,
  KnownValues,
  LogRow,
  MailRow,
  Page,
  Related,
  SearchSpec,
  ServiceMap,
  TaskRow,
  Trace,
  TraceGroup,
  TraceSummary,
  TracesOverview,
  User,
  WebsocketRow,
} from "./types";

// biome-ignore-start lint/style/useNamingConvention: wire format.
const EMPTY_OVERVIEW: TracesOverview = {
  summary: null,
  series: [],
  histogram: [],
  slow_threshold: 500_000,
  kinds: [],
  slowest: [],
  failing: [],
};
// biome-ignore-end lint/style/useNamingConvention: wire format.

/** A search query the API rejected (unknown filter, bad value): `message` is meant for the user. */
export class SearchError extends Error {}

/**
 * Where the UI gets its data: an app's /__tracepanel__/api/ or the agent itself.
 * Components never fetch; apps pass data from a source down as props.
 */
export interface DataSource {
  listTraces(query?: { ids?: readonly string[]; limit?: number }): Promise<TraceSummary[]>;
  searchTraces(q: string, before?: number | null): Promise<Page<TraceSummary>>;
  getTrace(id: string): Promise<Trace | null>;
  searchLogs(q: string, before?: number | null): Promise<Page<LogRow>>;
  searchMails(q: string, before?: number | null): Promise<Page<MailRow>>;
  /** One system's calls (`sql`, `redis`, `http`, `mongodb`, `neo4j`…) by what they repeat, heaviest first. */
  listCalls(system: string, q: string): Promise<CallRow[]>;
  /** The same calls at a glance, over all of them: how many, their time, how many failed. */
  callsSummary(system: string, q: string): Promise<CallsSummary | null>;
  listEndpoints(q: string): Promise<EndpointRow[]>;
  listTasks(q: string): Promise<TaskRow[]>;
  listWebsockets(q: string): Promise<WebsocketRow[]>;
  listGraphql(q: string): Promise<GraphqlRow[]>;
  /** With `service`, only that app's calls. */
  getGraphqlOperation(operation: string, service?: string): Promise<GraphqlDetail | null>;
  listJobs(q: string): Promise<JobRow[]>;
  /** Any group of traces named by a search: what a group page shows. */
  summarizeTraces(q: string): Promise<TraceGroup | null>;
  /** Databases, caches, mail, brokers and APIs the project talks to, and who calls them. */
  listServices(q: string): Promise<ServiceMap>;
  /** The trace that enqueued this one, and the traces it enqueued (Celery). */
  related(traceId: string): Promise<Related>;
  /** With `service`, only that app's calls: two apps can serve the same route. */
  getEndpoint(method: string, route: string, service?: string): Promise<EndpointDetail | null>;
  /** `group`: "endpoint" groups requests by method + route (the HTTP page), "operation" by trace name. */
  tracesOverview(q: string, group?: "operation" | "endpoint"): Promise<TracesOverview>;
  /** With `service`, only the values that app's pages can find. */
  knownValues(service?: string): Promise<KnownValues>;
  /** The sidebar's numbers; with `service`, only that app's (service.name). */
  counts(service?: string): Promise<Counts>;
  /** The user of this browser session; null when anonymous. Development only. */
  /** null when anonymous; rejects where switching users isn't offered (FastAPI, Django without auth). */
  currentUser(): Promise<User | null>;
  searchUsers(q: string): Promise<User[]>;
  /** Log this browser session in as another user (or out with null). */
  switchUser(id: string | null): Promise<User | null>;
  explain(traceId: string, spanId: string, analyze: boolean): Promise<ExplainPlan>;
  listIssues(q?: string): Promise<IssueRow[]>;
  /** One issue; with `q` (since:, until:), its series and requests within that period. */
  getIssue(fingerprint: string, q?: string): Promise<IssueDetail | null>;
  searchSpec(): Promise<SearchSpec>;
  /** Delete everything stored; resolves to how many traces. Optional: a source may not offer it. */
  clearStore?: () => Promise<number>;
  /** A trace to share and what is linked to it; with `values`, what otherwise stays local. Optional too. */
  snapshot?: (traceId: string, values: boolean) => Promise<Snapshot | null>;
}

async function getJson<T>(url: URL): Promise<T | null> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (response.status === 400) {
    const body = (await response.json()) as { error?: string };
    throw new SearchError(body.error ?? "Invalid search");
  }
  if (!response.ok) throw new Error(`tracepanel API ${url.pathname}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** No linked traces: what a trace page shows when the API has nothing (or is unreachable). */
const NO_RELATED: Related = {
  // biome-ignore lint/style/useNamingConvention: wire format.
  enqueued_by: null,
  enqueued: [],
  connection: null,
  // biome-ignore lint/style/useNamingConvention: wire format.
  connection_events: [],
  // biome-ignore lint/style/useNamingConvention: wire format.
  sent_by: null,
  delivered: [],
  // biome-ignore lint/style/useNamingConvention: wire format.
  called_by: null,
  calls: [],
  via: {},
};

/** Source for the shared JSON API contract under `base` (for example "/__tracepanel__/api/"). */
export function httpSource(base: string | URL): DataSource {
  const root = new URL(base, location.href);
  const url = (path: string, params: Record<string, string | number | null | undefined> = {}): URL => {
    const result = new URL(path, root);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") result.searchParams.set(key, String(value));
    }
    return result;
  };
  return {
    async listTraces(query = {}) {
      const params = { ids: query.ids?.length ? query.ids.join(",") : undefined, limit: query.limit };
      return (await getJson<{ traces: TraceSummary[] }>(url("traces", params)))?.traces ?? [];
    },
    async searchTraces(q, before) {
      const body = await getJson<{ traces: TraceSummary[]; next: number | null }>(url("traces", { q, before }));
      return { items: body?.traces ?? [], next: body?.next ?? null };
    },
    getTrace(id) {
      return getJson<Trace>(url(`traces/${encodeURIComponent(id)}`));
    },
    async searchLogs(q, before) {
      const body = await getJson<{ logs: LogRow[]; next: number | null }>(url("logs", { q, before }));
      return { items: body?.logs ?? [], next: body?.next ?? null };
    },
    async searchMails(q, before) {
      const body = await getJson<{ mails: MailRow[]; next: number | null }>(url("mails", { q, before }));
      return { items: body?.mails ?? [], next: body?.next ?? null };
    },
    async listCalls(system, q) {
      return (await getJson<{ calls: CallRow[] }>(url("calls", { system, q })))?.calls ?? [];
    },
    async callsSummary(system, q) {
      return (await getJson<CallsSummary>(url("calls/summary", { system, q }))) ?? null;
    },
    async listEndpoints(q) {
      return (await getJson<{ endpoints: EndpointRow[] }>(url("endpoints", { q })))?.endpoints ?? [];
    },
    async tracesOverview(q = "", group = "operation") {
      return (await getJson<TracesOverview>(url("traces/overview", { q, group }))) ?? EMPTY_OVERVIEW;
    },
    async explain(trace, span, analyze) {
      const response = await fetch(url("explain", { trace, span, analyze: analyze ? 1 : null }));
      const body: unknown = await response.json();
      if (!response.ok) {
        const message = (body as { error?: string } | null)?.error;
        throw new Error(message ?? `tracepanel API explain: HTTP ${response.status}`);
      }
      return body as ExplainPlan;
    },
    async currentUser() {
      const found = await getJson<{ user: User | null }>(url("users/me"));
      // No users/me at all: this backend can't switch users, so the widget shows no button for it.
      if (found === null) throw new Error("user switching is not available");
      return found.user;
    },
    async searchUsers(q) {
      return (await getJson<{ users: User[] }>(url("users", { q })))?.users ?? [];
    },
    async switchUser(id) {
      const response = await fetch(url("users/switch"), {
        method: "POST",
        // The header proves the request comes from tracepanel's own page, not another site.
        headers: { "content-type": "application/json", "x-tracepanel": "1" },
        // biome-ignore lint/style/useNamingConvention: wire format.
        body: JSON.stringify({ user_id: id }),
      });
      const body = (await response.json()) as { user?: User | null; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body.user ?? null;
    },
    async clearStore() {
      // A DELETE: another site can't send one without a CORS preflight, which the console never allows.
      const response = await fetch(url("store"), { method: "DELETE", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`tracepanel API /store: HTTP ${response.status}`);
      return ((await response.json()) as { deleted: number }).deleted;
    },
    async counts(service) {
      return (
        (await getJson<Counts>(url("counts", { service }))) ?? {
          issues: 0,
          errors: 0,
          sections: {
            http: 0,
            graphql: 0,
            tasks: 0,
            websockets: 0,
            jobs: 0,
            systems: [],
          },
        }
      );
    },
    async knownValues(service) {
      return (
        (await getJson<KnownValues>(url("values", { service }))) ?? {
          route: [],
          logger: [],
          db: [],
          targets: {},
          ops: {},
          task: [],
          queue: [],
          job: [],
          extra: [],
        }
      );
    },
    async listTasks(q = "") {
      return (await getJson<{ tasks: TaskRow[] }>(url("tasks", { q })))?.tasks ?? [];
    },
    getGraphqlOperation(operation, service) {
      return getJson<GraphqlDetail>(url("graphql/detail", { operation, service }));
    },
    async listJobs(q = "") {
      return (await getJson<{ jobs: JobRow[] }>(url("jobs", { q })))?.jobs ?? [];
    },
    summarizeTraces(q) {
      return getJson<TraceGroup>(url("traces/summary", { q }));
    },
    async listGraphql(q = "") {
      return (await getJson<{ graphql: GraphqlRow[] }>(url("graphql", { q })))?.graphql ?? [];
    },
    async listWebsockets(q = "") {
      return (await getJson<{ websockets: WebsocketRow[] }>(url("websockets", { q })))?.websockets ?? [];
    },
    async listServices(q = "") {
      return (await getJson<ServiceMap>(url("services", { q }))) ?? { apps: [], links: [], services: [], edges: [] };
    },
    async related(traceId) {
      return (await getJson<Related>(url(`traces/${traceId}/related`))) ?? NO_RELATED;
    },
    getEndpoint(method, route, service) {
      return getJson<EndpointDetail>(url("endpoints/detail", { method, route, service }));
    },
    getIssue(fingerprint, q = "") {
      return getJson<IssueDetail>(url("issues/detail", { fingerprint, q }));
    },
    async listIssues(q = "") {
      return (await getJson<{ issues: IssueRow[] }>(url("issues", { q })))?.issues ?? [];
    },
    async searchSpec() {
      return (await getJson<SearchSpec>(url("search"))) ?? ({} as SearchSpec);
    },
  };
}
