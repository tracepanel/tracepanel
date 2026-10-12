import {
  ago,
  duration,
  RuntimeIcon,
  runtimeKind,
  SERVICE_KINDS,
  type ServiceApp,
  ServiceIcon,
  type ServiceMap,
  type ServiceNode,
  serviceWhere,
  systemName,
} from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { SQL_VENDORS } from "@tracepanel/ui/lib/systems";
import type { ReactNode } from "react";
import { callsSection, currentPeriod, href, type Route, withPeriod } from "./routes";
import { DataTable, Meter, Mono, Td, Th, Tr } from "./ui";

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
function target(node: ServiceNode): Route {
  const aliases = node.aliases.join(",");
  const page = pageOfService(node);
  if (page) return { name: callsSection(page), q: aliases ? `target:${aliases}` : "" };
  if (node.kind === "mail") return { name: "mails", q: "" };
  // A broker and an HTTP API: the traces that called it (a worker's tasks taking from the broker included).
  return { name: "traces", q: withPeriod(`peer:${node.id}`, currentPeriod()) };
}

/** Where an app's own work is listed: requests for web, tasks for a worker, runs for a command. */
function appTarget(app: ServiceApp): Route {
  if (app.role === "web") return { name: "endpoints", q: "" };
  if (app.role === "worker") return { name: "tasks", q: "" };
  if (app.role === "command") return { name: "jobs", q: "" };
  return { name: "traces", q: "" };
}

/** One project, however many roles it runs as (web, worker, command): its rows summed, the busiest role first. */
interface App extends Omit<ServiceApp, "role"> {
  roles: ServiceApp[];
  /** Where the row goes: the role with the most traces. */
  busiest: ServiceApp;
}

export function byProject(apps: ServiceApp[]): App[] {
  const projects = new Map<string, App>();
  for (const app of apps) {
    const project = projects.get(app.service);
    if (!project) {
      projects.set(app.service, { ...app, roles: [app], busiest: app });
      continue;
    }
    project.roles.push(app);
    project.runtime ??= app.runtime;
    project.traces += app.traces;
    project.errors += app.errors;
    project.total += app.total;
    if (app.last_seen > project.last_seen) project.last_seen = app.last_seen;
  }
  for (const project of projects.values()) {
    project.roles.sort((a, b) => b.traces - a.traces);
    project.busiest = project.roles[0] ?? project.busiest;
  }
  return [...projects.values()];
}

/** The icon in a tile, then the name over where it runs. */
function Name({ icon, name, detail }: { icon: ReactNode; name: string; detail: string | null }) {
  return (
    <span className="flex items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/60 text-text-2 [&_svg]:size-[1.125rem]">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-medium">{name}</span>
        {detail ? <Mono className="block truncate text-sm text-muted-foreground">{detail}</Mono> : null}
      </span>
    </span>
  );
}

function AppRow({ app, slowest, onOpen }: { app: App; slowest: number; onOpen?: (() => void) | undefined }) {
  const kind = app.runtime ? runtimeKind(app.runtime) : null;
  return (
    <Tr tone={app.errors ? "error" : undefined} href={href(appTarget(app.busiest))} opening={onOpen}>
      <Td className="max-w-[22.5rem]">
        <Name icon={kind ? <RuntimeIcon kind={kind} /> : null} name={app.service} detail={app.runtime} />
      </Td>
      <Td className="text-muted-foreground">App</Td>
      <Td>
        <span className="flex flex-wrap gap-1">
          {app.roles.map((role) => (
            <Badge key={role.role} variant="outline" className="text-xs">
              {role.role}
            </Badge>
          ))}
        </span>
      </Td>
      <Td num>{app.traces.toLocaleString()}</Td>
      <Td>
        <Meter value={app.total} max={slowest}>
          {duration(app.total)}
        </Meter>
      </Td>
      <Td num>{duration(Math.round(app.total / Math.max(app.traces, 1)))}</Td>
      <Td num className={app.errors ? "font-semibold text-error" : "text-muted-foreground"}>
        {app.errors || "—"}
      </Td>
      <Td num className="text-muted-foreground">
        {ago(app.last_seen)}
      </Td>
    </Tr>
  );
}

/**
 * The project's own web, workers and commands first, then what they talk to, and who calls it.
 */
export function ServicesView({ map, onApp }: { map: ServiceMap; onApp?: ((service: string) => void) | undefined }) {
  const slowest = Math.max(...map.services.map((node) => node.total), 1);
  // The apps' time is every request's whole duration: on the services' scale it would flatten them.
  const apps = byProject(map.apps);
  const busiest = Math.max(...apps.map((app) => app.total), 1);
  const callers = (node: ServiceNode) => [...new Set(map.edges.filter((e) => e.peer === node.id).map((e) => e.role))];
  return (
    <DataTable
      head={
        <>
          <Th>Service</Th>
          <Th>Kind</Th>
          <Th>Role · used by</Th>
          <Th num>Calls</Th>
          <Th>Time</Th>
          <Th num>Avg</Th>
          <Th num>Errors</Th>
          <Th num>Last</Th>
        </>
      }
    >
      {apps.map((app) => (
        <AppRow
          key={app.service}
          app={app}
          slowest={busiest}
          // Several apps: opening one shows the console as that app (the sidebar's switcher).
          onOpen={onApp && apps.length > 1 ? () => onApp(app.service) : undefined}
        />
      ))}
      {map.services.map((node) => (
        <Tr key={node.id} tone={node.errors ? "error" : undefined} href={href(target(node))}>
          <Td className="max-w-[22.5rem]">
            <Name icon={<ServiceIcon node={node} />} name={systemName(node)} detail={serviceWhere(node)} />
          </Td>
          <Td className="text-muted-foreground">{SERVICE_KINDS[node.kind]}</Td>
          <Td>
            <span className="flex flex-wrap gap-1">
              {callers(node).map((role) => (
                <Badge key={role} variant="outline" className="text-xs">
                  {role}
                </Badge>
              ))}
            </span>
          </Td>
          <Td num>{node.calls.toLocaleString()}</Td>
          <Td>
            <Meter value={node.total} max={slowest}>
              {duration(node.total)}
            </Meter>
          </Td>
          <Td num>{duration(Math.round(node.total / Math.max(node.calls, 1)))}</Td>
          <Td num className={node.errors ? "font-semibold text-error" : "text-muted-foreground"}>
            {node.errors || "—"}
          </Td>
          <Td num className="text-muted-foreground">
            {ago(node.last_seen)}
          </Td>
        </Tr>
      ))}
    </DataTable>
  );
}
