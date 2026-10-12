import {
  ago,
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
import { DataTable, Meter, Mono, Td, Th, Tr } from "./ui";

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

function AppRow({ app, slowest, onOpen }: { app: Project; slowest: number; onOpen?: (() => void) | undefined }) {
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

/** A server the app talks to, one row however many ways it uses it (Redis as a datastore and as a cache). */
function HostRow({ host, callers, slowest }: { host: Host; callers: string[]; slowest: number }) {
  const kinds = [...new Set(host.uses.map((use) => SERVICE_KINDS[use.kind]))].join(" · ");
  return (
    <Tr tone={host.errors ? "error" : undefined} href={href(serviceTarget(host.primary))}>
      <Td className="max-w-[22.5rem]">
        <Name
          icon={<ServiceIcon node={host.primary} />}
          name={systemName(host.primary)}
          detail={[hostWhere(host), hostUses(host)].filter(Boolean).join(" · ")}
        />
      </Td>
      <Td className="text-muted-foreground">{kinds}</Td>
      <Td>
        <span className="flex flex-wrap gap-1">
          {callers.map((role) => (
            <Badge key={role} variant="outline" className="text-xs">
              {role}
            </Badge>
          ))}
        </span>
      </Td>
      <Td num>{host.calls.toLocaleString()}</Td>
      <Td>
        <Meter value={host.total} max={slowest}>
          {duration(host.total)}
        </Meter>
      </Td>
      <Td num>{duration(Math.round(host.total / Math.max(host.calls, 1)))}</Td>
      <Td num className={host.errors ? "font-semibold text-error" : "text-muted-foreground"}>
        {host.errors || "—"}
      </Td>
      <Td num className="text-muted-foreground">
        {ago(host.last_seen)}
      </Td>
    </Tr>
  );
}

/**
 * The map of who talks to what, then the table: the project's own web, workers and commands first, then what they
 * talk to, and who calls it.
 */
export function ServicesView({ map, onApp }: { map: ServiceMap; onApp?: ((service: string) => void) | undefined }) {
  const hosts = byHost(map.services);
  const slowest = Math.max(...hosts.map((one) => one.total), 1);
  // The apps' time is every request's whole duration: on the services' scale it would flatten them.
  const apps = byProject(map.apps);
  const busiest = Math.max(...apps.map((app) => app.total), 1);
  const edges = hostEdges(map.edges, hosts);
  const callers = (one: Host) => [...new Set(edges.filter((edge) => edge.host === one.key).map((edge) => edge.role))];
  return (
    <>
      <ServicesMap map={map} />
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
        {hosts.map((one) => (
          <HostRow key={one.key} host={one} callers={callers(one)} slowest={slowest} />
        ))}
      </DataTable>
    </>
  );
}
