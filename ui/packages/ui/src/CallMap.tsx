import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { duration, since } from "./format";
import { GraphqlCode } from "./GraphqlCode";
import { ChevronRightIcon, CloseIcon } from "./icons";
import { keyed } from "./keys";
import { AllAttributes, LogRecordDetails } from "./LogRecordDetails";
import { type Category, spanCategories } from "./lib/breakdown";
import { callFields, templatePlace } from "./lib/callFields";
import { callTemplate, groupNoun } from "./lib/calls";
import { spanKindLabel } from "./lib/handler";
import { widthOf } from "./lib/percent";
import { plural } from "./lib/plural";
import { ownHotspots, type Profile } from "./lib/profile";
import { type Quiet, quietSpans } from "./lib/quiet";
import { traceRuntime } from "./lib/runtime";
import { isReceiver, raised } from "./lib/signals";
import { isLoud, overlaps, type Slice, type TimeRange } from "./lib/slice";
import { CALL_KINDS, DATASTORES, MESSAGING, RPC } from "./lib/systems";
import { type Piece, quietPieces, timed, waitName } from "./lib/waiting";
import { type TraceLinks, traceLinkProps } from "./links";
import { type NameValue, NameValues, RowsLookContext } from "./NameValues";
import { profileOver, RowFlame, WhatRan, WhatWaited } from "./ProfileHint";
import { useProfilingOf } from "./Profiling";
import { PropTable } from "./PropTable";
import {
  AliasChip,
  AppChip,
  ISSUE_CHIP_SHRINKS,
  IssueChip,
  KindBadge,
  StateBadge,
  TaskName,
  TemplateChip,
} from "./primitives";
import { isRequestDetail, RequestParts, requestParts } from "./RequestParts";
import { RunChips } from "./RunChips";
import { SideResize, useSideWidth } from "./SideResize";
import { SignalNotes } from "./SignalNotes";
import { SqlCode } from "./SqlCode";
import { TemplateContext, withoutContext } from "./TemplateContext";
import { ESCAPE_FIRST, RangeBand, useHeldSlice, useRangeDrag } from "./TimeSlice";
import type { Attrs, IssueKind, Log, Related, Span, Trace, TraceError, TraceSummary } from "./types";

/* ---------- tree ---------- */

type Node =
  | { type: "span"; key: string; span: Span; children: Node[] }
  | { type: "group"; key: string; spans: Span[]; start: number; end: number }
  | { type: "log"; key: string; log: Log }
  | { type: "error"; key: string; error: TraceError }
  // A trace of its own under a span of this one: a task it enqueued, run in a worker (or still waiting for one), or
  // the trace another app served for one of its calls (`kind: "call"`), with that trace's own rows when it came whole.
  | {
      type: "task";
      key: string;
      run: TraceSummary;
      kind: "task" | "call";
      remote?: Remote | undefined;
      whole?: Trace | undefined;
      children: Node[];
    }
  | { type: "waiting"; key: string; span: Span; kind: "task" };

function startOf(node: Node): number {
  if (node.type === "span" || node.type === "waiting") return node.span.start;
  if (node.type === "task") return node.run.start;
  if (node.type === "group") return node.start;
  if (node.type === "log") return node.log.time;
  return node.error.time;
}

/**
 * 3+ identical leaf queries, cache calls, HTTP calls (to one path template) or signal sends (one signal, one sender)
 * under one parent collapse into a group shown where the first one ran, even when they interleave (an N+1 in a
 * template loop alternates between several statements).
 */
const GROUP_MIN = 3;

function isLeafCall(node: Node): node is Extract<Node, { type: "span" }> {
  if (node.type !== "span") return false;
  if (node.span.kind === "signal") return node.children.every(isQuietReceiver);
  return CALL_KINDS.has(node.span.kind) && node.children.every(isBackendCall);
}

/** A receiver that ran and did nothing the tree shows: its send folds with its likes. One that failed stays a row. */
function isQuietReceiver(node: Node): boolean {
  return (
    node.type === "span" && node.span.kind === "function" && node.span.status !== "error" && node.children.length === 0
  );
}

/** A cache call's own Redis commands don't stop it from grouping with its likes: they are how it was served. */
function isBackendCall(node: Node): boolean {
  return node.type === "span" && node.span.kind === "redis" && node.children.length === 0;
}

function collapse(nodes: Node[]): Node[] {
  const byName = new Map<string, Span[]>();
  for (const node of nodes) {
    if (isLeafCall(node))
      byName.set(`${node.span.kind}:${callTemplate(node.span)}`, [
        ...(byName.get(`${node.span.kind}:${callTemplate(node.span)}`) ?? []),
        node.span,
      ]);
  }
  const result: Node[] = [];
  const emitted = new Set<string>();
  for (const node of nodes) {
    if (isLeafCall(node)) {
      const name = `${node.span.kind}:${callTemplate(node.span)}`;
      const spans = byName.get(name) ?? [];
      if (spans.length >= GROUP_MIN) {
        if (!emitted.has(name)) {
          emitted.add(name);
          const last = spans.at(-1) ?? node.span;
          result.push({
            type: "group",
            key: `group:${node.span.id}`,
            spans,
            start: node.span.start,
            end: last.start + last.duration,
          });
        }
        continue;
      }
    }
    result.push(node);
  }
  return result;
}

/** Another project's trace on this machine, and where its console is: it opens there. */
interface Remote {
  console: string;
  project: string;
}

/** A call's trace as a row of this tree, with that trace's own rows under it when it came whole. */
function callNode(key: string, run: TraceSummary, related: Related, remote?: Remote): Node {
  const whole = related.call_traces?.[run.id];
  return { type: "task", key, run, kind: "call", remote, whole, children: whole ? servedRows(whole) : [] };
}

/** What the other app did for the call: its request's rows, the request itself being the call's row. */
function servedRows(whole: Trace): Node[] {
  return buildTree(whole, undefined).flatMap((node) =>
    node.type === "span" && node.span.parent_id === null ? node.children : [node],
  );
}

/** The traces other projects' agents have for this trace's calls, under the calls. */
function remoteNodes(related: Related): [string, Node][] {
  return (related.remote_calls ?? []).map(({ span_id, trace, console, project }): [string, Node] => [
    span_id,
    callNode(`remote:${trace.id}`, trace, related, { console, project }),
  ]);
}

/** Each trace of its own under a span of this one, by that span's id. */
function linked(runs: readonly TraceSummary[], related: Related, kind: "task" | "call"): [string, Node][] {
  return runs.flatMap((run): [string, Node][] => {
    const span = related.via[run.id];
    if (!span) return [];
    return [[span, kind === "call" ? callNode(`call:${run.id}`, run, related) : taskNode(run)]];
  });
}

function taskNode(run: TraceSummary): Node {
  return { type: "task", key: `task:${run.id}`, run, kind: "task", children: [] };
}

/**
 * Tasks under the span that enqueued them (an enqueue with no run yet is waiting for a worker), and the traces other
 * apps served under the call that reached them.
 */
function linkedNodes(trace: Trace, related: Related | undefined): [string, Node][] {
  if (!related) return [];
  const tasks = linked(related.enqueued, related, "task");
  const run = new Set(tasks.map(([span]) => span));
  const waiting = trace.spans
    .filter((span) => span.kind === "task.enqueue" && !run.has(span.id))
    .map((span): [string, Node] => [span.id, { type: "waiting", key: `waiting:${span.id}`, span, kind: "task" }]);
  return [...tasks, ...linked(related.calls, related, "call"), ...remoteNodes(related), ...waiting];
}

/**
 * Where a span hangs: under its parent, or, its parent not in the trace (cut by a limit, lost on the way), under the
 * root, so it still shows.
 */
function parentFinder(trace: Trace): (span: Span) => string | null {
  const ids = new Set(trace.spans.map((span) => span.id));
  const root = trace.spans.find((span) => span.parent_id === null)?.id ?? null;
  return (span) => (span.parent_id === null || ids.has(span.parent_id) ? span.parent_id : root);
}

export function buildTree(trace: Trace, related: Related | undefined): Node[] {
  const children = new Map<string | null, Node[]>();
  const push = (parent: string | null, node: Node) => children.set(parent, [...(children.get(parent) ?? []), node]);
  const parentOf = parentFinder(trace);
  for (const span of trace.spans) push(parentOf(span), { type: "span", key: span.id, span, children: [] });
  for (const [parent, node] of linkedNodes(trace, related)) push(parent, node);
  for (const { key, item } of keyed(trace.logs, (log) => `log:${log.time}:${log.message}`)) {
    push(item.span_id, { type: "log", key, log: item });
  }
  for (const { key, item } of keyed(trace.errors, (error) => `error:${error.time}:${error.type}`)) {
    push(item.span_id, { type: "error", key, error: item });
  }
  const attach = (nodes: Node[]): Node[] =>
    collapse(
      nodes
        .map((node) => (node.type === "span" ? { ...node, children: attach(children.get(node.span.id) ?? []) } : node))
        .sort((a, b) => startOf(a) - startOf(b)),
    );
  return attach(children.get(null) ?? []);
}

/* ---------- filters ---------- */

/** What the filter chips above the tree pick, in their order; a chip shows only when the trace has such rows. */
export const FILTERS = [
  { id: "sql", label: "SQL", kinds: ["sql"] },
  { id: "redis", label: "Redis", kinds: ["redis"] },
  { id: "cache", label: "Cache", kinds: ["cache"] },
  { id: "datastore", label: "Datastores", kinds: [...DATASTORES] },
  { id: "messaging", label: "Messaging", kinds: [...MESSAGING] },
  { id: "http", label: "HTTP calls", kinds: ["http.client"] },
  { id: "rpc", label: "RPC", kinds: [...RPC] },
  { id: "signal", label: "Signals", kinds: ["signal"] },
  { id: "template", label: "Templates", kinds: ["template"] },
  { id: "task", label: "Tasks", kinds: ["task.enqueue", "task"] },
  { id: "transaction", label: "Transactions", kinds: ["transaction"] },
  { id: "mail", label: "Mail", kinds: ["mail"] },
  { id: "graphql", label: "GraphQL", kinds: ["graphql"] },
  { id: "channels", label: "Channels", kinds: ["channel.send", "websocket.send"] },
  { id: "function", label: "Functions", kinds: ["function"] },
  { id: "error", label: "Errors", kinds: ["error"] },
] as const;

export type FilterId = (typeof FILTERS)[number]["id"];

const FILTER_OF = new Map<string, FilterId>(FILTERS.flatMap((filter) => filter.kinds.map((kind) => [kind, filter.id])));

function kindOf(node: Node): string {
  if (node.type === "span") return node.span.kind;
  if (node.type === "group") return node.spans[0]?.kind ?? "";
  if (node.type === "task" || node.type === "waiting") return node.kind;
  return node.type;
}

function countFilters(nodes: Node[], counts = new Map<FilterId, number>()): Map<FilterId, number> {
  for (const node of nodes) {
    const filter = FILTER_OF.get(kindOf(node));
    const size = node.type === "group" ? node.spans.length : 1;
    if (filter) counts.set(filter, (counts.get(filter) ?? 0) + size);
    if (node.type === "span") countFilters(node.children, counts);
  }
  return counts;
}

/**
 * How many of each a chip filters: spans counted in the trace itself (a folded group hides its members' children:
 * a cache call's Redis commands), the rest (logs, tasks) as rows of the tree.
 */
export function chipCounts(nodes: Node[], trace: Trace): Map<FilterId, number> {
  const counts = countFilters(nodes);
  const root = trace.spans.find((span) => span.parent_id === null);
  leaveOutOwn(counts, root);
  const filters = trace.spans
    .filter((span) => span !== root)
    .map((span) => FILTER_OF.get(span.kind))
    .filter((filter) => filter !== undefined);
  for (const filter of new Set(filters)) counts.set(filter, filters.filter((each) => each === filter).length);
  return counts;
}

/** The trace's own span isn't a call of it: a task's trace has no "Tasks 1" chip that picks only itself. */
function leaveOutOwn(counts: Map<FilterId, number>, root: Span | undefined): void {
  const own = root && FILTER_OF.get(root.kind);
  if (own) counts.set(own, (counts.get(own) ?? 1) - 1);
}

/** What is picked, as the rows are matched against it: kinds of calls, a stretch of time, each span's category. */
interface Picked {
  parts: ReadonlySet<string>;
  range: TimeRange | null;
  /** When the trace started: the range is in microseconds since. */
  start: number;
  categories: ReadonlyMap<string, Category>;
}

/**
 * With a slice picked: the rows that match, and the rows on the way to them ("path": shown dimmed, always open).
 * Everything else is hidden. A signal's rows are what it did: its receivers, and theirs, match with it.
 */
function markTree(nodes: Node[], picked: Picked, marks = new Map<string, Mark>()): boolean {
  let any = false;
  for (const node of nodes) any = markNode(node, picked, marks) || any;
  return any;
}

/** One row and the rows under it; whether it shows. */
function markNode(node: Node, picked: Picked, marks: Map<string, Mark>): boolean {
  const matches = matchesPicked(node, picked);
  const below = markTree(childrenOf(node), picked, marks);
  if (matches && isPickedSignal(node, picked)) markAll(childrenOf(node), picked, marks);
  const mark = markOf(matches, below);
  if (mark) marks.set(node.key, mark);
  return mark !== undefined;
}

function matchesPicked(node: Node, picked: Picked): boolean {
  return partOf(node, picked) && inRange(node, picked);
}

/** A signal's send while Signals is picked: what its receivers did is the signal's. */
function isPickedSignal(node: Node, picked: Picked): boolean {
  return picked.parts.has("signal") && kindOf(node) === "signal";
}

/** The spans a row stands for: its own, or a group's. */
function spansOf(node: Node): readonly Span[] {
  if (node.type === "span") return [node.span];
  return node.type === "group" ? node.spans : [];
}

/** Whether a row is of a picked kind: a filter's, or the share of the time its spans count in. */
function partOf(node: Node, picked: Picked): boolean {
  if (picked.parts.size === 0) return true;
  if (picked.parts.has(FILTER_OF.get(kindOf(node)) ?? "")) return true;
  return spansOf(node).some((span) => picked.parts.has(picked.categories.get(span.id) ?? ""));
}

/** When a row ran, or happened: its start and how long, since the trace started. */
function extentOf(node: Node, start: number): [number, number] {
  if (node.type === "span") return [node.span.start - start, node.span.duration];
  if (node.type === "group") return [node.start - start, node.end - node.start];
  if (node.type === "task") return [node.run.start - start, node.run.duration];
  return [startOf(node) - start, 0];
}

function inRange(node: Node, picked: Picked): boolean {
  return picked.range === null || overlaps(picked.range, ...extentOf(node, picked.start));
}

function markOf(matches: boolean, below: boolean): Mark | undefined {
  if (matches) return "match";
  return below ? "path" : undefined;
}

/** Every row under these that the range keeps, as matches. */
function markAll(nodes: Node[], picked: Picked, marks: Map<string, Mark>): void {
  for (const node of nodes) {
    if (inRange(node, picked)) marks.set(node.key, "match");
    markAll(childrenOf(node), picked, marks);
  }
}

type Mark = "match" | "path";

/** The share of the time a category is: a filter's id where it has one (Database is SQL), else its own. */
const CATEGORY_FILTERS: Partial<Record<Category, FilterId>> = {
  template: "template",
  sql: "sql",
  redis: "redis",
  cache: "cache",
  datastore: "datastore",
  messaging: "messaging",
  http: "http",
  mail: "mail",
  signal: "signal",
};

export function partOfCategory(category: Category): string {
  return CATEGORY_FILTERS[category] ?? category;
}

/* ---------- rows ---------- */

interface RowContext {
  trace: Trace;
  issueBySpan: ReadonlyMap<string, IssueKind>;
  selected: string | null;
  onSelect: (key: string) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Set while filters are on: only marked rows show. */
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** The selected row's details, opened right under that row; null while they show in the side pane. */
  details: ReactNode;
  /** How many info and debug records each span has that don't show, by its id; and what shows them. */
  hiddenLogs: ReadonlyMap<string, number>;
  onShowLogs: () => void;
  /** The spans whose own code ran long with nothing recorded inside (as the strip says them), and each span's share. */
  quiet: ReadonlyMap<string, Quiet>;
  categories: ReadonlyMap<string, Category>;
  /** What is picked: a code row shows with its share picked, or a range it overlaps. */
  slice: Slice;
  /** Opens the trace's profile, when it has one, at a stretch of it where the profile says when it was sampled. */
  onProfile: ((range: TimeRange) => void) | undefined;
}

/** The selected row's details, under it: where the click was, not past the end of a long tree. */
function RowDetails({ id, ctx }: { id: string; ctx: RowContext }) {
  const box = useRef<HTMLDivElement>(null);
  const shown = ctx.selected === id;
  // A row near the bottom edge: scrolled just enough for the details to start in view.
  useEffect(() => {
    const top = box.current?.getBoundingClientRect().top;
    if (shown && top !== undefined && top > window.innerHeight - 64) box.current?.scrollIntoView({ block: "nearest" });
  }, [shown]);
  if (!shown || !ctx.details) return null;
  return (
    <div className="dt-map-inline" ref={box}>
      {ctx.details}
    </div>
  );
}

function Bar({ trace, start, length, point }: { trace: Trace; start: number; length: number; point?: boolean }) {
  const place = point ? pointPlace(trace, start) : barPlace(trace, start, length);
  return (
    <span className="dt-map-track" aria-hidden="true">
      <span className="dt-map-bar" data-point={point ? "" : undefined} data-past={place.past} style={place.style} />
    </span>
  );
}

/** Where a point sits on the request's timeline. */
function pointPlace(trace: Trace, at: number): { style: CSSProperties; past: undefined } {
  const left = Math.min(Math.max(((at - trace.start) / Math.max(trace.duration, 1)) * 100, 0), 100);
  return { style: { left: `${left}%` }, past: undefined };
}

/** The least of the track a run that starts after the request ended still shows, at its right edge. */
const PAST_MIN = 6;

/**
 * Where a bar sits on the request's timeline. One that runs past its end (a task runs longer than the request that
 * enqueued it, or starts after it answered) runs to the right edge and fades out there (`past`).
 */
function barPlace(trace: Trace, start: number, length: number): { style: CSSProperties; past: "" | undefined } {
  const total = Math.max(trace.duration, 1);
  const left = Math.min(Math.max(((start - trace.start) / total) * 100, 0), 100 - PAST_MIN);
  const past = start + length > trace.start + total;
  const width = past ? 100 - left : Math.max((length / total) * 100, 0.4);
  return { style: { left: `${left}%`, width: `${width}%` }, past: past ? "" : undefined };
}

/** A trace of its own under a span of this one: a task (or one waiting for a worker), or another app's trace. */
type Linked = Extract<Node, { type: "task" | "waiting" }>;

/** How a linked row looks: its kind, its text, its bar on the request's timeline and its time. */
interface LinkedView {
  status: string | undefined;
  kind: string;
  text: ReactNode;
  track: ReactNode;
  time: string;
}

/** A task's run in a worker, or the trace another app served for a call. */
function runView(node: Extract<Node, { type: "task" }>, trace: Trace): LinkedView {
  return {
    status: node.run.status,
    kind: node.kind === "call" ? "app" : "task",
    text: (
      <>
        {node.kind === "task" ? (
          <TaskName name={node.run.name} className="dt-map-text" />
        ) : (
          <span className="dt-map-text">{node.run.name}</span>
        )}
        <TaskState state={node.run.task_state} />
        {node.kind === "call" ? <CallApp node={node} /> : null}
        {/* What its own trace found, before it is opened. */}
        <RunChips trace={node.run} />
      </>
    ),
    track: <Bar trace={trace} start={node.run.start} length={node.run.duration} />,
    time: duration(node.run.duration),
  };
}

/** Which app served a call: its runtime's mark, and its project (another agent's) or its service (this one's). */
function CallApp({ node }: { node: Extract<Node, { type: "task" }> }) {
  const name = appName(node);
  return name ? <AppChip name={name} runtime={traceRuntime(node.whole?.attrs ?? {})} /> : null;
}

function appName(node: Extract<Node, { type: "task" }>): string | undefined {
  const service = node.whole?.attrs["service.name"];
  return node.remote?.project ?? (typeof service === "string" ? service : undefined);
}

/** A task enqueued that no worker has run yet. */
function waitingView(node: Extract<Node, { type: "waiting" }>, trace: Trace): LinkedView {
  return {
    status: undefined,
    kind: "task",
    text: <span className="dt-map-text dt-map-waiting">waiting for a worker…</span>,
    track: <span className="dt-map-track" aria-hidden="true" />,
    time: `+${duration(Math.max(node.span.start - trace.start, 0))}`,
  };
}

/** A trace of its own under a span of this one: a task (or one waiting for a worker), or another app's trace. */
function LinkedRow({
  node,
  ctx,
  indent,
  depth,
  dim,
}: {
  node: Linked;
  ctx: RowContext;
  indent: CSSProperties;
  depth: number;
  dim: boolean;
}) {
  const children = childrenOf(node);
  // Open from the start: what the other app did is why it is here.
  const open = children.length > 0 ? dim || !ctx.collapsed.has(node.key) : undefined;
  return (
    <div>
      <LinkedButton node={node} ctx={ctx} indent={indent} dim={dim} open={open} />
      <RowDetails id={node.key} ctx={ctx} />
      {open ? <Rows nodes={children} depth={depth + 1} ctx={ctx} /> : null}
    </div>
  );
}

/** The linked row itself; `open` is set when it has rows to fold: a first click selects it, a second folds it. */
function LinkedButton({
  node,
  ctx,
  indent,
  dim,
  open,
}: {
  node: Linked;
  ctx: RowContext;
  indent: CSSProperties;
  dim: boolean;
  open: boolean | undefined;
}) {
  const view = linkedView(node, ctx.trace);
  const selected = ctx.selected === node.key;
  return (
    <button
      type="button"
      className="dt-map-row"
      data-dim={dim ? "" : undefined}
      data-kind="task"
      data-status={view.status}
      aria-expanded={open}
      aria-current={selected ? "true" : undefined}
      onClick={() => {
        if (selected && open !== undefined) ctx.onToggle(node.key);
        ctx.onSelect(node.key);
      }}
      onKeyDown={foldKeys(open, () => ctx.onToggle(node.key))}
    >
      <span className="dt-map-name" style={indent}>
        <Caret open={open} onToggle={() => ctx.onToggle(node.key)} />
        <KindBadge kind={view.kind} muted={true} className="dt-map-kind" />
        {view.text}
      </span>
      {view.track}
      <span className="dt-map-time">{view.time}</span>
    </button>
  );
}

function linkedView(node: Linked, trace: Trace): LinkedView {
  return node.type === "task" ? runView(node, trace) : waitingView(node, trace);
}

/** The rows under a row: a span's, or those of a call's trace that came whole. */
function childrenOf(node: Node): Node[] {
  return node.type === "span" || node.type === "task" ? node.children : [];
}

/** Where a row is drawn: how deep, how far in, whether it is only on the way to a filtered row, under which span. */
interface RowPlace {
  ctx: RowContext;
  indent: CSSProperties;
  depth: number;
  mark: Mark | undefined;
  parent: Span | undefined;
}

type RowProps<T extends Node["type"]> = { node: Extract<Node, { type: T }>; place: RowPlace };

function Rows({
  nodes,
  depth,
  ctx,
  parent,
}: {
  nodes: Node[];
  depth: number;
  ctx: RowContext;
  parent?: Span | undefined;
}) {
  return (
    <>
      {nodes.map((node) => {
        const mark = ctx.marks?.get(node.key);
        if (ctx.marks && !mark) return null;
        const place = { ctx, indent: { paddingLeft: `${12 + depth * 16}px` }, depth, mark, parent };
        return <Row key={node.key} node={node} place={place} />;
      })}
    </>
  );
}

const ROWS: { [T in Node["type"]]: (props: RowProps<T>) => ReactNode } = {
  span: SpanRow,
  group: GroupRow,
  log: LeafRow,
  error: LeafRow,
  task: PlacedLinkedRow,
  waiting: PlacedLinkedRow,
};

function Row(props: RowProps<Node["type"]>) {
  const Shown = ROWS[props.node.type] as (props: RowProps<Node["type"]>) => ReactNode;
  return <Shown {...props} />;
}

/** A row's state as its button says it: dimmed on the way to a filtered row, current while selected. */
function rowState(ctx: RowContext, key: string, mark: Mark | undefined) {
  return {
    "data-dim": mark === "path" ? "" : undefined,
    "aria-current": ctx.selected === key ? ("true" as const) : undefined,
  };
}

/** A row's alias chip: none when its name already says it (`transaction app.sqlite3`). */
function aliasBeside(span: Span): unknown {
  const alias = aliasOf(span);
  return typeof alias === "string" && span.name.includes(alias) ? undefined : alias;
}

/** A call's database or cache alias, when it has one. */
function aliasOf(span: Span | undefined): unknown {
  return span?.attrs["db.alias"] ?? span?.attrs["cache.alias"];
}

function PlacedLinkedRow({ node, place: { ctx, indent, depth, mark } }: { node: Linked; place: RowPlace }) {
  return <LinkedRow node={node} ctx={ctx} indent={indent} depth={depth} dim={mark === "path"} />;
}

/** How a log record or an error reads as a row: its kind, its level, when, what it says. */
function leafView(node: Extract<Node, { type: "log" | "error" }>) {
  if (node.type === "error") {
    const text = `${node.error.type.replace(/^builtins\./, "")}: ${node.error.message}`;
    return { kind: "error", level: "error", time: node.error.time, text };
  }
  return { kind: "log", level: node.log.level, time: node.log.time, text: node.log.message };
}

/** A log record or an error: a point on the timeline, at its time since the request started. */
function LeafRow({
  node,
  place: { ctx, indent, mark },
}: {
  node: Extract<Node, { type: "log" | "error" }>;
  place: RowPlace;
}) {
  const view = leafView(node);
  return (
    <>
      <button
        type="button"
        className="dt-map-row"
        {...rowState(ctx, node.key, mark)}
        data-kind={view.kind}
        data-level={view.level}
        onClick={() => ctx.onSelect(node.key)}
      >
        <span className="dt-map-name" style={indent}>
          <span className="dt-map-caret" />
          <KindBadge kind={view.level} muted={true} className="dt-map-kind" />
          <span className="dt-map-text">{view.text}</span>
        </span>
        <Bar trace={ctx.trace} start={view.time} length={0} point={true} />
        <span className="dt-map-time" title={`Logged ${since(view.time, ctx.trace.start)}`}>
          +{duration(Math.max(view.time - ctx.trace.start, 0))}
        </span>
      </button>
      <RowDetails id={node.key} ctx={ctx} />
    </>
  );
}

/**
 * The template a call ran from, unless the row it hangs under is that template, named already (a line of it still
 * says where).
 */
function FromTemplate({ span, parent }: { span: Span | undefined; parent: Span | undefined }) {
  if (!span || saidAbove(span, parent)) return null;
  return <TemplateChip attrs={span.attrs} />;
}

/** Whether the row a call hangs under is the template it ran from. */
function saidAbove(span: Span, parent: Span | undefined): boolean {
  return parent?.kind === "template" && parent.name === templatePlace(span.attrs);
}

/** A group's kind, its call's template, its alias, the page template that made it, how many and its issue. */
function GroupName({
  node,
  ctx,
  parent,
}: {
  node: Extract<Node, { type: "group" }>;
  ctx: RowContext;
  parent: Span | undefined;
}) {
  const issue = node.spans.map((span) => ctx.issueBySpan.get(span.id)).find(Boolean);
  const first = node.spans[0];
  return (
    <>
      <KindBadge kind={spanKindLabel(first?.kind, ctx.trace.attrs)} muted={true} className="dt-map-kind" />
      <span className="dt-map-text">{callTemplate(first)}</span>
      <AliasChip value={aliasOf(first)} />
      <FromTemplate span={first} parent={parent} />
      <span className="dt-map-times">×{node.spans.length}</span>
      {issue ? <IssueChip kind={issue} className={ISSUE_CHIP_SHRINKS} /> : null}
    </>
  );
}

/** Repeats of one call folded into one row (×N), its calls as ticks on the timeline; open, each call a row. */
function GroupRow({ node, place: { ctx, indent, depth, mark, parent } }: RowProps<"group">) {
  const open = ctx.collapsed.has(`open:${node.key}`);
  const total = node.spans.reduce((sum, span) => sum + span.duration, 0);
  return (
    <div className="dt-map-group">
      <button
        type="button"
        className="dt-map-row"
        {...rowState(ctx, node.key, mark)}
        data-kind={node.spans[0]?.kind}
        aria-expanded={open}
        onClick={() => {
          ctx.onSelect(node.key);
          ctx.onToggle(`open:${node.key}`);
        }}
        onKeyDown={foldKeys(open, () => ctx.onToggle(`open:${node.key}`))}
      >
        <span className="dt-map-name" style={indent}>
          <Caret open={open} onToggle={() => ctx.onToggle(`open:${node.key}`)} />
          <GroupName node={node} ctx={ctx} parent={parent} />
        </span>
        <GroupTicks spans={node.spans} trace={ctx.trace} />
        <span className="dt-map-time">{duration(total)}</span>
      </button>
      <RowDetails id={node.key} ctx={ctx} />
      {open ? (
        <Rows
          nodes={node.spans.map((span) => ({ type: "span", key: span.id, span, children: [] }))}
          depth={depth + 1}
          ctx={{ ...ctx, marks: undefined }}
          parent={parent}
        />
      ) : null}
    </div>
  );
}

/** Where each call of a group started, on the request's timeline. */
function GroupTicks({ spans, trace }: { spans: readonly Span[]; trace: Trace }) {
  return (
    <span className="dt-map-track" aria-hidden="true">
      {spans.map((span) => (
        <span
          key={span.id}
          className="dt-map-bar"
          data-tick=""
          style={{
            left: `${Math.min(Math.max(((span.start - trace.start) / Math.max(trace.duration, 1)) * 100, 0), 100)}%`,
          }}
        />
      ))}
    </span>
  );
}

/** The spans right under a row: a signal's receivers among them. */
function childSpans(node: Extract<Node, { type: "span" }>): Span[] {
  return node.children.flatMap((child) => (child.type === "span" ? [child.span] : []));
}

/** A span's fold: none without rows under it; open unless folded, always on the way to a filtered row. */
function spanFold(node: Extract<Node, { type: "span" }>, mark: Mark | undefined, ctx: RowContext): boolean | undefined {
  const hasChildren = node.children.length > 0;
  return foldOf(hasChildren, hasChildren && (mark === "path" || !ctx.collapsed.has(node.key)));
}

/** First click selects the row (and opens it); a second click closes its details (and folds it). */
function clickSpan(ctx: RowContext, key: string, fold: boolean | undefined): void {
  // Closed and not selected yet, or open and selected: the click folds it too.
  if (fold === (ctx.selected === key)) ctx.onToggle(key);
  ctx.onSelect(key);
}

const TASK_SPANS = new Set(["task", "task.enqueue"]);
const ENQUEUE = "enqueue ";

/** A span's name; a task's run, or its sending, named as a task is everywhere (the kind says which). */
function SpanName({ span }: { span: Span }) {
  if (span.kind === "task.enqueue" && span.name.startsWith(ENQUEUE)) {
    // "enqueue " stays whole: only the task's name gives way.
    return (
      <span className="dt-map-text flex">
        <span className="shrink-0 whitespace-pre">{ENQUEUE}</span>
        <TaskName name={span.name.slice(ENQUEUE.length)} />
      </span>
    );
  }
  if (TASK_SPANS.has(span.kind)) return <TaskName name={span.name} className="dt-map-text" />;
  return <span className="dt-map-text">{span.name}</span>;
}

/** A span: its kind, its name and what goes with it, its bar and its time; its rows under it, open or folded. */
function SpanRow({ node, place: { ctx, indent, depth, mark, parent } }: RowProps<"span">) {
  const { span } = node;
  const fold = spanFold(node, mark, ctx);
  const issue = ctx.issueBySpan.get(span.id);
  return (
    <div>
      <button
        type="button"
        className="dt-map-row"
        {...rowState(ctx, node.key, mark)}
        data-kind={span.kind}
        data-status={span.status}
        aria-expanded={fold}
        onClick={() => clickSpan(ctx, node.key, fold)}
        onKeyDown={foldKeys(fold, () => ctx.onToggle(node.key))}
      >
        <span className="dt-map-name" style={indent}>
          <Caret open={fold} onToggle={() => ctx.onToggle(node.key)} />
          <KindBadge
            kind={spanKindLabel(span.kind, ctx.trace.attrs, parent?.kind)}
            muted={true}
            className="dt-map-kind"
          />
          <SpanName span={span} />
          <AliasChip value={aliasBeside(span)} />
          <FromTemplate span={span} parent={parent} />
          <SignalNotes span={span} parent={parent} under={childSpans(node)} />
          <HiddenLogs count={ctx.hiddenLogs.get(span.id)} onShow={ctx.onShowLogs} />
          {issue ? <IssueChip kind={issue} className={ISSUE_CHIP_SHRINKS} /> : null}
        </span>
        <Bar trace={ctx.trace} start={span.start} length={span.duration} />
        <span className="dt-map-time" title={timeTitle(span, ctx.trace)}>
          {duration(span.duration)}
        </span>
      </button>
      <RowDetails id={node.key} ctx={ctx} />
      {fold ? (
        <>
          <Rows nodes={node.children} depth={depth + 1} ctx={ctx} parent={span} />
          <CodeRow span={span} ctx={ctx} depth={depth + 1} />
        </>
      ) : null}
    </div>
  );
}

/** Whether a span runs inside another, however deep. */
function insideOf(ancestor: Span, byId: ReadonlyMap<string, Span>): (span: Span) => boolean {
  return (span) => {
    for (let at = byId.get(String(span.parent_id)); at; at = byId.get(String(at.parent_id))) {
      if (at.id === ancestor.id) return true;
    }
    return false;
  };
}

/** The SQL a transaction ran: its queries' time, nested ones too. */
function sqlInside(transaction: Span, trace: Trace): number {
  const inside = insideOf(transaction, new Map(trace.spans.map((span) => [span.id, span])));
  return trace.spans
    .filter((span) => span.kind === "sql" && inside(span))
    .reduce((sum, span) => sum + span.duration, 0);
}

/**
 * What a row's time is, on hover, where it isn't plain: a transaction's is how long it was open, of which the SQL
 * inside took a part; the rest is code running while it is held, not the database.
 */
function timeTitle(span: Span, trace: Trace): string | undefined {
  if (span.kind !== "transaction") return undefined;
  const sql = duration(sqlInside(span, trace));
  return `Open ${duration(span.duration)}; SQL inside took ${sql}, the rest is code running while it's held`;
}

/* ---------- the code's own time ---------- */

/** A code row shows unless other shares are picked, or a range it doesn't overlap. */
function codeShown(quiet: Quiet, category: Category, ctx: RowContext): boolean {
  const { parts, range } = ctx.slice;
  if (parts.length > 0 && !parts.includes(partOfCategory(category))) return false;
  return range === null || quiet.gaps.some(([from, to]) => overlaps(range, from - ctx.trace.start, to - from));
}

/** A code row's pieces of time: where it waited, or where it computed (µs since the trace started). */
interface CodePart {
  waiting: boolean;
  pieces: Piece[];
  total: number;
}

/** A span's own code in its parts: what it waited in and what it computed in, each when there is any. */
function codeParts(quiet: Quiet, trace: Trace): CodePart[] {
  const pieces = quiet.gaps.flatMap(([from, to]) => quietPieces(trace.profile, from - trace.start, to - trace.start));
  return [true, false].flatMap((waiting): CodePart[] => {
    const own = pieces.filter((piece) => piece.waiting === waiting);
    const total = own.reduce((sum, piece) => sum + piece.to - piece.from, 0);
    return total > 0 ? [{ waiting, pieces: own, total }] : [];
  });
}

/** The stretch a part spans, from its first piece to its last. */
function partRange(part: CodePart): TimeRange {
  const first = part.pieces[0] as Piece;
  const last = part.pieces.at(-1) as Piece;
  return [first.from, last.to];
}

/** Where its code ran with nothing recorded inside, hatched in its share's colour; pieces too thin to see left out. */
function CodeBars({ part, category, trace }: { part: CodePart; category: Category; trace: Trace }) {
  const total = Math.max(trace.duration, 1);
  return (
    <span className="dt-map-track" aria-hidden="true">
      {part.pieces
        .filter((piece) => piece.to - piece.from >= total * 0.004)
        .map((piece) => (
          <span
            key={piece.from}
            className="dt-map-bar"
            data-quiet=""
            data-waiting={part.waiting ? "" : undefined}
            data-category={category}
            style={{ left: widthOf(piece.from, total), width: widthOf(piece.to - piece.from, total) }}
          />
        ))}
    </span>
  );
}

/**
 * What a code row is: with a profile, the functions of yours that ran most in that stretch (or what it waited on);
 * without one, untraced code, waiting where the profile can't say.
 */
function partName(part: CodePart, trace: Trace): string {
  const { profile } = profileOver(trace, partRange(part));
  if (part.waiting) return waited(profile);
  return profile ? ranMost(profile) : "untraced code";
}

/** "asyncio.sleep in send_digest": what the code waited on, or just waiting where the profile can't say. */
function waited(profile: Profile | undefined): string {
  return (profile && waitName(profile)) || "waiting";
}

/** "aggregate · render_csv": the two functions of yours that ran most, or untraced code where none of yours ran. */
function ranMost(profile: Profile): string {
  const names = ownHotspots(profile, 2).map((hotspot) => hotspot.name);
  return names.join(" · ") || "untraced code";
}

/** A code row's own: a grey box ("code", or "wait"), its name, the way on to the profile, its bars and its time. */
function CodeRowParts({ span, ctx, depth, part }: { span: Span; ctx: RowContext; depth: number; part: CodePart }) {
  const category = ctx.categories.get(span.id) ?? "code";
  return (
    <>
      <span className="dt-map-name" style={{ paddingLeft: `${12 + depth * 16}px` }}>
        <span className="dt-map-caret" />
        <KindBadge kind={part.waiting ? "wait" : "code"} muted={true} className="dt-map-kind" />
        <TaskName name={partName(part, ctx.trace)} className="dt-map-text" title={false} />
        <RowFlame trace={ctx.trace} />
      </span>
      <CodeBars part={part} category={category} trace={ctx.trace} />
      <span className="dt-map-time">{duration(part.total)}</span>
    </>
  );
}

/**
 * Under a span whose children leave much of its time uncovered (the strip's hatched stretches, the same time): its
 * own code, a row of its own, and where the profile says it waited, a "waiting" row before it. With a profile, a
 * click opens it at that time and what ran shows on hover; where the app profiles on request, how to get one. Not a
 * span: no details, no filter counts it.
 */
function CodeRow({ span, ctx, depth }: { span: Span; ctx: RowContext; depth: number }) {
  if (!hasCodeRow(span, ctx)) return null;
  const parts = codeParts(ctx.quiet.get(span.id) as Quiet, ctx.trace);
  return (
    <>
      {parts.map((part) => (
        <CodePartRow key={String(part.waiting)} span={span} ctx={ctx} depth={depth} part={part} />
      ))}
    </>
  );
}

function CodePartRow({ span, ctx, depth, part }: { span: Span; ctx: RowContext; depth: number; part: CodePart }) {
  const profiling = useProfilingOf(ctx.trace);
  const inside = <CodeRowParts span={span} ctx={ctx} depth={depth} part={part} />;
  const open = ctx.onProfile;
  const row = open ? (
    <button type="button" className="dt-map-row" data-kind="code" onClick={() => open(partRange(part))}>
      {inside}
    </button>
  ) : (
    <div className="dt-map-row" data-kind="code">
      {inside}
    </div>
  );
  const offered = Boolean(ctx.trace.profile) || profiling.available;
  const onOpen = open ? () => open(partRange(part)) : undefined;
  return <WithWhatRan trace={ctx.trace} offered={offered} row={row} part={part} onOpen={onOpen} />;
}

/** Whether a span has a code row: its code ran long with nothing recorded inside, and what is picked keeps it. */
function hasCodeRow(span: Span, ctx: RowContext): boolean {
  const quiet = ctx.quiet.get(span.id);
  return quiet !== undefined && codeShown(quiet, ctx.categories.get(span.id) ?? "code", ctx);
}

/**
 * A code row with what ran (or waited) in it on hover, when there is anything to say. Its tooltip holds the way on
 * (the profile, or Profile turned on): it stays open while the pointer travels into it, and Esc closes it first.
 */
function WithWhatRan({
  trace,
  offered,
  row,
  part,
  onOpen,
}: {
  trace: Trace;
  offered: boolean;
  row: ReactNode;
  part: CodePart;
  onOpen: (() => void) | undefined;
}) {
  if (!offered) return row;
  const range = partRange(part);
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} arrow={false} className={CODE_TIP_CLASS} {...{ [ESCAPE_FIRST]: "" }}>
        {part.waiting ? (
          <WhatWaited trace={trace} range={range} waited={part.total} onOpen={onOpen} />
        ) : (
          <WhatRan trace={trace} range={range} onOpen={onOpen} />
        )}
      </TooltipContent>
    </Tooltip>
  );
}

const CODE_TIP_CLASS =
  "grid w-72 gap-1.5 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-[var(--dt-popover-shadow)]";

/**
 * The fold of a row with rows under it: a click on it opens or closes them only, without selecting the row and
 * opening its details. A row without any has the empty slot, so names line up.
 */
function Caret({ open, onToggle }: { open: boolean | undefined; onToggle: () => void }) {
  if (open === undefined) return <span className="dt-map-caret" />;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: inside the row's button; the keyboard folds with the arrows (foldKeys).
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row's button takes the keys.
    <span
      className="dt-map-caret"
      data-toggle=""
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <ChevronRightIcon />
    </span>
  );
}

/** A row's fold: open or closed, or none for a row with nothing under it. */
function foldOf(hasChildren: boolean, open: boolean): boolean | undefined {
  return hasChildren ? open : undefined;
}

/** As in any tree: → opens a closed row's children, ← closes an open one's. */
function foldKeys(open: boolean | undefined, toggle: () => void): (event: KeyboardEvent) => void {
  const key = open ? "ArrowLeft" : "ArrowRight";
  return (event) => {
    if (open === undefined || event.key !== key) return;
    event.preventDefault();
    toggle();
  };
}

function TaskState({ state }: { state: string | null }) {
  return state ? <StateBadge state={state} /> : null;
}

/* ---------- details of the selected row ---------- */

/** The row with this key, and the trace it belongs to: this one, or a call's trace opened under the call. */
function findNode(nodes: Node[], key: string, trace: Trace): Found | undefined {
  for (const node of nodes) {
    const found = findIn(node, key, trace);
    if (found) return found;
  }
  return undefined;
}

type Found = { node: Node; trace: Trace };

function findIn(node: Node, key: string, trace: Trace): Found | undefined {
  if (node.key === key) return { node, trace };
  if (node.type === "group") return groupSpan(node, key, trace);
  return findNode(childrenOf(node), key, ownerOf(node, trace));
}

/** One call of a group, as its own row. */
function groupSpan(node: Extract<Node, { type: "group" }>, key: string, trace: Trace): Found | undefined {
  const span = node.spans.find((item) => item.id === key);
  return span ? { node: { type: "span", key: span.id, span, children: [] }, trace } : undefined;
}

/** The trace a row's children belong to: a call's own when it came whole. */
function ownerOf(node: Node, trace: Trace): Trace {
  return node.type === "task" && node.whole ? node.whole : trace;
}

/** How a run's details name it: a task a worker ran, or the trace another app served for a call. */
const RUN_WORDS = {
  task: { what: "task", label: "Task", open: "Open the task's trace →" },
  call: { what: "served by another app", label: "Trace", open: "Open the trace it served →" },
} as const;

/** A run's numbers: its name, a task's state, its queries and issues. */
function runRows(run: TraceSummary, label: string) {
  return [
    { label, value: run.name, copy: run.name, mono: true },
    ...(run.task_state ? [{ label: "State", value: <TaskState state={run.task_state} /> }] : []),
    { label: "Queries", value: String(run.queries) },
    ...(run.issues ? [{ label: "Issues", value: String(run.issues) }] : []),
  ];
}

/** A trace of its own this trace led to: what it was, when it started, how long it took, a link to it. */
/** Where a linked trace opens: here, or in its own project's console in a tab of its own. */
function OpenRun({
  run,
  words,
  links,
  remote,
}: {
  run: TraceSummary;
  words: { open: string };
  links?: TraceLinks | undefined;
  remote?: Remote | undefined;
}) {
  if (remote) {
    return (
      <a className="dt-map-open" href={`${remote.console}#/t/${run.id}`} target="_blank" rel="noopener">
        Open in {remote.project}'s console
      </a>
    );
  }
  const open = traceLinkProps(links, run.id);
  return open ? (
    <a className="dt-map-open" {...open}>
      {words.open}
    </a>
  ) : null;
}

function RunDetails({
  run,
  kind,
  trace,
  links,
  remote,
}: {
  run: TraceSummary;
  kind: "task" | "call";
  trace: Trace;
  links?: TraceLinks | undefined;
  remote?: Remote | undefined;
}) {
  const words = RUN_WORDS[kind];
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">
        {words.what} · started {duration(Math.max(run.start - trace.start, 0))} after this request · took{" "}
        {duration(run.duration)}
      </p>
      <PropTable dense rows={runRows(run, words.label)} />
      <OpenRun run={run} words={words} links={links} remote={remote} />
    </div>
  );
}

/** A task this trace enqueued that no worker has run yet. */
function WaitingDetails({ span }: { span: Span }) {
  const name = String(span.attrs["task.name"] ?? span.name);
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">task · enqueued, not run yet</p>
      <PropTable dense rows={[{ label: "Task", value: name, copy: name, mono: true }]} />
      <p className="text-sm text-muted-foreground">It shows up here once a worker has run it (is a worker running?).</p>
    </div>
  );
}

function LinkedDetails({ node, trace, links }: { node: Linked; trace: Trace; links?: TraceLinks | undefined }) {
  if (node.type === "waiting") return <WaitingDetails span={node.span} />;
  return <RunDetails run={node.run} kind={node.kind} trace={trace} links={links} remote={node.remote} />;
}

type DetailsProps<T extends Node["type"]> = {
  node: Extract<Node, { type: T }>;
  trace: Trace;
  links?: TraceLinks | undefined;
};

function LogDetails({ node }: DetailsProps<"log">) {
  return <LogRecordDetails log={node.log} titled={true} />;
}

function ErrorDetails({ node }: DetailsProps<"error">) {
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">Error</p>
      <p className="dt-error-message">
        <b>{node.error.type.replace(/^builtins\./, "")}</b>: {node.error.message}
      </p>
    </div>
  );
}

/** A SQL call's statement, formatted. */
function Statement({ span, attrs }: { span: Span; attrs: Attrs }) {
  if (span.kind !== "sql") return null;
  return <SqlCode sql={String(attrs["db.statement"] ?? span.name)} vendor={String(attrs["db.vendor"] ?? "")} />;
}

function GroupDetails({ node }: DetailsProps<"group">) {
  const [first] = node.spans;
  const origins = new Set(node.spans.map((span) => String(span.attrs["code.origin"] ?? "")));
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">
        {node.spans.length} similar {groupNoun(first)} ·{" "}
        {duration(node.spans.reduce((sum, span) => sum + span.duration, 0))} total
      </p>
      {first ? (
        <>
          <Statement span={first} attrs={first.attrs} />
          <Fields rows={summaryRows(first, false)} />
        </>
      ) : null}
      <p className="flex flex-wrap items-center gap-2 text-base text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_code]:text-foreground">
        from{" "}
        {[...origins].map((origin) => (
          <code key={origin}>{origin}</code>
        ))}
      </p>
    </div>
  );
}

function SpanTitle({ span, trace, parent }: { span: Span; trace: Trace; parent: Span | undefined }) {
  const offset = duration(Math.max(span.start - trace.start, 0));
  return (
    <p className="dt-map-details-title">
      {spanKindLabel(span.kind, trace.attrs, parent?.kind)} · started at +{offset} · took {duration(span.duration)}
    </p>
  );
}

/** What a span raised (a signal's receiver, under send_robust(): the trace has no error of it), as an error reads. */
function Raised({ attrs }: { attrs: Attrs }) {
  const found = raised(attrs);
  if (!found) return null;
  return (
    <p className="dt-error-message">
      <b className="text-error">{found.type}</b>
      {found.message ? `: ${found.message}` : null}
    </p>
  );
}

/** What every span's details open with: what it was, what it raised, its statement or its GraphQL document. */
function SpanHead({
  span,
  trace,
  parent,
  attrs,
}: {
  span: Span;
  trace: Trace;
  parent?: Span | undefined;
  attrs: Attrs;
}) {
  const document = attrs["graphql.document"];
  return (
    <>
      <SpanTitle span={span} trace={trace} parent={parent} />
      <Raised attrs={span.attrs} />
      <Statement span={span} attrs={attrs} />
      {typeof document === "string" ? <GraphqlCode document={document} /> : null}
    </>
  );
}

function SpanDetails(props: DetailsProps<"span">) {
  return props.node.span.parent_id === null ? <RootDetails {...props} /> : <CallDetails {...props} />;
}

/** The root span stands for the whole request: its details are the trace's own attributes, as its Request tab shows them. */
function RootDetails({ node: { span }, trace }: DetailsProps<"span">) {
  const attrs = { ...trace.attrs, ...span.attrs };
  return (
    <div className="grid gap-3 p-4">
      <SpanHead span={span} trace={trace} attrs={attrs} />
      <RootAttributes attrs={attrs} />
    </div>
  );
}

/** A call's own fields in words first (its topic, its URL, where in the code); every attribute after them. */
function CallDetails({ node: { span }, trace }: DetailsProps<"span">) {
  const parent = trace.spans.find((each) => each.id === span.parent_id);
  const summary = summaryRows(span, true, parent);
  return (
    <div className="grid gap-3 p-4">
      <SpanHead span={span} trace={trace} parent={parent} attrs={span.attrs} />
      {summary.length ? <Fields rows={summary} /> : null}
      <SpanAttributes span={span} attrs={span.attrs} titled={summary.length > 0} />
    </div>
  );
}

/**
 * The trace's attributes on its request row, as its Request tab shows them: the same parts behind the same switch
 * (Headers, Query, Body, Cookies, Session, Response, Attributes), in the same rows, no box. The GraphQL document is
 * shown formatted above.
 */
function RootAttributes({ attrs }: { attrs: Attrs }) {
  const { "graphql.document": _, ...rest } = attrs;
  const others = Object.fromEntries(Object.entries(rest).filter(([key]) => !isRequestDetail(key)));
  return <RequestParts parts={requestParts(rest, others)} look="plain" />;
}

/** A call's fields in words, in the rows of a trace's info tab: no box around them. */
function Fields({ rows }: { rows: readonly NameValue[] }) {
  return (
    <RowsLookContext value="plain">
      <NameValues rows={rows} />
    </RowsLookContext>
  );
}

/** Every attribute of a span; a template's context first, as rows of its own. */
function SpanAttributes({ span, attrs, titled }: { span: Span; attrs: Attrs; titled: boolean }) {
  const template = span.kind === "template";
  return (
    <>
      {template ? <TemplateContext attrs={attrs} /> : null}
      <AllAttributes attrs={withoutContext(attrs)} titled={titled || template} />
    </>
  );
}

const DETAILS: { [T in Node["type"]]: (props: DetailsProps<T>) => ReactNode } = {
  span: SpanDetails,
  group: GroupDetails,
  log: LogDetails,
  error: ErrorDetails,
  task: LinkedDetails,
  waiting: LinkedDetails,
};

function Details(props: DetailsProps<Node["type"]>) {
  const Shown = DETAILS[props.node.type] as (props: DetailsProps<Node["type"]>) => ReactNode;
  return <Shown {...props} />;
}

/** A call's fields as rows; a list (a signal's receivers) one item a line. */
function summaryRows(span: Span, origin = true, parent?: Span | undefined): NameValue[] {
  const kind = isReceiver(span, parent) ? "receiver" : span.kind;
  return callFields({ kind, attrs: span.attrs }, origin).map(({ label, value }) => ({ name: label, value }));
}

/* ---------- side pane ---------- */

/** From this width of the call tree its details open beside it; narrower, under their row. */
const SIDE_MIN_WIDTH = 760;

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** The pane sticks under the trace's sticky tabs and fits in the rest of the scrolling view. */
function stickyTop(map: HTMLElement): number {
  return map.closest(".dt-trace")?.querySelector<HTMLElement>(".dt-trace-strip, .dt-tabs")?.offsetHeight ?? 0;
}

function viewHeight(map: HTMLElement): number {
  return scrollParent(map)?.clientHeight ?? window.innerHeight;
}

function fitSidePane(map: HTMLElement): void {
  const top = stickyTop(map);
  const view = viewHeight(map);
  map.style.setProperty("--dt-side-top", `${top}px`);
  map.style.setProperty("--dt-side-height", `${view - top}px`);
}

/** Whether the call tree is wide enough for the details pane beside it. */
function useSidePane(map: RefObject<HTMLDivElement | null>): boolean {
  const [side, setSide] = useState(false);
  useEffect(() => {
    const element = map.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setSide(element.clientWidth >= SIDE_MIN_WIDTH);
      fitSidePane(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [map]);
  return side;
}

/** Beside the tree, like the devtools' Network panel: the tree keeps its shape, the details stay in view. */
function SidePane({ children, onClose, resize }: { children: ReactNode; onClose: () => void; resize: ReactNode }) {
  return (
    <aside className="dt-map-side" aria-label="Details">
      {resize}
      <button type="button" className="dt-map-side-close" aria-label="Close the details" onClick={onClose}>
        <CloseIcon />
      </button>
      {children}
    </aside>
  );
}

/** The tree, and its details beside it while it is wide enough. */
function MapBody({ details, onClose, children }: { details: ReactNode; onClose: () => void; children: ReactNode }) {
  const { width, setWidth, style } = useSideWidth();
  return (
    <div className="dt-map-body" data-side={details ? "" : undefined} style={details ? style : undefined}>
      <div className="dt-map-tree">{children}</div>
      {details ? (
        <SidePane onClose={onClose} resize={<SideResize width={width} onWidth={setWidth} />}>
          {details}
        </SidePane>
      ) : null}
    </div>
  );
}

/* ---------- component ---------- */

/** The selected row; clicking it again closes its details. */
function useSelection(initialSpan: string | undefined) {
  const [selected, setSelected] = useState<string | null>(initialSpan ?? null);
  // Another span asked for while the tree is open (a mark on the lanes over it): that one is selected.
  useEffect(() => {
    if (initialSpan) setSelected(initialSpan);
  }, [initialSpan]);
  const select = (key: string) => setSelected((current) => (current === key ? null : key));
  return { selected, select, close: () => setSelected(null) };
}

/** The rows, brought into view once when a link opened the tree on one of them. */
function useScrolledToInitial(initialSpan: string | undefined): RefObject<HTMLDivElement | null> {
  const rows = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (initialSpan) rows.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
  }, [initialSpan]);
  return rows;
}

function detailsOf(tree: Node[], selected: string | null, trace: Trace, links: TraceLinks | undefined): ReactNode {
  const found = selected ? findNode(tree, selected, trace) : undefined;
  return found ? <Details node={found.node} trace={found.trace} links={links} /> : null;
}

/** Keys toggled in and out of a set: the folded rows, the opened groups. */
function useToggleSet(): [ReadonlySet<string>, (key: string) => void] {
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return [keys, toggle];
}

/** The rows a slice keeps, or undefined while it is the whole trace. */
function marksOf(tree: Node[], picked: Picked): Map<string, Mark> | undefined {
  if (picked.parts.size === 0 && picked.range === null) return undefined;
  const found = new Map<string, Mark>();
  markTree(tree, picked, found);
  return found;
}

/** Where the track column of the rows is, across the tree: the picked range is drawn over it, rows and head. */
function useTrackColumn(
  timed: RefObject<HTMLDivElement | null>,
  ruler: RefObject<HTMLSpanElement | null>,
): CSSProperties | undefined {
  const [place, setPlace] = useState<CSSProperties | undefined>(undefined);
  useEffect(() => {
    const box = timed.current;
    if (!box) return;
    const observer = new ResizeObserver(() => {
      const column = ruler.current?.getBoundingClientRect();
      const outer = box.getBoundingClientRect();
      if (column) setPlace({ left: column.left - outer.left, width: column.width });
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [timed, ruler]);
  return place;
}

/**
 * The head and the rows, over the trace's time: a drag across the bars' column (or the head over it) picks a
 * stretch of it, a double click lets it go.
 */
function TimedRows({
  trace,
  range,
  onRange,
  children,
}: {
  trace: Trace;
  range: TimeRange | null;
  onRange: (range: TimeRange | null) => void;
  children: ReactNode;
}) {
  const timed = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const column = useTrackColumn(timed, ruler);
  const total = Math.max(trace.duration, 1);
  const drag = useRangeDrag(total, onRange);
  const shown = drag.draft ?? range;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drag over the rows, which are buttons of their own.
    <div
      className="dt-map-timed"
      ref={timed}
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (ruler.current && target.closest(".dt-map-track, .dt-map-ruler")) drag.start(event, ruler.current);
      }}
      onDoubleClick={(event) => {
        if ((event.target as Element).closest(".dt-map-track, .dt-map-ruler")) onRange(null);
      }}
    >
      <div className="dt-map-head">
        <span>Call tree</span>
        <span className="dt-map-ruler" ref={ruler} title="Drag to pick a stretch of the time" />
        <span>Time</span>
      </div>
      {children}
      {shown && column ? (
        <div className="dt-map-range-layer" style={column}>
          <RangeBand range={shown} total={total} />
        </div>
      ) : null}
    </div>
  );
}

/** This trace's issues by span, and those of the calls' traces opened under the calls. */
function withCallIssues(
  issueBySpan: ReadonlyMap<string, IssueKind>,
  related: Related | undefined,
): ReadonlyMap<string, IssueKind> {
  const issues = Object.values(related?.call_traces ?? {}).flatMap((trace) => trace.issues);
  return new Map([
    ...issueBySpan,
    ...issues.flatMap((issue) => issue.span_ids.map((id): [string, IssueKind] => [id, issue.kind])),
  ]);
}

/** A trace with only the log records that show: its warnings and worse, or every one of them (`all`). */
export function withShownLogs(trace: Trace, all: boolean): Trace {
  return all ? trace : { ...trace, logs: trace.logs.filter((log) => isLoud(log.level)) };
}

/** How many records don't show, by the span they were logged in (the root's for those logged outside any). */
function hiddenLogsOf(trace: Trace): Map<string, number> {
  const root = rootOf(trace);
  const hidden = new Map<string, number>();
  for (const log of trace.logs.filter((each) => !isLoud(each.level))) {
    const span = log.span_id ?? root;
    hidden.set(span, (hidden.get(span) ?? 0) + 1);
  }
  return hidden;
}

function rootOf(trace: Trace): string {
  return trace.spans.find((span) => span.parent_id === null)?.id ?? "";
}

/** The tree with the records that show, and how many don't, by span: none hidden while every one shows. */
function useShownLogs(trace: Trace, related: Related | undefined, all: boolean) {
  const tree = useMemo(() => buildTree(withShownLogs(trace, all), related), [trace, related, all]);
  const hidden = useMemo(() => (all ? new Map<string, number>() : hiddenLogsOf(trace)), [trace, all]);
  return { tree, hidden };
}

/**
 * A span's info and debug records, while only warnings and worse show: how many, quietly. A click shows every
 * record (the legend's Logs chip turns on).
 */
function HiddenLogs({ count, onShow }: { count: number | undefined; onShow: () => void }) {
  if (!count) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: inside the row's button; a click here shows the records.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the legend's Logs chip is the keyboard's way.
    <span
      className="dt-map-sub dt-map-logs"
      role="button"
      tabIndex={-1}
      title="Info and debug records here; a click shows every record"
      onClick={(event) => {
        event.stopPropagation();
        onShow();
      }}
    >
      {plural(count, "log", "logs")}
    </span>
  );
}

/** The profile opened at a stretch of the trace (the range picked), where it says when its samples were taken. */
function profileOpener(
  open: (() => void) | undefined,
  trace: Trace,
  slice: Slice,
  change: (slice: Slice) => void,
): ((range: TimeRange) => void) | undefined {
  if (!open) return undefined;
  return (range) => {
    if (timed(trace.profile)) change({ ...slice, range });
    open();
  };
}

/** Each span's share of the time, and those whose own code ran long with nothing recorded inside. */
function useSpansTime(trace: Trace) {
  const categories = useMemo(() => spanCategories(trace), [trace]);
  const quiet = useMemo(() => quietSpans(trace), [trace]);
  return { categories, quiet };
}

function pickedOf(slice: Slice, trace: Trace, categories: ReadonlyMap<string, Category>): Picked {
  return { parts: new Set(slice.parts), range: slice.range, start: trace.start, categories };
}

/** The request as a call tree: what ran inside what, in order, and how long each part took. */
export function CallMap({
  trace,
  issueBySpan,
  related,
  links,
  initialSpan,
  head,
  ...wiring
}: {
  trace: Trace;
  issueBySpan: ReadonlyMap<string, IssueKind>;
  /** Above the tree, in the panel: the trace's time and its legend, which pick the rows. */
  head?: ReactNode;
  /** Opens the trace's profile, when it has one: its code rows lead there. */
  onProfile?: (() => void) | undefined;
  /** Linked traces: tasks this trace enqueued appear under their enqueue span. */
  related?: Related | undefined;
  links?: TraceLinks | undefined;
  /** A span to open with its details, as a link to it asks (a log line's span). */
  initialSpan?: string | undefined;
}) {
  // The part of the time picked: the kinds of calls and the stretch of time the rows are kept for.
  const { slice: current, change } = useHeldSlice();
  const { tree, hidden } = useShownLogs(trace, related, current.logs);
  const issues = useMemo(() => withCallIssues(issueBySpan, related), [issueBySpan, related]);
  const { selected, select, close } = useSelection(initialSpan);
  const map = useRef<HTMLDivElement>(null);
  const side = useSidePane(map);
  const rows = useScrolledToInitial(initialSpan);
  const [collapsed, toggle] = useToggleSet();
  const details = detailsOf(tree, selected, trace, links);
  const { categories, quiet } = useSpansTime(trace);
  const marks = useMemo(() => marksOf(tree, pickedOf(current, trace, categories)), [tree, current, trace, categories]);
  const inline = side ? null : details;

  return (
    <div className="dt-map" ref={map}>
      {head}
      <MapBody details={side ? details : null} onClose={close}>
        <TimedRows trace={trace} range={current.range} onRange={(range) => change({ ...current, range })}>
          <div className="dt-map-rows" ref={rows}>
            <Rows
              nodes={tree}
              depth={0}
              ctx={{
                trace,
                issueBySpan: issues,
                selected,
                onSelect: select,
                collapsed,
                onToggle: toggle,
                marks,
                details: inline,
                hiddenLogs: hidden,
                quiet,
                categories,
                slice: current,
                onProfile: profileOpener(wiring.onProfile, trace, current, change),
                onShowLogs: () => change({ ...current, logs: true }),
              }}
            />
          </div>
        </TimedRows>
      </MapBody>
    </div>
  );
}
