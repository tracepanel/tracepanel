import { useId, useMemo } from "react";
import { duration } from "./format";
import { linkProps, type TraceLinks } from "./links";
import type { Related } from "./types";

type WorkflowGraphData = NonNullable<NonNullable<Related["workflow"]>["graph"]>;
type GraphNode = WorkflowGraphData["nodes"][number];
type EdgeKind = WorkflowGraphData["edges"][number]["kind"];

const NODE_W = 208;
const NODE_H = 30;
const COL_GAP = 28;
const ROW_GAP = 6;
const GROUP_PAD = 8;
const GROUP_HEAD = 20;
/** A column's width: a group's frame around a box. */
const SLOT_W = NODE_W + GROUP_PAD * 2;
/** How many of a group's tasks are drawn before a "+N more" box that searches for them all. */
const GROUP_DRAWN = 5;

/** A box of the drawing: one run, or the rest of a long group. */
interface Card {
  x: number;
  y: number;
  column: number;
  node?: GraphNode;
  more?: { group: string; count: number };
}

/** A group's frame around its tasks. */
interface Frame {
  id: string;
  tasks: number;
  x: number;
  y: number;
  height: number;
  column: number;
}

/** Where a unit (a box, or a group's frame) is: its edges join there. */
interface Place {
  left: number;
  right: number;
  top: number;
  height: number;
  column: number;
}

interface Line {
  key: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  kind: EdgeKind;
}

interface UnitEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

interface Plan {
  width: number;
  height: number;
  cards: Card[];
  frames: Frame[];
  lines: Line[];
}

/** What a node is drawn in: its group's frame for a group's task, else its own box. */
function unitOf(node: GraphNode): string {
  return node.group ? `group:${node.group}` : node.trace.id;
}

/** The nodes of each unit, in the order the graph gives them. */
function unitsOf(graph: WorkflowGraphData): Map<string, GraphNode[]> {
  const units = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) units.set(unitOf(node), [...(units.get(unitOf(node)) ?? []), node]);
  return units;
}

/** The graph's edges between units, each once: an edge to or from a group's task joins its frame. */
function unitEdgesOf(graph: WorkflowGraphData): UnitEdge[] {
  const unitOfTrace = new Map(graph.nodes.map((node) => [node.trace.id, unitOf(node)]));
  const unit = (id: string) => unitOfTrace.get(id) ?? id;
  const all = graph.edges
    .map((edge) => ({ from: unit(edge.from), to: unit(edge.to), kind: edge.kind }))
    .filter((edge) => edge.from !== edge.to);
  return [...new Map(all.map((edge) => [`${edge.from}>${edge.to}`, edge])).values()];
}

/** One pass of the longest way to each unit: true when a unit moved right. */
function deepen(depth: Map<string, number>, edges: UnitEdge[]): boolean {
  const at = (unit: string) => depth.get(unit) ?? 0;
  const longer = edges.filter(({ from, to }) => at(from) + 1 > at(to));
  for (const { from, to } of longer) depth.set(to, Math.max(at(to), at(from) + 1));
  return longer.length > 0;
}

/** Each unit's column: the longest way to it from a unit nothing leads to. */
function columns(units: string[], edges: UnitEdge[]): Map<string, number> {
  const depth = new Map(units.map((unit) => [unit, 0]));
  // A workflow is a DAG; the bound keeps a cycle in bad data from looping.
  for (let round = 0; round < units.length && deepen(depth, edges); round += 1);
  return depth;
}

/** What the drawing collects while it places the units. */
interface Drawing {
  cards: Card[];
  frames: Frame[];
  places: Map<string, Place>;
}

/** A group's frame at (x, y), its first tasks stacked in it, then "+N more": the frame's height. */
function placeGroup(drawing: Drawing, unit: string, nodes: GraphNode[], at: { x: number; y: number; column: number }) {
  const group = nodes[0]?.group ?? "";
  const drawn = nodes.slice(0, GROUP_DRAWN);
  const more = nodes.length - drawn.length;
  const boxes = drawn.length + Number(more > 0);
  const height = GROUP_HEAD + boxes * NODE_H + (boxes - 1) * ROW_GAP + GROUP_PAD;
  const { x, y, column } = at;
  drawing.frames.push({ id: group, tasks: nodes.length, x, y, height, column });
  drawn.forEach((node, index) => {
    drawing.cards.push({ x: x + GROUP_PAD, y: y + GROUP_HEAD + index * (NODE_H + ROW_GAP), node, column });
  });
  if (more > 0) {
    const last = y + GROUP_HEAD + drawn.length * (NODE_H + ROW_GAP);
    drawing.cards.push({ x: x + GROUP_PAD, y: last, more: { group, count: more }, column });
  }
  drawing.places.set(unit, { left: x, right: x + SLOT_W, top: y, height, column });
  return height;
}

/** A unit of one run: its box at (x, y), its height. */
function placeBox(drawing: Drawing, unit: string, node: GraphNode, at: { x: number; y: number; column: number }) {
  const { x, y, column } = at;
  drawing.cards.push({ x: x + GROUP_PAD, y, node, column });
  drawing.places.set(unit, { left: x + GROUP_PAD, right: x + GROUP_PAD + NODE_W, top: y, height: NODE_H, column });
  return NODE_H;
}

/** One column's units, top to bottom: its height. */
function placeColumn(drawing: Drawing, units: [string, GraphNode[]][], column: number): number {
  const x = column * (SLOT_W + COL_GAP);
  let y = 0;
  for (const [unit, nodes] of units) {
    const at = { x, y, column };
    const height = unit.startsWith("group:")
      ? placeGroup(drawing, unit, nodes, at)
      : placeBox(drawing, unit, nodes[0] as GraphNode, at);
    y += height + ROW_GAP;
  }
  return Math.max(0, y - ROW_GAP);
}

/** A line from each edge's unit to the next, side to side, between their middles. */
function linesOf(edges: UnitEdge[], places: Map<string, Place>): Line[] {
  return edges.flatMap((edge) => {
    const from = places.get(edge.from);
    const to = places.get(edge.to);
    if (!(from && to)) return [];
    const key = `${edge.from}>${edge.to}`;
    const ends = {
      from: { x: from.right, y: from.top + from.height / 2 },
      to: { x: to.left, y: to.top + to.height / 2 },
    };
    return [{ key, ...ends, kind: edge.kind }];
  });
}

/** Where each unit goes: columns left to right as the workflow runs, a column's units top to bottom in the order
 * their runs first ran and centred on the tallest column, a group's tasks stacked in its frame. */
function layout(graph: WorkflowGraphData): Plan {
  const units = unitsOf(graph);
  const edges = unitEdgesOf(graph);
  const depth = columns([...units.keys()], edges);
  const drawing: Drawing = { cards: [], frames: [], places: new Map() };
  const lastColumn = Math.max(0, ...depth.values());
  const heights: number[] = [];
  for (let column = 0; column <= lastColumn; column += 1) {
    const inColumn = [...units].filter(([unit]) => depth.get(unit) === column);
    heights.push(placeColumn(drawing, inColumn, column));
  }
  const height = Math.max(0, ...heights);
  const shift = (column: number) => (height - (heights[column] ?? height)) / 2;
  for (const item of [...drawing.cards, ...drawing.frames, ...drawing.places.values()]) {
    if ("top" in item) item.top += shift(item.column);
    else item.y += shift(item.column);
  }
  const width = (lastColumn + 1) * (SLOT_W + COL_GAP) - COL_GAP;
  return { width, height, cards: drawing.cards, frames: drawing.frames, lines: linesOf(edges, drawing.places) };
}

/** A curve from one box's right side to the next one's left side. */
function curve({ from, to }: Line): string {
  const bend = Math.max(16, (to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

/** A task's own name, without its module: render_issue for newsletter.tasks.render_issue. */
function shortName(node: GraphNode): string {
  const trace = node.trace;
  if (trace.kind !== "task") return trace.path ?? trace.name;
  return trace.name.split(/[.:]/).pop() || trace.name;
}

// A run's state as a dot: green done, red failed, amber retried; grey for anything else.
const DOT = new Map<string, string>([
  ["success", "bg-ok"],
  ["failure", "bg-error"],
  ["retry", "bg-warn"],
]);

/** A run's state in a word: failure when its trace failed, else its task state. */
function stateOf(trace: GraphNode["trace"]): string {
  return trace.status === "error" ? "failure" : (trace.task_state ?? "").toLowerCase();
}

/** What starts the box: a request's method, else its state as a dot (in words for a screen reader). */
function Mark({ node }: { node: GraphNode }) {
  const trace = node.trace;
  if (trace.kind === "http") {
    return (
      <span className="shrink-0 font-mono text-2xs font-semibold text-muted-foreground uppercase">{trace.method}</span>
    );
  }
  return <StateDot state={stateOf(trace)} />;
}

function StateDot({ state }: { state: string }) {
  return (
    <>
      <span
        className={`size-2 shrink-0 rounded-full ${DOT.get(state) ?? "bg-muted-foreground/50"}`}
        aria-hidden="true"
      />
      <span className="sr-only">{state}</span>
    </>
  );
}

/** What else to know at a glance: how long it took, how many runs (retries), which callback it is. */
function Details({ node }: { node: GraphNode }) {
  const parts = [
    duration(node.trace.duration),
    ...(node.runs > 1 ? [`×${node.runs}`] : []),
    ...(node.callback ? [node.callback] : []),
  ];
  return <span className="ml-auto shrink-0 text-2xs text-muted-foreground tabular-nums">{parts.join(" · ")}</span>;
}

const BOX = "absolute flex items-center gap-1.5 rounded-md border px-2 text-xs";

function boxStyle(card: Card) {
  return { left: card.x, top: card.y, width: NODE_W, height: NODE_H };
}

/** The rest of a long group: how many more, a search for all its runs where the host has searches. */
function MoreBox({
  card,
  more,
  links,
}: {
  card: Card;
  more: NonNullable<Card["more"]>;
  links: TraceLinks | undefined;
}) {
  const body = <span className="text-muted-foreground">+{more.count} more</span>;
  if (!links?.search) {
    return (
      <div className={`${BOX} bg-card`} style={boxStyle(card)}>
        {body}
      </div>
    );
  }
  return (
    <a
      className={`${BOX} bg-card hover:bg-accent`}
      style={boxStyle(card)}
      title={`All runs of group ${more.group}`}
      {...linkProps(links, links.search(`group:${more.group}`))}
    >
      {body}
    </a>
  );
}

/** The run on screen is filled with the brand's tint, no outline; a failed one says so with its dot. */
function toneOf(here: boolean): string {
  return here ? "bg-brand-soft font-semibold text-foreground" : "bg-card";
}

/** Its full name and task id, for the box's title. */
function titleOf(node: GraphNode): string {
  const name = node.trace.kind === "task" ? node.trace.name : (node.trace.path ?? node.trace.name);
  return node.task_id ? `${name}\n${node.task_id}` : name;
}

/** Where its trace opens, when the host links traces. */
function traceLink(links: TraceLinks | undefined, node: GraphNode) {
  return links?.trace ? linkProps(links, links.trace(node.trace.id)) : undefined;
}

function RunBody({ node }: { node: GraphNode }) {
  return (
    <>
      <Mark node={node} />
      <span className="min-w-0 truncate font-mono">{shortName(node)}</span>
      <Details node={node} />
    </>
  );
}

/** A run's box: marked when it is the run on screen, else a link to its trace. */
function RunBox({
  card,
  node,
  here,
  links,
}: {
  card: Card;
  node: GraphNode;
  here: boolean;
  links: TraceLinks | undefined;
}) {
  const props = { className: `${BOX} ${toneOf(here)}`, style: boxStyle(card), title: titleOf(node) };
  const link = here ? undefined : traceLink(links, node);
  if (!link) {
    return (
      <div {...props} aria-current={here || undefined}>
        <RunBody node={node} />
      </div>
    );
  }
  return (
    <a {...props} className={`${props.className} hover:bg-accent`} {...link}>
      <RunBody node={node} />
    </a>
  );
}

const LINE_STYLE: Record<EdgeKind, { dash?: string; opacity: number }> = {
  follows: { opacity: 0.7 },
  sent: { opacity: 0.7 },
  callback: { dash: "4 3", opacity: 0.7 },
  enqueued: { opacity: 0.4 },
};

/** The lines between the boxes, each with an arrow at its end; a callback's dashed. */
function Lines({ plan }: { plan: Plan }) {
  const arrow = `workflow-arrow-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className="pointer-events-none absolute inset-0 text-muted-foreground"
      width={plan.width}
      height={plan.height}
      aria-hidden="true"
    >
      <defs>
        <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
        </marker>
      </defs>
      {plan.lines.map((line) => (
        <path
          key={line.key}
          d={curve(line)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeOpacity={LINE_STYLE[line.kind].opacity}
          strokeDasharray={LINE_STYLE[line.kind].dash}
          markerEnd={`url(#${arrow})`}
        />
      ))}
    </svg>
  );
}

function GroupFrame({ frame }: { frame: Frame }) {
  return (
    <div
      className="absolute rounded-lg border border-dashed"
      style={{ left: frame.x, top: frame.y, width: SLOT_W, height: frame.height }}
    >
      <span className="block px-2 pt-0.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        Group · {frame.tasks} tasks
      </span>
    </div>
  );
}

function CardBox({ card, current, links }: { card: Card; current: string; links: TraceLinks | undefined }) {
  if (card.more) return <MoreBox card={card} more={card.more} links={links} />;
  if (!card.node) return null;
  return <RunBox card={card} node={card.node} here={card.node.trace.id === current} links={links} />;
}

/** A task workflow drawn whole: what started it, its tasks left to right as they ran, groups framed, callbacks on a
 * dashed line; the run on screen marked, the others links to their traces. */
export function WorkflowGraph({
  graph,
  current,
  links,
}: {
  graph: WorkflowGraphData;
  current: string;
  links?: TraceLinks | undefined;
}) {
  const plan = useMemo(() => layout(graph), [graph]);
  return (
    <div className="grid gap-1.5">
      <div className="overflow-x-auto pb-1">
        <div className="relative" style={{ width: plan.width, height: plan.height }} data-testid="workflow-graph">
          <Lines plan={plan} />
          {plan.frames.map((frame) => (
            <GroupFrame key={frame.id} frame={frame} />
          ))}
          {plan.cards.map((card) => (
            <CardBox
              key={card.node?.trace.id ?? `more:${card.more?.group}`}
              card={card}
              current={current}
              links={links}
            />
          ))}
        </div>
      </div>
      {graph.cut ? (
        <span className="text-xs text-muted-foreground">
          The workflow has more runs than the graph takes in: it shows the first 100.
        </span>
      ) : null}
    </div>
  );
}
