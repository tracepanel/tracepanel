import {
  ago,
  type DataColumn,
  DataTable,
  duration,
  RuntimeIcon,
  runtimeKind,
  SERVICE_KINDS,
  ServiceIcon,
  type ServiceMap,
  systemName,
} from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import type { ReactNode } from "react";
import { href } from "./routes";
import { ServicesMap } from "./ServicesMap";
import {
  appTarget,
  byHost,
  byProject,
  type Host,
  hostEdges,
  hostUses,
  hostWhere,
  type Project,
  serviceTarget,
} from "./services";
import { Meter, Mono, Tr } from "./ui";

/** The icon in a tile, then the name over where it runs. */
function Name({ icon, name, detail }: { icon: ReactNode; name: string; detail: string | null }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/60 text-text-2 [&_svg]:size-[1.125rem]">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{name}</span>
        {detail ? <Mono className="block truncate text-sm text-muted-foreground">{detail}</Mono> : null}
      </span>
    </span>
  );
}

/** A row of the table: an app of the project, or a server it talks to, said the same way. */
interface Line {
  key: string;
  name: ReactNode;
  kind: string;
  /** An app's roles (web, worker), or the roles of the apps that call a server. */
  roles: readonly string[];
  calls: number;
  total: number;
  /** The longest time of the rows of its kind: the apps' and the servers' are on scales of their own. */
  most: number;
  errors: number;
  lastSeen: number;
  href: string;
  opening?: (() => void) | undefined;
}

function appLine(app: Project, most: number, onOpen: (() => void) | undefined): Line {
  const kind = app.runtime ? runtimeKind(app.runtime) : null;
  return {
    key: `app:${app.service}`,
    name: <Name icon={kind ? <RuntimeIcon kind={kind} /> : null} name={app.service} detail={app.runtime} />,
    kind: "App",
    roles: app.roles.map((role) => role.role),
    calls: app.traces,
    total: app.total,
    most,
    errors: app.errors,
    lastSeen: app.last_seen,
    href: href(appTarget(app.busiest)),
    opening: onOpen,
  };
}

/** A server the app talks to, one row however many ways it uses it (Redis as a datastore and as a cache). */
function hostLine(host: Host, callers: string[], most: number): Line {
  return {
    key: `host:${host.key}`,
    name: (
      <Name
        icon={<ServiceIcon node={host.primary} />}
        name={systemName(host.primary)}
        detail={[hostWhere(host), hostUses(host)].filter(Boolean).join(" · ")}
      />
    ),
    kind: [...new Set(host.uses.map((use) => SERVICE_KINDS[use.kind]))].join(" · "),
    roles: callers,
    calls: host.calls,
    total: host.total,
    most,
    errors: host.errors,
    lastSeen: host.last_seen,
    href: href(serviceTarget(host.primary)),
  };
}

const COLUMNS: DataColumn<Line>[] = [
  { id: "service", label: "Service", required: true, cell: (line) => line.name },
  { id: "kind", label: "Kind", width: 6.5, className: "text-muted-foreground", cell: (line) => line.kind },
  {
    id: "roles",
    label: "Role · used by",
    width: 12,
    cell: (line) => (
      <span className="flex gap-1">
        {line.roles.map((role) => (
          <Badge key={role} variant="outline" className="text-xs">
            {role}
          </Badge>
        ))}
      </span>
    ),
  },
  { id: "calls", label: "Calls", width: 5.5, num: true, cell: (line) => line.calls.toLocaleString() },
  {
    id: "time",
    label: "Time",
    width: 10,
    cell: (line) => (
      <Meter value={line.total} max={line.most}>
        {duration(line.total)}
      </Meter>
    ),
  },
  {
    id: "avg",
    label: "Avg",
    width: 5.5,
    num: true,
    cell: (line) => duration(Math.round(line.total / Math.max(line.calls, 1))),
  },
  {
    id: "errors",
    label: "Errors",
    width: 6,
    num: true,
    className: (line) => (line.errors ? "font-semibold text-error" : "text-muted-foreground"),
    cell: (line) => line.errors || "—",
  },
  {
    id: "last",
    label: "Last",
    width: 6.5,
    num: true,
    className: "text-muted-foreground",
    cell: (line) => ago(line.lastSeen),
  },
];

/** The table's rows: the project's apps first, then what they talk to. */
function linesOf(map: ServiceMap, onApp: ((service: string) => void) | undefined): Line[] {
  const hosts = byHost(map.services);
  const slowest = Math.max(...hosts.map((one) => one.total), 1);
  // The apps' time is every request's whole duration: on the services' scale it would flatten them.
  const apps = byProject(map.apps);
  const busiest = Math.max(...apps.map((app) => app.total), 1);
  const edges = hostEdges(map.edges, hosts);
  const callers = (one: Host) => [...new Set(edges.filter((edge) => edge.host === one.key).map((edge) => edge.role))];
  // Several apps: opening one shows the console as that app (the sidebar's switcher).
  const opens = (app: Project) => (onApp && apps.length > 1 ? () => onApp(app.service) : undefined);
  return [
    ...apps.map((app) => appLine(app, busiest, opens(app))),
    ...hosts.map((one) => hostLine(one, callers(one), slowest)),
  ];
}

/**
 * The map of who talks to what, then the table: the project's own web, workers and commands first, then what they
 * talk to, and who calls it.
 */
export function ServicesView({ map, onApp }: { map: ServiceMap; onApp?: ((service: string) => void) | undefined }) {
  return (
    <>
      <ServicesMap map={map} />
      <DataTable table="services" columns={COLUMNS}>
        {({ cells }) =>
          linesOf(map, onApp).map((line) => (
            <Tr key={line.key} tone={line.errors ? "error" : undefined} href={line.href} opening={line.opening}>
              {cells(line)}
            </Tr>
          ))
        }
      </DataTable>
    </>
  );
}
