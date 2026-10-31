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

export type Point = { x: number; y: number };

export interface Diagram {
  width: number;
  height: number;
  boxes: Placed<Box>[];
  /** A frame per project around its roles, named after it; one per AWS region around its services ("AWS · eu-west-1"). */
  projects: Placed<string>[];
  links: { link: Link; points: Point[] }[];
}

const SIZES: Record<Box["type"], [number, number]> = { entry: [116, 30], role: [248, 44], host: [264, 44] };
/** Room around a project's roles for its frame, and above them for its name: boxes keep it between them too. */
const FRAME = { side: 12, top: 22 };

const roleId = (service: string, role: string) => `role:${service}/${role}`;
const hostId = (key: string) => `host:${key}`;
const projectId = (service: string) => `project:${service}`;

/** A frame boxes are drawn in: a project's around its roles, an AWS region's around the services called there. */
interface Group {
  key: string;
  label: string;
}

function groupOf(box: Box): Group | null {
  if (box.type === "role") return { key: projectId(box.service), label: box.service };
  return box.type === "host" ? regionOf(box.host) : null;
}

/** An AWS service's region: its frame, one around every service called there. */
function regionOf(host: Host): Group | null {
  const region = host.primary.cloud ? (host.primary.cloud.region ?? "") : null;
  if (region === null) return null;
  return { key: `cloud:${region}`, label: ["AWS", region].filter(Boolean).join(" · ") };
}

/** Where each role's work comes from, when the store says nothing more: requests from clients, commands from a shell. */
// What starts each role's work. A web app a browser app calls is called, so its arrow comes from the browser's box.
const ENTRIES: Record<string, string> = { web: "Clients", command: "CLI · cron", browser: "Users" };

/** The role a call's role is drawn as, by its app and its role: null when its app has no box on the diagram. */
type RoleOf = (service: string, role: string | null) => string | null;

/**
 * One app's calls to another from the same box to the same box, as one line: their traces summed, the busier's
 * median, the slower 95th percentile.
 */
function merged<T extends AppLink>(links: readonly T[]): T[] {
  const byEnds = new Map<string, T>();
  for (const link of links) {
    const ends = `${link.service}/${link.role} ${link.to_service}/${link.to_role}`;
    const seen = byEnds.get(ends);
    byEnds.set(
      ends,
      seen
        ? {
            ...seen,
            traces: seen.traces + link.traces,
            total: seen.total + link.total,
            errors: seen.errors + link.errors,
            p50: link.traces > seen.traces ? link.p50 : seen.p50,
            p95: Math.max(seen.p95, link.p95),
          }
        : link,
    );
  }
  return [...byEnds.values()];
}

/**
 * The calls one app made to another, role to role. The server the caller saw it as (an HTTP host) is that app: its
 * arrow to that server goes, and the server too when nothing else calls it.
 */
function appLinks(map: ServiceMap, hosts: readonly Host[], roleOf: RoleOf): { links: Link[]; seen: Set<string> } {
  const drawn = map.links.flatMap((app) => {
    const [role, to] = [roleOf(app.service, app.role), roleOf(app.to_service, app.to_role)];
    // biome-ignore lint/style/useNamingConvention: the API's field, as AppLink has it.
    return role !== null && to !== null ? [{ ...app, role, to_role: to }] : [];
  });
  // Every call keeps its server: the busiest's is the line's.
  const seen = new Set(drawn.flatMap((link) => (link.peer ? [`${roleId(link.service, link.role)} ${link.peer}`] : [])));
  const links = merged(drawn).map((app) => {
    const [from, to] = [roleId(app.service, app.role), roleId(app.to_service, app.to_role)];
    return { key: `${from} ${to}`, from, to, edge: null, app };
  });
  // A host is the app when any of its uses is what the caller saw.
  const hostSeen = new Set(
    hosts.flatMap((host) =>
      links.flatMap(({ from }) =>
        host.uses.some((use) => seen.has(`${from} ${use.id}`)) ? [`${from} ${hostId(host.key)}`] : [],
      ),
    ),
  );
  return { links, seen: hostSeen };
}

/**
 * The role a call's role is drawn as: its own, else its app's box for traces with no role (calls recorded as "http"
 * beside traces whose role is ""), else its app's busiest (the roles come busiest first; with one, its only); null
 * for an app with no box at all. A role with no box was an empty node dagre placed on its own: its lines started and
 * ended in empty space, nowhere near its app.
 */
function drawnRole(roles: readonly Box[]): RoleOf {
  return (service, role) => {
    const mine = roles.flatMap((box) => (box.type === "role" && box.service === service ? [box.app.role] : []));
    return [role ?? "web", "", mine[0]].find((name) => name !== undefined && mine.includes(name)) ?? null;
  };
}

/** The boxes and the calls between them: entries, the projects' roles, the servers, by host and port. */
function graphOf(map: ServiceMap): { boxes: Box[]; links: Link[] } {
  const hosts = byHost(map.services);
  const projects = byProject(map.apps);
  const roles: Box[] = projects.flatMap((project) =>
    project.roles.map((role) => ({
      type: "role" as const,
      id: roleId(role.service, role.role),
      service: role.service,
      // The project's, as its row on the Services page and its page say it: one app, one look.
      runtime: project.runtime,
      app: role,
    })),
  );
  const roleOf = drawnRole(roles);
  const apps = appLinks(map, hosts, roleOf);
  // An app only other apps call has no clients of its own on the diagram.
  const called = new Set(apps.links.map((link) => link.to));
  const entries = [...new Set(map.apps.map((app) => app.role))]
    .filter((role) => ENTRIES[role])
    .map((role): Box => ({ type: "entry", id: `entry:${role}`, label: ENTRIES[role] ?? role }));
  // Each call from the box it's drawn from, before they're summed by host: two roles drawn as one box are one line.
  const edges = map.edges.flatMap((edge) => {
    const role = roleOf(edge.service, edge.role);
    return role === null ? [] : [{ ...edge, role }];
  });
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
    ...hostEdges(edges, hosts).flatMap((edge) => {
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
  const boxes = [...entries, ...roles, ...servers].filter((box) => box.type === "role" || linked.has(box.id));
  // Only lines between boxes drawn: dagre makes an empty node of an end it doesn't know, out in empty space.
  const drawn = new Set(boxes.map((box) => box.id));
  return { boxes, links: links.filter((link) => drawn.has(link.from) && drawn.has(link.to)) };
}

/** The graph dagre lays out: a node per box, sized as drawn, the roles inside their project, an edge per call. */
function dagreGraph(
  boxes: readonly Box[],
  links: readonly Link[],
  clusters: ReadonlyMap<string, string> = new Map(),
): Graph {
  const graph = new Graph({ multigraph: false, compound: clusters.size > 0 });
  graph.setGraph({
    rankdir: "LR",
    ranksep: 48,
    nodesep: FRAME.top + FRAME.side + 12,
    marginx: FRAME.side + 4,
    marginy: FRAME.top + 4,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const box of boxes) addBox(graph, box);
  // A project's roles in one layer as one cluster: kept together, one under another, and lines routed around it.
  for (const [id, cluster] of clusters) {
    graph.setNode(cluster, {});
    graph.setParent(id, cluster);
  }
  for (const link of links) graph.setEdge(link.from, link.to, { weight: weightOf(link) });
  return graph;
}

/**
 * Each framed box's cluster, its group's in its layer, from a first layout's layers: a web app and the worker it
 * hands tasks to sit in different layers, the broker between them, so a cluster never covers a layer between its
 * roles. An AWS region's services are a cluster too.
 */
function clustersOf(boxes: readonly Box[], graph: Graph): Map<string, string> {
  const columns = [...new Set(boxes.map((box) => graph.node(box.id).x ?? 0))].sort((a, b) => a - b);
  const clusters = new Map<string, string>();
  for (const box of boxes) {
    const group = groupOf(box);
    if (!group) continue;
    clusters.set(box.id, `cluster:${group.key}:${columns.indexOf(graph.node(box.id).x ?? 0)}`);
  }
  return clusters;
}

/** How far apart a project's roles in one frame sit: closer than the boxes of different frames. */
const IN_FRAME_GAP = 8;

/**
 * A cluster's roles one right under another, from where dagre put its first: dagre keeps every box apart by the
 * room a frame's name needs, which left a gap inside a project's frame.
 */
function packed(placed: readonly Placed<Box>[], clusters: ReadonlyMap<string, string>): Placed<Box>[] {
  const moved = new Map<string, number>();
  for (const boxes of membersOf(placed, clusters)) for (const [id, y] of stacked(boxes)) moved.set(id, y);
  return placed.map((box) => ({ ...box, y: moved.get(box.item.id) ?? box.y }));
}

/** The boxes of each cluster. */
function membersOf(placed: readonly Placed<Box>[], clusters: ReadonlyMap<string, string>): Placed<Box>[][] {
  const members = new Map<string, Placed<Box>[]>();
  for (const box of placed) {
    const cluster = clusters.get(box.item.id) ?? "";
    members.set(cluster, [...(members.get(cluster) ?? []), box]);
  }
  members.delete("");
  return [...members.values()];
}

/** Where each box under a cluster's top one goes: right under the one above it. */
function stacked(boxes: readonly Placed<Box>[]): [string, number][] {
  const [head, ...rest] = [...boxes].sort((a, b) => a.y - b.y);
  if (!head) return [];
  let bottom = head.y + head.height / 2;
  return rest.map((box) => {
    const y = bottom + IN_FRAME_GAP + box.height / 2;
    bottom = y + box.height / 2;
    return [box.item.id, y];
  });
}

/** The layer a box is in: its column, counted from the left. */
function columnsOf(placed: readonly Placed<Box>[]): Map<string, number> {
  const columns = [...new Set(placed.map((box) => box.x))].sort((a, b) => a - b);
  return new Map(placed.map((box) => [box.item.id, columns.indexOf(box.x)]));
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
function around(label: string, boxes: readonly Placed<Box>[]): Placed<string> {
  const left = Math.min(...boxes.map((box) => box.x - box.width / 2)) - FRAME.side;
  const right = Math.max(...boxes.map((box) => box.x + box.width / 2)) + FRAME.side;
  const top = Math.min(...boxes.map((box) => box.y - box.height / 2)) - FRAME.top;
  const bottom = Math.max(...boxes.map((box) => box.y + box.height / 2)) + FRAME.side;
  return { item: label, x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
}

/**
 * The frames: each group's (a project's, an AWS region's) around its boxes in each layer. A web app and the worker
 * it hands tasks to sit in different layers, the broker between them; one frame around both would cover the broker.
 * (dagre's own clusters stretch over whole layers and let calls run through them.)
 */
function framesOf(boxes: readonly Placed<Box>[]): Placed<string>[] {
  const groups = new Map<string, { label: string; boxes: Placed<Box>[] }>();
  for (const box of boxes) {
    const group = groupOf(box.item);
    if (!group) continue;
    const at = `${group.key} ${box.x}`;
    const entry = groups.get(at) ?? { label: group.label, boxes: [] };
    entry.boxes.push(box);
    groups.set(at, entry);
  }
  return [...groups.values()].map((group) => around(group.label, group.boxes));
}

/** How far a call to itself loops out of the box's right side, and how far apart it leaves and comes back. */
const LOOP = { out: 28, apart: 10 };

/**
 * A role's calls to itself (an app calling its own API over HTTP): a loop out of its box's right side and back.
 * dagre lays a self edge out on its own terms, points that run out and back on one line below the box.
 */
function loopOn(box: Placed<Box> | undefined): Point[] {
  if (!box) return [];
  const right = box.x + box.width / 2;
  return [
    { x: right, y: box.y - LOOP.apart },
    { x: right + LOOP.out, y: box.y - LOOP.apart },
    { x: right + LOOP.out, y: box.y + LOOP.apart },
    { x: right, y: box.y + LOOP.apart },
  ];
}

/**
 * A call from a box to one in a later layer: from the middle of its right side to the middle of the other's left,
 * through the gap between their columns. dagre's own points start and end anywhere on a box's border (an arrow on a
 * database's bottom edge, a line out of a card's middle) and cross the cards beside them.
 */
function sideToSide(from: Placed<Box> | undefined, to: Placed<Box> | undefined): Point[] | null {
  if (!(from && to)) return null;
  const start = { x: from.x + from.width / 2, y: from.y };
  const end = { x: to.x - to.width / 2, y: to.y };
  return end.x > start.x ? [start, end] : null;
}

/**
 * A call's line between two boxes: side to side to the next layer, through the gap between them; past a layer, as
 * dagre routed it, around the boxes and frames in between.
 */
function betweenBoxes(
  link: Link,
  byId: ReadonlyMap<string, Placed<Box>>,
  graph: Graph,
  columns: ReadonlyMap<string, number>,
): Point[] {
  const [from, to] = [byId.get(link.from), byId.get(link.to)];
  const side = isNext(columns, link) ? sideToSide(from, to) : null;
  return side ?? onSides(routeOf(graph, link), from, to);
}

/** dagre's route of a call, around the boxes and clusters it passes. */
function routeOf(graph: Graph, link: Link): Point[] {
  return graph.edge(link.from, link.to)?.points ?? [];
}

/** Whether a call goes to the very next layer. */
function isNext(columns: ReadonlyMap<string, number>, link: Link): boolean {
  const [from, to] = [columns.get(link.from), columns.get(link.to)];
  return from !== undefined && to !== undefined && to - from === 1;
}

/** dagre's route, its ends on the boxes' sides where they are now (a packed role moved up). */
function onSides(points: readonly Point[], from: Placed<Box> | undefined, to: Placed<Box> | undefined): Point[] {
  const ends = sideToSide(from, to);
  return ends && points.length > 1 ? [ends[0] as Point, ...points.slice(1, -1), ends[1] as Point] : [...points];
}

/** Left to right in layers: what calls comes before what it calls, so a broker sits between a web app and its worker. */
export function laidOut(map: ServiceMap): Diagram {
  const { boxes, links } = graphOf(map);
  const calls = links.filter((link) => link.from !== link.to);
  // Twice: the first finds each box's layer, the second keeps a project's roles in a layer together.
  const first = dagreGraph(boxes, calls);
  layout(first);
  const clusters = clustersOf(boxes, first);
  const graph = dagreGraph(boxes, calls, clusters);
  layout(graph);
  const size = graph.graph();
  const placed = packed(
    boxes.map((item) => placedIn(graph, item, item.id)),
    clusters,
  );
  const byId = new Map(placed.map((box) => [box.item.id, box]));
  const columns = columnsOf(placed);
  const pointsOf = (link: Link): Point[] =>
    link.from === link.to ? loopOn(byId.get(link.from)) : betweenBoxes(link, byId, graph, columns);
  return fitted({
    width: size.width ?? 0,
    height: size.height ?? 0,
    boxes: placed,
    projects: framesOf(placed),
    links: links.map((link) => ({ link, points: pointsOf(link) })),
  });
}

/** Room around everything drawn: a line's bend is not cut by the edge. */
const MARGIN = 12;

/** Every corner of what is drawn: boxes, frames, and the points a line bends through. */
function cornersOf(diagram: Diagram): Point[] {
  const corners = (placed: { x: number; y: number; width: number; height: number }): Point[] => [
    { x: placed.x - placed.width / 2, y: placed.y - placed.height / 2 },
    { x: placed.x + placed.width / 2, y: placed.y + placed.height / 2 },
  ];
  return [
    ...diagram.boxes.flatMap(corners),
    ...diagram.projects.flatMap(corners),
    ...diagram.links.flatMap(({ points }) => points),
  ];
}

/**
 * The diagram moved to fit what is drawn. dagre sizes it by its boxes; a line routed around them bends past that
 * edge (above the top row, before the first column), where the scrolling view cuts it.
 */
function fitted(diagram: Diagram): Diagram {
  const corners = cornersOf(diagram);
  if (corners.length === 0) return diagram;
  const left = Math.min(...corners.map((point) => point.x)) - MARGIN;
  const top = Math.min(...corners.map((point) => point.y)) - MARGIN;
  const right = Math.max(...corners.map((point) => point.x)) + MARGIN;
  const bottom = Math.max(...corners.map((point) => point.y)) + MARGIN;
  const move = <T extends Point>(point: T): T => ({ ...point, x: point.x - left, y: point.y - top });
  return {
    width: right - left,
    height: bottom - top,
    boxes: diagram.boxes.map(move),
    projects: diagram.projects.map(move),
    links: diagram.links.map(({ link, points }) => ({ link, points: points.map(move) })),
  };
}

/* ---------- Mermaid ---------- */

/**
 * Mermaid's shapes for a server: a cylinder for a database, a stadium for a cache, a framed box for a file storage, a
 * queue's flag, an API's box.
 */
const SHAPES: Record<ServiceNode["kind"], [string, string]> = {
  database: ["[(", ")]"],
  cache: ["([", "])"],
  storage: ["[[", "]]"],
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

/** A group's subgraph: a project's roles, an AWS region's services. */
function groupLines(group: Group, boxes: readonly Box[], label: (host: Host) => string): string[] {
  const inside = boxes.flatMap((box) => {
    if (groupOf(box)?.key !== group.key) return [];
    return [box.type === "role" ? `    ${mermaidId(box.id)}[${quoted(box.app.role)}]` : `  ${boxLine(box, label)}`];
  });
  return [`  subgraph ${mermaidId(group.key)}[${quoted(group.label)}]`, ...inside, "  end"];
}

function boxLine(box: Box, label: (host: Host) => string): string {
  if (box.type === "entry") return `  ${mermaidId(box.id)}([${quoted(box.label)}])`;
  return box.type === "host" ? hostLine(box.host, label) : "";
}

/** Each group once, in the order its first box comes. */
function groupsIn(boxes: readonly Box[]): Group[] {
  const groups = new Map<string, Group>();
  for (const box of boxes) {
    const group = groupOf(box);
    if (group && !groups.has(group.key)) groups.set(group.key, group);
  }
  return [...groups.values()];
}

/** An arrow: who calls what, no counts (the map has none on its lines either; they change with every request). */
function linkLine({ from, to }: Link): string {
  return `  ${mermaidId(from)} --> ${mermaidId(to)}`;
}

/**
 * The diagram as a Mermaid flowchart: a subgraph per project around its roles, the servers in Mermaid's shapes, an
 * arrow per call. GitHub, GitLab and most docs tools draw it.
 */
export function mermaidOf(map: ServiceMap, label: (host: Host) => string): string {
  const { boxes, links } = graphOf(map);
  const lines = [
    "flowchart LR",
    ...groupsIn(boxes).flatMap((group) => groupLines(group, boxes, label)),
    ...boxes.filter((box) => box.type !== "role" && !groupOf(box)).map((box) => boxLine(box, label)),
    ...links.map(linkLine),
  ];
  return `${lines.join("\n")}\n`;
}
