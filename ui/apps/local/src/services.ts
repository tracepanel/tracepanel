// What the Services page shows, as data: the project's apps by project, and where each node leads in the console.
import type { ServiceApp, ServiceNode } from "@tracepanel/ui";
import { SQL_VENDORS } from "@tracepanel/ui/lib/systems";
import { callsSection, currentPeriod, type Route, withPeriod } from "./routes";

/** The page of a service's operations: SQL for every SQL database, the cache's, HTTP calls, a datastore's own. */
function pageOfService(node: ServiceNode): string | null {
  return PAGE_OF_KIND[node.kind]?.(node.system) ?? null;
}

const PAGE_OF_KIND: Partial<Record<ServiceNode["kind"], (system: string) => string>> = {
  database: (system) => (SQL_VENDORS.has(system) ? "sql" : system),
  cache: () => "cache",
  http: (system) => (WEB.has(system) ? "http" : system),
};
const WEB = new Set(["http", "https"]);

/** Where to look next: the system's page (its operations to that database, cache or API), else the traces. */
export function serviceTarget(node: ServiceNode): Route {
  const aliases = node.aliases.join(",");
  const page = pageOfService(node);
  if (page) return { name: callsSection(page), q: aliases ? `target:${aliases}` : "" };
  if (node.kind === "mail") return { name: "mails", q: "" };
  // A broker and an HTTP API: the traces that called it (a worker's tasks taking from the broker included).
  return { name: "traces", q: withPeriod(`peer:${node.id}`, currentPeriod()) };
}

/** Where an app's own work is listed: requests for web, tasks for a worker, runs for a command. */
export function appTarget(app: ServiceApp): Route {
  if (app.role === "web") return { name: "endpoints", q: "" };
  if (app.role === "worker") return { name: "tasks", q: "" };
  if (app.role === "command") return { name: "jobs", q: "" };
  return { name: "traces", q: "" };
}

/** One project, however many roles it runs as (web, worker, command): its rows summed, the busiest role first. */
export interface App extends Omit<ServiceApp, "role"> {
  roles: ServiceApp[];
  /** Where the row goes: the role with the most traces. */
  busiest: ServiceApp;
}

function sum(roles: readonly ServiceApp[], field: "traces" | "errors" | "total"): number {
  return roles.reduce((total, role) => total + role[field], 0);
}

/** A project's roles summed, the busiest first. */
function project(roles: readonly ServiceApp[]): App {
  const sorted = [...roles].sort((a, b) => b.traces - a.traces);
  const busiest = sorted[0] as ServiceApp;
  return {
    service: busiest.service,
    runtime: sorted.find((role) => role.runtime)?.runtime ?? null,
    traces: sum(sorted, "traces"),
    errors: sum(sorted, "errors"),
    total: sum(sorted, "total"),
    // biome-ignore lint/style/useNamingConvention: the API's field, as ServiceApp has it.
    last_seen: Math.max(...sorted.map((role) => role.last_seen)),
    roles: sorted,
    busiest,
  };
}

export function byProject(apps: readonly ServiceApp[]): App[] {
  const projects = new Map<string, ServiceApp[]>();
  for (const app of apps) projects.set(app.service, [...(projects.get(app.service) ?? []), app]);
  return [...projects.values()].map(project);
}
