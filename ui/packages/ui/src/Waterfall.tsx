// The panel's one waterfall (redesign A, a prototype): the page's traces as rows on one time axis, each opening into
// its call tree; one selection across them, its details in one pane; a kind of spans to keep over all the rows; a
// stretch of time dragged across the bars. The host (the panel) holds this state; each trace's rows read it here.
import { createContext, useContext } from "react";
import type { Node } from "./callTree";

/** The time the bars are drawn on (µs, as the traces' clocks). */
export interface Axis {
  start: number;
  duration: number;
}

/** What one trace adds to the facets' totals: its findings, its queries, its HTTP calls, its log records. */
export interface WaterfallFacts {
  issues: number;
  db: { count: number; us: number; time: string };
  http: { count: number; us: number; time: string };
  logs: number;
  /** Where its work starts (µs, on the page's clock): the axis may start there. */
  work: number;
}

/** The kinds of rows the filter can keep. */
export type RowKind = "sql" | "http" | "logs";

/** A stretch of the axis (µs since the axis starts). */
export interface Stretch {
  from: number;
  to: number;
}

export interface WaterfallHost {
  axis: Axis | null;
  selected: { trace: string; key: string } | null;
  select: (trace: string, key: string | null) => void;
  /** Where the selected row's details go: one pane for every trace's rows. */
  details: HTMLElement | null;
  kind: RowKind | null;
  /** The stretch dragged across the bars; the rows outside it dim, the details say what is in it. */
  range: Stretch | null;
  facts: ReadonlyMap<string, WaterfallFacts>;
  report: (trace: string, facts: WaterfallFacts | null) => void;
}

export const WaterfallContext = createContext<WaterfallHost | null>(null);

export function useWaterfall(): WaterfallHost | null {
  return useContext(WaterfallContext);
}

/** The clock a bar is drawn on: the waterfall's axis, else its own trace's. */
export function useAxis(trace: Axis): Axis {
  const host = useContext(WaterfallContext);
  return host?.axis ?? trace;
}

/** A row's stretch of time (µs). */
export function stretchOf(node: Node): Axis | null {
  if (node.type === "span") return { start: node.span.start, duration: Math.max(node.span.duration, 1) };
  if (node.type === "group") return { start: node.start, duration: Math.max(node.end - node.start, 1) };
  if (node.type === "task") return { start: node.run.start, duration: Math.max(node.run.duration, 1) };
  return null;
}

/** A row's name for the breadcrumb, and its badge. */
export function crumbOf(node: Node): { badge: string; label: string } {
  if (node.type === "span") {
    if (node.served) return { badge: badgeOf(node.served.run.kind, node.served.run.name), label: node.served.run.name };
    return { badge: kindBadge(node.span.kind), label: node.span.name };
  }
  if (node.type === "group") return { badge: kindBadge(node.spans[0]?.kind ?? ""), label: node.spans[0]?.name ?? "" };
  if (node.type === "task") return { badge: badgeOf(node.run.kind, node.run.name), label: node.run.name };
  return { badge: "", label: node.type };
}

function badgeOf(kind: string, name: string): string {
  if (/^GraphQL /.test(name)) return "GQL";
  if (kind === "task") return "TASK";
  if (kind === "page") return "VIEW";
  return "REQ";
}

const KIND_BADGES: Record<string, string> = {
  sql: "SQL",
  "http.client": "HTTP",
  "http.server": "REQ",
  http: "REQ",
  view: "VIEW",
  function: "FN",
  graphql: "GQL",
  template: "TPL",
  cache: "CACHE",
  redis: "REDIS",
  task: "TASK",
};

function kindBadge(kind: string): string {
  return KIND_BADGES[kind] ?? (kind.split(".")[0] ?? kind).toUpperCase().slice(0, 5);
}

/** Every row a test keeps, and the rows on the way to them (dimmed, for context). */
export function marksWhere(nodes: readonly Node[], keep: (node: Node) => boolean): Map<string, "match" | "path"> {
  const marks = new Map<string, "match" | "path">();
  const walk = (node: Node): boolean => {
    const own = keep(node);
    let below = false;
    for (const child of kids(node)) below = walk(child) || below;
    if (own) marks.set(node.key, "match");
    else if (below) marks.set(node.key, "path");
    return own || below;
  };
  for (const node of nodes) walk(node);
  return marks;
}

/** Whether a row is of a kind: a query, an HTTP call, a log record. */
export function ofKind(node: Node, kind: RowKind): boolean {
  if (kind === "logs") return node.type === "log" || node.type === "error";
  const spans = node.type === "span" ? [node.span] : node.type === "group" ? node.spans : [];
  if (kind === "sql") return spans.some((span) => span.kind === "sql");
  return spans.some((span) => span.kind === "http.client") || (node.type === "span" && !!node.served);
}

/** Whether a row overlaps a stretch of its trace's clock (µs). */
export function within(node: Node, from: number, to: number): boolean {
  if (node.type === "log") return node.log.time >= from && node.log.time <= to;
  const stretch = stretchOf(node);
  if (!stretch) return true;
  return stretch.start <= to && stretch.start + stretch.duration >= from;
}

function kids(node: Node): readonly Node[] {
  if (node.type === "span" || node.type === "task") return node.children;
  if (node.type === "group") return node.members;
  return [];
}
