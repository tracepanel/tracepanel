import {
  ago,
  duration,
  SERVICE_KINDS,
  type ServiceMap,
  type ServiceNode,
  serviceWhere,
  systemName,
} from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { href, type Route } from "./routes";
import { DataTable, Meter, Mono, Td, Th, Tr } from "./ui";

/** Where to look next: the SQL of that database, the traces using that cache, the emails, the tasks. */
function target(node: ServiceNode): Route {
  const aliases = node.aliases.join(",");
  if (node.kind === "database") return { name: "queries", q: aliases ? `db:${aliases}` : "" };
  if (node.kind === "cache") return { name: "traces", q: aliases ? `cache:${aliases}` : "" };
  if (node.kind === "mail") return { name: "mails", q: "" };
  if (node.kind === "queue") return { name: "tasks", q: "" };
  return { name: "traces", q: "" };
}

/**
 * What this project talks to, and who calls it. A table, not the service map (ServiceGraph in @tracepanel/ui): a
 * project usually has one web and a worker, and a table says it better.
 */
export function ServicesView({ map }: { map: ServiceMap }) {
  const slowest = Math.max(...map.services.map((node) => node.total), 1);
  const callers = (node: ServiceNode) => [...new Set(map.edges.filter((e) => e.peer === node.id).map((e) => e.role))];
  return (
    <DataTable
      head={
        <>
          <Th>Service</Th>
          <Th>Kind</Th>
          <Th>Used by</Th>
          <Th num>Calls</Th>
          <Th>Time</Th>
          <Th num>Avg</Th>
          <Th num>Errors</Th>
          <Th num>Last</Th>
        </>
      }
    >
      {map.services.map((node) => (
        <Tr key={node.id} tone={node.errors ? "error" : undefined} href={href(target(node))}>
          <Td className="max-w-[360px]">
            <span className="block font-medium">{systemName(node)}</span>
            <Mono className="block truncate text-[13px] text-muted-foreground">{serviceWhere(node)}</Mono>
          </Td>
          <Td className="text-muted-foreground">{SERVICE_KINDS[node.kind]}</Td>
          <Td>
            <span className="flex flex-wrap gap-1">
              {callers(node).map((role) => (
                <Badge key={role} variant="outline" className="text-[12px]">
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
