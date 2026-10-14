// The services as an architecture diagram, as data: what calls what (from the agent's service map), laid out in
// layers left to right by dagre, and the same graph as Mermaid text to paste where diagrams are drawn from text.
import { Graph, layout } from "@dagrejs/dagre";
import type { AppLink, ServiceApp, ServiceMap, ServiceNode } from "@tracepanel/ui";
import { byHost, byProject, type Host, type HostEdge, hostEdges } from "./services";

/** A box on the diagram: where work comes in, a role of the project's apps, or a server they call. */
export type Box =
  | { type: "entry"; id: string; label: string }
  | { type: "role"; id: string; service: string; runtime: string | null; app: ServiceApp }
  | { type: "host"; id: string; host: Host };

/** A call between two boxes: an app role's calls to a server or to another app, a worker taking from a broker. */
export interface Link {
  key: string;
  from: string;
  to: string;
  /** The calls to a server it stands for. */
  edge: HostEdge | null;
  /** The calls to another app it stands for. */
  app: AppLink | null;
}

export interface Placed<T> {
  item: T;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Diagram {
  width: number;
  height: number;
  boxes: Placed<Box>[];
  /** A frame per project around its roles, named after it. */
  projects: Placed<string>[];
  links: { link: Link; points: { x: number; y: number }[] }[];
}

const SIZES: Record<Box["type"], [number, number]> = { entry: [116, 30], role: [248, 44], host: [264, 44] };
/** Room around a project's roles for its frame, and above them for its name: boxes keep it between them too. */
const FRAME = { side: 12, top: 22 };

const roleId = (service: string, role: string) => `role:${service}/${role}`;
const hostId = (key: string) => `host:${key}`;
const projectId = (service: string) => `project:${service}`;

/** Where each role's work comes from, when the store says nothing more: requests from clients, commands from a shell. */
// What starts each role's work. A web app a browser app calls is called, so its arrow comes from the browser's box.
const ENTRIES: Record<string, string> = { web: "Clients", command: "CLI · cron", browser: "Users" };

const roleOf = (service: string, role: string | null) => roleId(service, role ?? "web");

/**
 * The calls one app made to another, role to role. The server the caller saw it as (an HTTP host) is that app: its
 * arrow to that server goes, and the server too when nothing else calls it.
 */
function appLinks(map: ServiceMap, hosts: readonly Host[]): { links: Link[]; seen: Set<string> } {
  const seen = new Set(
    map.links.flatMap((link) => (link.peer ? [`${roleOf(link.service, link.role)} ${link.peer}`] : [])),
  );
  const links = map.links.map((app) => {
    const [from, to] = [roleOf(app.service, app.role), roleOf(app.to_service, app.to_role)];
    return { key: `${from} ${to}`, from, to, edge: null, app };
  });
  // A host is the app when any of its uses is what the caller saw.
  const hostSeen = new Set(
    hosts.flatMap((host) =>
      map.links.flatMap((link) =>
        host.uses.some((use) => seen.has(`${roleOf(link.service, link.role)} ${use.id}`))
          ? [`${roleOf(link.service, link.role)} ${hostId(host.key)}`]
          : [],
      ),
    ),
  );
  return { links, seen: hostSeen };
}

/** The boxes and the calls between them: entries, the projects' roles, the servers, by host and port. */
function graphOf(map: ServiceMap): { boxes: Box[]; links: Link[]; projects: string[] } {
  const hosts = byHost(map.services);
  const apps = appLinks(map, hosts);
  // An app only other apps call has no clients of its own on the diagram.
  const called = new Set(apps.links.map((link) => link.to));
  const projects = byProject(map.apps);
  const roles: Box[] = projects.flatMap((project) =>
    project.roles.map((role) => ({
      type: "role" as const,
      id: roleId(role.service, role.role),
      service: role.service,
      runtime: role.runtime ?? project.runtime,
      app: role,
    })),
  );
  const entries = [...new Set(map.apps.map((app) => app.role))]
    .filter((role) => ENTRIES[role])
    .map((role): Box => ({ type: "entry", id: `entry:${role}`, label: ENTRIES[role] ?? role }));
  const links: Link[] = [
    ...map.apps
      .filter((app) => ENTRIES[app.role] && !called.has(roleId(app.service, app.role)))
      .map((app) => ({
        key: `entry ${app.service}/${app.role}`,
        from: `entry:${app.role}`,
        to: roleId(app.service, app.role),
        edge: null,
        app: null,
      })),
    ...apps.links,
    ...hostEdges(map.edges, hosts).flatMap((edge) => {
      const [role, server] = [roleId(edge.service, edge.role), hostId(edge.host)];
      if (apps.seen.has(`${role} ${server}`)) return [];
      // A worker takes its tasks from the broker: the arrow runs from the broker to it.
      const [from, to] = edge.direction === "in" ? [server, role] : [role, server];
      return [{ key: `${from} ${to}`, from, to, edge, app: null }];
    }),
  ];
  // A server or an entry with no arrow left (a host that was another app) isn't drawn.
  const linked = new Set(links.flatMap((link) => [link.from, link.to]));
  const servers = hosts.map((host): Box => ({ type: "host", id: hostId(host.key), host }));
  return {
    boxes: [...entries, ...roles, ...servers].filter((box) => box.type === "role" || linked.has(box.id)),
    links,
    projects: projects.map((project) => project.service),
  };
}

/** The graph dagre lays out: a node per box, sized as drawn, the roles inside their project, an edge per call. */
function dagreGraph(boxes: readonly Box[], links: readonly Link[]): Graph {
  const graph = new Graph({ multigraph: false });
  graph.setGraph({
    rankdir: "LR",
    ranksep: 96,
    nodesep: FRAME.top + FRAME.side + 12,
    marginx: FRAME.side + 4,
    marginy: FRAME.top + 4,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const box of boxes) addBox(graph, box);
  for (const link of links) graph.setEdge(link.from, link.to, { weight: weightOf(link) });
  return graph;
}

function addBox(graph: Graph, box: Box): void {
  const [width, height] = SIZES[box.type];
  graph.setNode(box.id, { width, height });
}

/** Busier calls weigh more: dagre keeps them shorter and straighter. */
function weightOf(link: Link): number {
  return 1 + Math.log1p(link.edge?.calls ?? 0);
}

function placedIn<T>(graph: Graph, item: T, id: string): Placed<T> {
  const node = graph.node(id);
  return { item, x: node.x ?? 0, y: node.y ?? 0, width: node.width, height: node.height };
}

/** A frame around boxes, with room above them for its name. */
function around(service: string, boxes: readonly Placed<Box>[]): Placed<string> {
  const left = Math.min(...boxes.map((box) => box.x - box.width / 2)) - FRAME.side;
  const right = Math.max(...boxes.map((box) => box.x + box.width / 2)) + FRAME.side;
  const top = Math.min(...boxes.map((box) => box.y - box.height / 2)) - FRAME.top;
  const bottom = Math.max(...boxes.map((box) => box.y + box.height / 2)) + FRAME.side;
  return { item: service, x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
}

/**
 * A project's frames: around its roles in each layer. A web app and the worker it hands tasks to sit in different
 * layers, the broker between them; one frame around both would cover the broker. (dagre's own clusters stretch over
 * whole layers and let calls run through them.)
 */
function framesOf(service: string, boxes: readonly Placed<Box>[]): Placed<string>[] {
  const roles = boxes.filter((box) => box.item.type === "role" && box.item.service === service);
  return [...new Set(roles.map((box) => box.x))].map((x) =>
    around(
      service,
      roles.filter((box) => box.x === x),
    ),
  );
}

/** Left to right in layers: what calls comes before what it calls, so a broker sits between a web app and its worker. */
export function laidOut(map: ServiceMap): Diagram {
  const { boxes, links, projects } = graphOf(map);
  const graph = dagreGraph(boxes, links);
  layout(graph);
  const size = graph.graph();
  const placed = boxes.map((item) => placedIn(graph, item, item.id));
  return {
    width: size.width ?? 0,
    height: size.height ?? 0,
    boxes: placed,
    projects: projects.flatMap((service) => framesOf(service, placed)),
    links: links.map((link) => ({ link, points: graph.edge(link.from, link.to)?.points ?? [] })),
  };
}

/* ---------- Mermaid ---------- */

/** Mermaid's shapes for a server: a cylinder for a database, a stadium for a cache, a queue's flag, an API's box. */
const SHAPES: Record<ServiceNode["kind"], [string, string]> = {
  database: ["[(", ")]"],
  cache: ["([", "])"],
  queue: [">", "]"],
  http: ["[", "]"],
  mail: ["[/", "/]"],
};

function mermaidId(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, "_");
}

function quoted(text: string): string {
  return `"${text.replaceAll('"', "#quot;")}"`;
}

function hostLine(host: Host, label: (host: Host) => string): string {
  const [open, close] = SHAPES[host.primary.kind];
  return `  ${mermaidId(hostId(host.key))}${open}${quoted(label(host))}${close}`;
}

function projectLines(service: string, boxes: readonly Box[]): string[] {
  const roles = boxes.flatMap((box) =>
    box.type === "role" && box.service === service ? [`    ${mermaidId(box.id)}[${quoted(box.app.role)}]`] : [],
  );
  return [`  subgraph ${mermaidId(projectId(service))}[${quoted(service)}]`, ...roles, "  end"];
}

function boxLine(box: Box, label: (host: Host) => string): string[] {
  if (box.type === "entry") return [`  ${mermaidId(box.id)}([${quoted(box.label)}])`];
  return box.type === "host" ? [hostLine(box.host, label)] : [];
}

function linkLine({ from, to, edge, app }: Link): string {
  const count = edge
    ? `${edge.calls.toLocaleString("en-US")} calls`
    : app
      ? `${app.traces.toLocaleString("en-US")} traces`
      : "";
  const calls = count ? `|${quoted(count)}|` : "";
  return `  ${mermaidId(from)} -->${calls} ${mermaidId(to)}`;
}

/**
 * The diagram as a Mermaid flowchart: a subgraph per project around its roles, the servers in Mermaid's shapes, the
 * calls on the arrows. GitHub, GitLab and most docs tools draw it.
 */
export function mermaidOf(map: ServiceMap, label: (host: Host) => string): string {
  const { boxes, links, projects } = graphOf(map);
  const lines = [
    "flowchart LR",
    ...projects.flatMap((service) => projectLines(service, boxes)),
    ...boxes.flatMap((box) => boxLine(box, label)),
    ...links.map(linkLine),
  ];
  return `${lines.join("\n")}\n`;
}
