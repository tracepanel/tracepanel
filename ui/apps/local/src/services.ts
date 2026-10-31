// What the Services page shows, as data: the project's apps by project, its services by host, and where each leads.
import {
  SERVICE_KINDS,
  type ServiceApp,
  type ServiceEdge,
  type ServiceNode,
  serviceRuntime,
  serviceWhere,
} from "@tracepanel/ui";
import { SQL_VENDORS } from "@tracepanel/ui/lib/systems";
import { callsSection, currentPeriod, type Route, type Section, withPeriod } from "./routes";

/**
 * The page of a service's operations: SQL for every SQL database, the cache's, the storages', HTTP calls, a
 * datastore's own.
 */
function pageOfService(node: ServiceNode): string | null {
  return PAGE_OF_KIND[node.kind]?.(node.system) ?? null;
}

const PAGE_OF_KIND: Partial<Record<ServiceNode["kind"], (system: string) => string>> = {
  database: (system) => (SQL_VENDORS.has(system) ? "sql" : system),
  cache: () => "cache",
  storage: () => "storage",
  http: (system) => (WEB.has(system) ? "http" : system),
};
const WEB = new Set(["http", "https"]);

/** Where to look next: the system's page (its operations to that database, cache or API), else the traces. */
export function serviceTarget(node: ServiceNode): Route {
  // An AWS service: its calls on the AWS page, which leads on to S3's on Storage, DynamoDB's, SQS's.
  if (node.cloud) return { name: "aws", q: awsTerm(node.cloud.service) };
  const aliases = node.aliases.join(",");
  const page = pageOfService(node);
  if (page) return { name: callsSection(page), q: aliases ? `target:${aliases}` : "" };
  if (node.kind === "mail") return { name: "mails", q: "" };
  // A broker and an HTTP API: the traces that called it (a worker's tasks taking from the broker included).
  return { name: "traces", q: withPeriod(`peer:${node.id}`, currentPeriod()) };
}

/** The AWS page's search for one service: `aws:S3`, `aws:"Secrets Manager"`. */
function awsTerm(service: string): string {
  return /\s/.test(service) ? `aws:"${service}"` : `aws:${service}`;
}

// Where an app's own work is listed: requests for web, tasks for a worker, runs for a command, views for a browser.
const ROLE_SECTIONS: Record<string, Section> = {
  web: "endpoints",
  worker: "tasks",
  command: "jobs",
  browser: "pages",
};

/** The section that lists an app's own work, or every trace for a role it doesn't know. */
export function appTarget(app: ServiceApp): Route {
  return { name: roleSection(app), q: "" };
}

/** The section that lists the work of an app's role: Endpoints for web, Tasks for a worker; every trace otherwise. */
export function roleSection(app: ServiceApp): Section {
  return ROLE_SECTIONS[app.role] ?? "traces";
}

/** One project, however many roles it runs as (web, worker, command): its rows summed, the busiest role first. */
export interface Project extends Omit<ServiceApp, "role"> {
  roles: ServiceApp[];
  /** Where the row goes: the role with the most traces. */
  busiest: ServiceApp;
}

function sum(roles: readonly ServiceApp[], field: "traces" | "errors" | "total"): number {
  return roles.reduce((total, role) => total + role[field], 0);
}

/** A project's roles summed, the busiest first. */
function project(roles: readonly ServiceApp[]): Project {
  const sorted = [...roles].sort((a, b) => b.traces - a.traces);
  const busiest = sorted[0] as ServiceApp;
  return {
    service: busiest.service,
    // What runs it, the same wherever it shows: not its busiest role's, which changes with the traffic.
    runtime: serviceRuntime(sorted.map((role) => role.runtime)),
    traces: sum(sorted, "traces"),
    errors: sum(sorted, "errors"),
    total: sum(sorted, "total"),
    // Its busiest role's latency; the issues of the role that raised the most (a role's issues may be another's).
    p50: busiest.p50,
    p95: busiest.p95,
    issues: Math.max(...sorted.map((role) => role.issues)),
    // biome-ignore lint/style/useNamingConvention: the API's field, as ServiceApp has it.
    last_seen: Math.max(...sorted.map((role) => role.last_seen)),
    roles: sorted,
    busiest,
  };
}

export function byProject(apps: readonly ServiceApp[]): Project[] {
  const projects = new Map<string, ServiceApp[]>();
  for (const app of apps) projects.set(app.service, [...(projects.get(app.service) ?? []), app]);
  return [...projects.values()].map(project);
}

/**
 * One server, however the app uses it: Redis as a datastore (databases 0 and 1) and as a cache backend is one host.
 * Keyed by address and port; an in-process backend (no address) is its own.
 */
export interface Host {
  key: string;
  /** The use with the most calls: what the host is named after, its icon, and where it leads. */
  primary: ServiceNode;
  /** Every way the app uses it, the busiest first. */
  uses: ServiceNode[];
  calls: number;
  total: number;
  errors: number;
  // biome-ignore lint/style/useNamingConvention: the API's field, as ServiceNode has it.
  last_seen: number;
}

/**
 * An AWS service is one box however the app reaches it (S3 through a Django storage and directly, SQS as a broker
 * and through its API), and each its own on one endpoint (LocalStack's serves them all): keyed by region and service.
 */
function hostKey(node: ServiceNode): string {
  if (node.cloud) return `cloud:${node.cloud.provider}:${node.cloud.region ?? ""}:${node.cloud.service}`;
  return node.address ? `${node.address}:${node.port ?? ""}` : node.id;
}

/**
 * The region of an AWS service that didn't say it (a broker on SQS a worker takes from): the only region the others
 * were called in, so it sits with them.
 */
function inRegions(nodes: readonly ServiceNode[]): readonly ServiceNode[] {
  const regions = new Set(nodes.flatMap((node) => (node.cloud?.region ? [node.cloud.region] : [])));
  const [only] = regions;
  if (regions.size !== 1 || only === undefined) return nodes;
  return nodes.map((node) =>
    node.cloud && !node.cloud.region ? { ...node, cloud: { ...node.cloud, region: only } } : node,
  );
}

/**
 * The uses whose calls reached the server. A cache backed by Redis is counted twice by the agent: as cache calls, and
 * as the Redis commands they ran. The commands are what the server did; a cache's own calls count only on a host with
 * nothing else (an in-process cache).
 */
function counted<T extends { kind: ServiceNode["kind"] }>(uses: readonly T[]): readonly T[] {
  const direct = uses.filter((use) => use.kind !== "cache");
  return direct.length ? direct : uses;
}

function total<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((sum, item) => sum + value(item), 0);
}

function host(uses: readonly ServiceNode[]): Host {
  const sorted = [...uses].sort((a, b) => b.calls - a.calls);
  const reached = counted(sorted);
  const primary = reached[0] as ServiceNode;
  return {
    key: hostKey(primary),
    primary,
    uses: sorted,
    calls: total(reached, (use) => use.calls),
    total: total(reached, (use) => use.total),
    errors: total(reached, (use) => use.errors),
    // biome-ignore lint/style/useNamingConvention: the API's field, as ServiceNode has it.
    last_seen: Math.max(...sorted.map((use) => use.last_seen)),
  };
}

export function byHost(all: readonly ServiceNode[]): Host[] {
  const hosts = new Map<string, ServiceNode[]>();
  for (const node of inRegions(all)) hosts.set(hostKey(node), [...(hosts.get(hostKey(node)) ?? []), node]);
  return [...hosts.values()].map(host);
}

/** Where the host runs (no database number: its uses say which), or "in process". */
export function hostWhere(host: Host): string {
  // An AWS service: its endpoint (its region is its group's), else the storage's alias that reached it.
  const { cloud, address, namespace } = host.primary;
  if (cloud) return address ?? namespace ?? cloud.service;
  return host.primary.address ? serviceWhere({ ...host.primary, namespace: null }) : serviceWhere(host.primary);
}

/** What a use is called on its host: a cache by its aliases, a database by its name or number. */
function nameOnHost(use: ServiceNode): string {
  return use.kind === "cache" ? use.aliases.join(", ") : (use.namespace ?? "");
}

/** How the app uses a host, when more than one way: "Database 0, 1 · Cache default". */
export function hostUses(host: Host): string | null {
  if (host.uses.length < 2 || host.primary.cloud) return null;
  const byKind = new Map<ServiceNode["kind"], string[]>();
  for (const use of host.uses) byKind.set(use.kind, [...(byKind.get(use.kind) ?? []), nameOnHost(use)]);
  return [...byKind]
    .map(([kind, names]) => `${SERVICE_KINDS[kind]} ${names.filter(Boolean).join(", ")}`.trim())
    .join(" · ");
}

/** An app role's calls to a host: its edges to the host's uses, counted as the host is; `peer` is the busiest use's. */
export interface HostEdge extends ServiceEdge {
  host: string;
}

function hostEdge(edges: readonly (ServiceEdge & { kind: ServiceNode["kind"] })[], key: string): HostEdge {
  const reached = counted(edges);
  const busiest = [...reached].sort((a, b) => b.calls - a.calls)[0] as ServiceEdge;
  return {
    ...busiest,
    host: key,
    traces: Math.max(...edges.map((edge) => edge.traces)),
    calls: total(reached, (edge) => edge.calls),
    total: total(reached, (edge) => edge.total),
    errors: total(reached, (edge) => edge.errors),
  };
}

export function hostEdges(edges: readonly ServiceEdge[], hosts: readonly Host[]): HostEdge[] {
  const useOf = new Map(hosts.flatMap((one) => one.uses.map((use) => [use.id, { use, key: one.key }] as const)));
  const groups = new Map<string, { key: string; edges: (ServiceEdge & { kind: ServiceNode["kind"] })[] }>();
  for (const edge of edges) {
    const peer = useOf.get(edge.peer);
    if (!peer) continue;
    const group = `${edge.service}|${edge.role}|${peer.key}|${edge.direction}`;
    const entry = groups.get(group) ?? { key: peer.key, edges: [] };
    entry.edges.push({ ...edge, kind: peer.use.kind });
    groups.set(group, entry);
  }
  return [...groups.values()].map((group) => hostEdge(group.edges, group.key));
}
