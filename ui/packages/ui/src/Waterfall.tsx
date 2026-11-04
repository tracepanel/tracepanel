// The panel's one waterfall (redesign A, a prototype): the page's traces as rows on one time axis, each opening into
// its call tree; one selection across them, its details in one pane; facets and a filter over all the rows; a zoom
// that re-roots the waterfall at one call. The host (the panel) holds this state; each trace's rows read it here.
import { createContext, useContext } from "react";
import type { Node } from "./callTree";

/** The time the bars are drawn on (µs, as the traces' clocks). */
export interface Axis {
  start: number;
  duration: number;
}

/** A row the waterfall is zoomed to: the trace it is in, its key, what the breadcrumb calls it, its stretch. */
export interface Zoom {
  trace: string;
  key: string;
  badge: string;
  label: string;
  axis: Axis;
}

/** What one trace adds to the facets' totals: its findings, its queries, its HTTP calls, its log records. */
export interface WaterfallFacts {
  issues: number;
  db: { count: number; us: number; time: string };
  http: { count: number; us: number; time: string };
  logs: number;
}

export type Facet = "issues" | "db" | "http" | "logs";

export interface WaterfallHost {
  axis: Axis | null;
  selected: { trace: string; key: string } | null;
  select: (trace: string, key: string | null) => void;
  /** Where the selected row's details go: one pane for every trace's rows. */
  details: HTMLElement | null;
  filter: string;
  facet: Facet | null;
  zoom: Zoom | null;
  setZoom: (zoom: Zoom | null) => void;
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

/** A row's stretch of time (µs), to zoom to. */
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
  return KIND_BADGES[kind] ?? kind.toUpperCase().slice(0, 5);
}

/** Every row of a tree whose name has the text, and the rows on the way to them. */
export function filterMarks(nodes: readonly Node[], text: string): Map<string, "match" | "path"> {
  const marks = new Map<string, "match" | "path">();
  const needle = text.toLowerCase();
  const walk = (node: Node): boolean => {
    const own = nameOf(node).toLowerCase().includes(needle);
    let below = false;
    for (const child of kids(node)) below = walk(child) || below;
    if (own) marks.set(node.key, "match");
    else if (below) marks.set(node.key, "path");
    return own || below;
  };
  for (const node of nodes) walk(node);
  return marks;
}

function kids(node: Node): readonly Node[] {
  if (node.type === "span" || node.type === "task") return node.children;
  if (node.type === "group") return node.members;
  return [];
}

function nameOf(node: Node): string {
  if (node.type === "span") return `${node.span.name} ${node.served?.run.name ?? ""}`;
  if (node.type === "group") return node.spans[0]?.name ?? "";
  if (node.type === "task") return node.run.name;
  if (node.type === "log") return node.log.message;
  if (node.type === "error") return `${node.error.type} ${node.error.message}`;
  return node.span.name;
}
