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
import { type Explain, QueryPlan } from "./CallTable";
import { duration, since } from "./format";
import { GraphqlCode } from "./GraphqlCode";
import { useChain } from "./hooks/useChain";
import { ChevronRightIcon, CloseIcon } from "./icons";
import { keyed } from "./keys";
import { LlmConversation, withoutMessages } from "./LlmConversation";
import { AllAttributes, LogRecordDetails } from "./LogRecordDetails";
import { withoutAnsi } from "./lib/ansi";
import { type Category, spanCategories } from "./lib/breakdown";
import { callFields, templatePlace } from "./lib/callFields";
import { callTemplate, callText, groupNoun } from "./lib/calls";
import { spanKindLabel } from "./lib/handler";
import { widthOf } from "./lib/percent";
import { plural } from "./lib/plural";
import { ownHotspots, type Profile } from "./lib/profile";
import { type Quiet, quietSpans } from "./lib/quiet";
import { traceRuntime } from "./lib/runtime";
import { type SpanScope, shifted } from "./lib/scope";
import { isReceiver, raised } from "./lib/signals";
import { isLoud, overlaps, type Slice, type TimeRange } from "./lib/slice";
import { CALL_KINDS, DATASTORES, MESSAGING, RPC } from "./lib/systems";
import { type Piece, quietPieces, timed, waitName, waitPlace } from "./lib/waiting";
import { type TraceLinks, traceLinkProps } from "./links";
import { MigrationNotes } from "./Migrations";
import { type NameValue, NameValues, RowsLookContext } from "./NameValues";
import { profileOver, RowFlame } from "./ProfileHint";
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
  Times,
} from "./primitives";
import { isRequestDetail, RequestParts, requestParts } from "./RequestParts";
import { RunChips } from "./RunChips";
import { SideResize, useSideWidth } from "./SideResize";
import { SignalNotes } from "./SignalNotes";
import { SqlCode } from "./SqlCode";
import { TemplateContext, withoutContext } from "./TemplateContext";
import { RangeBand, useHeldSlice, useRangeDrag } from "./TimeSlice";
import type { Attrs, IssueKind, Log, Related, Span, Trace, TraceError, TraceSummary } from "./types";

/* ---------- tree ---------- */

type Node =
  | { type: "span"; key: string; span: Span; children: Node[] }
  // Repeats of one call; `members` are their rows, each with what is under it (the trace another app served for it).
  | { type: "group"; key: string; spans: Span[]; members: SpanNode[]; start: number; end: number }
  | { type: "log"; key: string; log: Log }
  | { type: "error"; key: string; error: TraceError }
  // A trace of its own under a span of this one: a task it enqueued, run in a worker (or still waiting for one), or
  // the trace another app served for one of its calls (`kind: "call"`), with that trace's own rows when it came whole.
  // A call's trace is `level` traces down the chain from this one (1: this trace's own call); `opened` is whether its
  // rows show until its fold is clicked.
  | {
      type: "task";
      key: string;
      run: TraceSummary;
      kind: "task" | "call";
      remote?: Remote | undefined;
      whole?: Trace | undefined;
      children: Node[];
      level: number;
      opened: boolean;
      clock?: Clock | undefined;
    }
  | { type: "waiting"; key: string; span: Span; kind: "task" };

type SpanNode = Extract<Node, { type: "span" }>;

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

function isLeafCall(node: Node): node is SpanNode {
  if (node.type !== "span") return false;
  if (node.span.kind === "signal") return node.children.every(isQuietReceiver);
  return CALL_KINDS.has(node.span.kind) && node.children.every((child) => isBackendCall(child) || isServed(child));
}

/**
 * The trace another app served for a call: a call's repeats still group (an N+1 across apps), each with its own, as
 * long as each has one: a call served with ones that weren't stays a row of its own.
 */
function isServed(node: Node): boolean {
  return node.type === "task" && node.kind === "call";
}

/** What a leaf call groups by: its kind and template, and whether another app's trace is under it. */
function groupName(node: SpanNode): string {
  return `${node.span.kind}:${callTemplate(node.span)}:${node.children.some(isServed) ? "served" : ""}`;
}

/** A receiver that ran and did nothing the tree shows: its send folds with its likes. One that failed stays a row. */
function isQuietReceiver(node: Node): boolean {
  return (
    node.type === "span" && node.span.kind === "function" && node.span.status !== "error" && node.children.length === 0
  );
}

/**
 * A cache call's own Redis commands, a storage call's own HTTP requests (S3), don't stop it from grouping with its
 * likes: they are how it was served.
 */
function isBackendCall(node: Node): boolean {
  return node.type === "span" && BACKEND_KINDS.has(node.span.kind) && node.children.length === 0;
}

const BACKEND_KINDS = new Set(["redis", "http.client"]);

/**
 * A GraphQL field's resolver (`Book.author`): one per item of a list, each with the calls it made under it. Its
 * repeats group as a call's do (×36 for 36 books), each still opening on what it did.
 */
function isResolver(node: Node): node is SpanNode {
  return node.type === "span" && node.span.kind === "function" && typeof node.span.attrs["graphql.field"] === "string";
}

/** What a row groups by with its siblings, if it groups at all. */
function groupKey(node: Node): string | undefined {
  if (isResolver(node)) return `resolver:${String(node.span.attrs["graphql.field"])}`;
  return isLeafCall(node) ? groupName(node) : undefined;
}

function collapse(nodes: Node[]): Node[] {
  const byName = new Map<string, SpanNode[]>();
  for (const node of nodes) {
    const name = groupKey(node);
    if (name !== undefined) byName.set(name, [...(byName.get(name) ?? []), node as SpanNode]);
  }
  const result: Node[] = [];
  const emitted = new Set<string>();
  for (const node of nodes) {
    const name = groupKey(node);
    const members = name === undefined ? [] : (byName.get(name) ?? []);
    if (name === undefined || node.type !== "span" || members.length < GROUP_MIN) {
      result.push(node);
      continue;
    }
    if (emitted.has(name)) continue;
    emitted.add(name);
    const spans = members.map((member) => member.span);
    result.push({
      type: "group",
      key: `group:${node.span.id}`,
      spans,
      members,
      start: Math.min(...spans.map((span) => span.start)),
      end: Math.max(...spans.map((span) => span.start + span.duration)),
    });
  }
  return result;
}

/** Another project's trace on this machine, and where its console is: it opens there. */
interface Remote {
  console: string;
  project: string;
}

/**
 * Where a tree is in the chain of calls it opens: the trace on screen is `level` 0, the traces its calls reached 1,
 * theirs 2. `relatedOf` gives the links of a call's trace once they are loaded (the next level then opens under its
 * calls); `seen` the traces above, so a loop in the links can't open forever.
 */
interface Chain {
  level: number;
  relatedOf: (traceId: string) => Related | undefined;
  seen: ReadonlySet<string>;
}

const NO_CHAIN: Chain = { level: 0, relatedOf: () => undefined, seen: new Set() };

/**
 * The most traces down the chain the tree opens (the browser's view, the BFF, the service, ...): deeper calls are
 * rows that open their trace.
 */
const CHAIN_LEVELS = 6;

/**
 * Below the first level a call's trace opens by itself only when it is one of a few: an N+1 of calls (36 to one
 * service) stays folded, each a click away.
 */
const CHAIN_OPEN_MAX = 3;

function callsOf(related: Related): number {
  return related.calls.length + (related.remote_calls?.length ?? 0);
}

/**
 * How another app's trace for a call sits on this trace's clock: `shift` (µs) moved it there. Each app times its
 * spans by its own clock, and two clocks (or two SDKs' timers) disagree by a little, often more than the way there
 * and back takes: the served request started before the call, or ended after it. It is drawn centred in the call,
 * the call's time not spent serving it (the way there and back) split before and after; one longer than the call
 * starts with it, and no bar of it runs past the call's end. Times in the time column stay as measured.
 */
interface Clock {
  call: Span;
  shift: number;
}

/** How far a call's trace moves to sit centred in the call. */
function shiftInto(run: { start: number; duration: number }, call: Span): number {
  return call.start + Math.max(call.duration - run.duration, 0) / 2 - run.start;
}

/** From this shift (µs) on, a call's time says its app's clock differs from this one's. */
const SKEW_NOTE_MIN = 1_000;

/** A call's trace, its summary and its whole trace when it came whole, moved onto its call's clock. */
function onClock(served: TraceSummary, stored: Trace | undefined, call: Span | undefined) {
  if (!call) return { run: served, whole: stored, clock: undefined };
  const shift = Math.round(shiftInto(served, call));
  const run = { ...served, start: served.start + shift };
  return { run, whole: stored && shifted(stored, shift), clock: { call, shift } };
}

/**
 * A call's trace as a row of this tree, with that trace's own rows under it when it came whole, on this trace's
 * clock (see Clock).
 */
function callNode(
  key: string,
  served: TraceSummary,
  related: Related,
  chain: Chain,
  call: Span | undefined,
  remote?: Remote,
): Node {
  const { run, whole, clock } = onClock(served, related.call_traces?.[served.id], call);
  const level = chain.level + 1;
  const children = whole && !chain.seen.has(whole.id) ? servedRows(whole, chain, Boolean(remote)) : [];
  const opened = level === 1 || callsOf(related) <= CHAIN_OPEN_MAX;
  return { type: "task", key, run, kind: "call", remote, whole, children, level, opened, clock };
}

/**
 * What the other app did for the call: its request's rows, the request itself being the call's row; under its own
 * calls, the traces they reached in turn, once their links are loaded (another project's trace has none here).
 */
function servedRows(whole: Trace, chain: Chain, remote: boolean): Node[] {
  const level = chain.level + 1;
  const related = remote || level >= CHAIN_LEVELS ? undefined : chain.relatedOf(whole.id);
  const next = { ...chain, level, seen: new Set([...chain.seen, whole.id]) };
  return buildTree(whole, related, next).flatMap((node) =>
    node.type === "span" && node.span.parent_id === null ? node.children : [node],
  );
}

/** The traces other projects' agents have for this trace's calls, under the calls. */
function remoteNodes(related: Related, chain: Chain, spans: SpanById): [string, Node][] {
  return (related.remote_calls ?? []).map(({ span_id, trace, console, project }): [string, Node] => [
    span_id,
    callNode(`remote:${trace.id}`, trace, related, chain, spans.get(span_id), { console, project }),
  ]);
}

type SpanById = ReadonlyMap<string, Span>;

/** Each trace of its own under a span of this one, by that span's id. */
function linked(
  runs: readonly TraceSummary[],
  related: Related,
  kind: "task" | "call",
  chain: Chain,
  spans: SpanById,
): [string, Node][] {
  return runs.flatMap((run): [string, Node][] => {
    const span = related.via[run.id];
    if (!span) return [];
    const node =
      kind === "call" ? callNode(`call:${run.id}`, run, related, chain, spans.get(span)) : taskNode(run, chain);
    return [[span, node]];
  });
}

function taskNode(run: TraceSummary, chain: Chain): Node {
  return { type: "task", key: `task:${run.id}`, run, kind: "task", children: [], level: chain.level + 1, opened: true };
}

/**
 * Tasks under the span that enqueued them (an enqueue with no run yet is waiting for a worker), and the traces other
 * apps served under the call that reached them.
 */
function linkedNodes(trace: Trace, related: Related | undefined, chain: Chain): [string, Node][] {
  if (!related) return [];
  const spans = new Map(trace.spans.map((span) => [span.id, span]));
  const tasks = linked(related.enqueued, related, "task", chain, spans);
  const run = new Set(tasks.map(([span]) => span));
  const waiting = trace.spans
    .filter((span) => span.kind === "task.enqueue" && !run.has(span.id))
    .map((span): [string, Node] => [span.id, { type: "waiting", key: `waiting:${span.id}`, span, kind: "task" }]);
  const calls = linked(related.calls, related, "call", chain, spans);
  return [...tasks, ...calls, ...remoteNodes(related, chain, spans), ...waiting];
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

export function buildTree(trace: Trace, related: Related | undefined, chain: Chain = NO_CHAIN): Node[] {
  const children = new Map<string | null, Node[]>();
  const push = (parent: string | null, node: Node) => children.set(parent, [...(children.get(parent) ?? []), node]);
  const parentOf = parentFinder(trace);
  for (const span of trace.spans) push(parentOf(span), { type: "span", key: span.id, span, children: [] });
  for (const [parent, node] of linkedNodes(trace, related, chain)) push(parent, node);
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
  { id: "sql", label: "SQL", kinds: ["sql", "sql.connect"] },
  { id: "redis", label: "Redis", kinds: ["redis"] },
  { id: "cache", label: "Cache", kinds: ["cache"] },
  { id: "datastore", label: "Datastores", kinds: [...DATASTORES] },
  { id: "messaging", label: "Messaging", kinds: [...MESSAGING] },
  { id: "http", label: "HTTP calls", kinds: ["http.client"] },
  { id: "rpc", label: "RPC", kinds: [...RPC] },
  { id: "storage", label: "Storage", kinds: ["storage"] },
  { id: "llm", label: "LLM", kinds: ["llm"] },
  { id: "migration", label: "Migrations", kinds: ["migration", "migration.operation"] },
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
  storage: "storage",
  llm: "llm",
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
  /** Whose code the code rows under are: this trace's, or a call's trace opened under its call. */
  code: CodeOwner;
  categories: ReadonlyMap<string, Category>;
  /** What is picked: a code row shows with its share picked, or a range it overlaps. */
  slice: Slice;
  /**
   * Opens another trace's profile (a call's trace from another app, by its id), at a stretch of it where given: its
   * row's flame and its code rows lead there. None where the host can't open one.
   */
  onTraceProfile: TraceProfileOpener | undefined;
  /** Loads the links of a call's trace opened in the tree: the calls it made in turn open under it. */
  onChain: (traceId: string) => void;
  /** The stretch of the span rows are under, which no bar of theirs is drawn past (and see Clock). */
  within?: Within | undefined;
}

type Within = readonly [number, number];

/** Opens a trace's profile by its id, at a stretch of it (µs since it started) where given. */
export type TraceProfileOpener = (traceId: string, range?: TimeRange) => void;

/**
 * The trace whose own code the code rows under a row are: this one's, or a call's trace from another app opened under
 * its call (on this trace's clock), with its own profile. `quiet`: its spans whose own code ran long with nothing
 * recorded inside (as the strip says them); `onProfile` opens its profile at a stretch, when it has one.
 */
interface CodeOwner {
  trace: Trace;
  quiet: ReadonlyMap<string, Quiet>;
  onProfile: ((range: TimeRange) => void) | undefined;
}

/** A call's trace as the owner of the code rows under it: its own quiet spans, its own profile. */
function ownerFor(whole: Trace, open: TraceProfileOpener | undefined): CodeOwner {
  const onProfile = open && whole.profile ? (range: TimeRange) => open(whole.id, range) : undefined;
  return { trace: whole, quiet: quietSpans(whole), onProfile };
}

/** The stretch of a call, inside the one rows are already kept in. */
function narrowed(within: Within | undefined, call: Span): Within {
  const [from, to] = [call.start, call.start + call.duration];
  if (!within) return [from, to];
  const start = Math.min(Math.max(from, within[0]), within[1]);
  return [start, Math.max(Math.min(to, within[1]), start)];
}

/** A bar's start and length cut to the stretch it is kept in. */
function clipped(start: number, length: number, within: Within | undefined): [number, number] {
  if (!within) return [start, length];
  const from = Math.min(Math.max(start, within[0]), within[1]);
  const to = Math.min(Math.max(start + length, within[0]), within[1]);
  return [from, to - from];
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

function Bar({
  trace,
  start,
  length,
  point,
  within,
}: {
  trace: Trace;
  start: number;
  length: number;
  point?: boolean;
  within?: Within | undefined;
}) {
  const [from, long] = clipped(start, length, within);
  const place = point ? pointPlace(trace, from) : barPlace(trace, from, long);
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
  timeTitle?: string | undefined;
}

/** A task's run in a worker, or the trace another app served for a call. */
function runView(node: Extract<Node, { type: "task" }>, trace: Trace, within: Within | undefined): LinkedView {
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
    track: <Bar trace={trace} start={node.run.start} length={node.run.duration} within={within} />,
    time: duration(node.run.duration),
    timeTitle: clockNote(node),
  };
}

/** What moving a call's trace onto this clock did, said on its time, when it did more than round off a little. */
function clockNote(node: Extract<Node, { type: "task" }>): string | undefined {
  const { clock, run } = node;
  if (!clock) return undefined;
  const call = duration(clock.call.duration);
  if (run.duration > clock.call.duration) {
    const more = duration(run.duration - clock.call.duration);
    return `Served in ${duration(run.duration)} by its app's clock, ${more} more than the ${call} call took by this one's: the two disagree. Drawn inside the call.`;
  }
  if (Math.abs(clock.shift) < SKEW_NOTE_MIN) return undefined;
  const side = clock.shift < 0 ? "ahead of" : "behind";
  const away = duration(clock.call.duration - run.duration);
  return `Its app's clock is ${duration(Math.abs(clock.shift))} ${side} this one's: drawn centred in the ${call} call, the ${away} not spent serving it split before and after.`;
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
  // Open from the start (what the other app did is why it is here), but for one of many deeper down the chain: a
  // click on the fold turns it the other way.
  const open =
    children.length > 0 ? dim || (node.type === "waiting" || node.opened) !== ctx.collapsed.has(node.key) : undefined;
  useChainLoad(node, open, ctx.onChain);
  const inner = useLinkedContext(node, ctx);
  const root = node.type === "task" ? node.whole?.spans.find((span) => span.parent_id === null) : undefined;
  return (
    <div>
      <LinkedButton node={node} ctx={inner} indent={indent} dim={dim} open={open} />
      <RowDetails id={node.key} ctx={ctx} />
      {open ? (
        <>
          <Rows nodes={children} depth={depth + 1} ctx={inner} />
          {/* Its request's own code, as a span's is under its rows: the request is this row. */}
          {root ? <CodeRow span={root} ctx={inner} depth={depth + 1} /> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * What the rows of a call's trace are drawn with: no bar past the call's end (see Clock), and that trace's own code
 * and profile for their code rows.
 */
function useLinkedContext(node: Linked, ctx: RowContext): RowContext {
  const call = node.type === "task" ? node.clock?.call : undefined;
  const whole = node.type === "task" && !node.remote ? node.whole : undefined;
  const open = ctx.onTraceProfile;
  const code = useMemo(() => (whole ? ownerFor(whole, open) : undefined), [whole, open]);
  return {
    ...ctx,
    ...(call ? { within: narrowed(ctx.within, call) } : {}),
    ...(code ? { code } : {}),
  };
}

/** A call's trace whose own calls can open under it: this agent's, not too far down the chain. */
function chainedTrace(node: Linked): string | undefined {
  if (node.type !== "task" || node.remote || node.level >= CHAIN_LEVELS) return undefined;
  return node.whole?.id;
}

/** While a call's trace is open, the links of its own calls load: the traces they reached open under them. */
function useChainLoad(node: Linked, open: boolean | undefined, onChain: (traceId: string) => void): void {
  const whole = chainedTrace(node);
  useEffect(() => {
    if (open && whole) onChain(whole);
  }, [open, whole, onChain]);
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
  const view = linkedView(node, ctx.trace, ctx.within);
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
        <LinkedFlame node={node} ctx={ctx} />
      </span>
      {view.track}
      <span className="dt-map-time" title={view.timeTitle}>
        {view.time}
      </span>
    </button>
  );
}

/** A call's trace with a profile: its flame, as a code row's, and a click on it opens that trace's profile. */
function LinkedFlame({ node, ctx }: { node: Linked; ctx: RowContext }) {
  const whole = node.type === "task" ? node.whole : undefined;
  if (!whole?.profile) return null;
  const open = ctx.onTraceProfile;
  return <RowFlame trace={whole} onOpen={open && !hasRemote(node) ? () => open(whole.id) : undefined} />;
}

function hasRemote(node: Linked): boolean {
  return node.type === "task" && node.remote !== undefined;
}

function linkedView(node: Linked, trace: Trace, within: Within | undefined): LinkedView {
  return node.type === "task" ? runView(node, trace, within) : waitingView(node, trace);
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
        const place = { ctx, indent: indentOf(depth), depth, mark, parent };
        return <Row key={node.key} node={node} place={place} />;
      })}
    </>
  );
}

/** How far in a row's name starts, and how many guides of the rows it hangs under it draws (styles.css). */
function indentOf(depth: number): CSSProperties {
  return { paddingLeft: `${12 + depth * 16}px`, "--dt-depth": depth } as CSSProperties;
}

/**
 * How slow a call reads beside its time, as the trace's share it took: amber from a fifth, red from a half. The
 * request's own code (its view, its framework) takes most of it by nature: only calls to a system say it.
 */
function slowness(time: number, trace: Trace, category: Category | undefined): "warn" | "error" | undefined {
  if (category === undefined || OWN_TIME.has(category)) return undefined;
  const share = time / Math.max(trace.duration, 1);
  if (share >= 0.5) return "error";
  return share >= 0.2 ? "warn" : undefined;
}

const OWN_TIME: ReadonlySet<Category> = new Set(["django", "code", "template", "signal"]);

/** A row's time, tabular, in amber or red when the call took much of the trace. */
function RowTime({
  time,
  slow,
  title,
}: {
  time: number;
  slow: "warn" | "error" | undefined;
  title?: string | undefined;
}) {
  return (
    <span className="dt-map-time" data-slow={slow} title={title}>
      {duration(time)}
    </span>
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

/** A call's database, cache or storage alias, when it has one. */
function aliasOf(span: Span | undefined): unknown {
  return span?.attrs["db.alias"] ?? span?.attrs["cache.alias"] ?? span?.attrs["storage.alias"];
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
  return { kind: "log", level: node.log.level, time: node.log.time, text: withoutAnsi(node.log.message) };
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
        <Bar trace={ctx.trace} start={view.time} length={0} point={true} within={ctx.within} />
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
  // A resolver's issue is the call it repeats, right under it (Book.author's GET /authors/{id}).
  const spans = [...node.spans, ...node.members.flatMap(childSpans)];
  const issue = spans.map((span) => ctx.issueBySpan.get(span.id)).find(Boolean);
  const first = node.spans[0];
  return (
    <>
      <KindBadge kind={spanKindLabel(first?.kind, ctx.trace.attrs)} muted={true} className="dt-map-kind" />
      <OpText text={callTemplate(first)} kind={first?.kind} />
      <AliasChip value={aliasOf(first)} />
      <FromTemplate span={first} parent={parent} />
      <Times count={node.spans.length} />
      {issue ? <IssueChip kind={issue} className={ISSUE_CHIP_SHRINKS} /> : null}
    </>
  );
}

/** Repeats of one call folded into one row (×N), its calls as ticks on the timeline; open, each call a row. */
function GroupRow({ node, place: { ctx, indent, depth, mark, parent } }: RowProps<"group">) {
  const open = ctx.collapsed.has(`open:${node.key}`);
  const wall = node.end - node.start;
  return (
    <div className="dt-map-group">
      <button
        type="button"
        className="dt-map-row"
        {...rowState(ctx, node.key, mark)}
        data-kind={node.spans[0]?.kind}
        data-category={ctx.categories.get(node.spans[0]?.id ?? "")}
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
        <GroupTicks spans={node.spans} trace={ctx.trace} within={ctx.within} />
        <RowTime
          time={wall}
          slow={slowness(wall, ctx.trace, ctx.categories.get(node.spans[0]?.id ?? ""))}
          title={groupTimes(node)}
        />
      </button>
      <RowDetails id={node.key} ctx={ctx} />
      {open ? <Rows nodes={node.members} depth={depth + 1} ctx={{ ...ctx, marks: undefined }} parent={parent} /> : null}
    </div>
  );
}

/**
 * A group's time: from its first call's start to its last one's end, as long as the request waited for them (36
 * calls run side by side take about one call's time); what they took added up is the second figure.
 */
function groupTimes(node: Extract<Node, { type: "group" }>): string {
  const total = node.spans.reduce((sum, span) => sum + span.duration, 0);
  const noun = groupNoun(node.spans[0], node.spans.length);
  return `${node.spans.length} ${noun} · ${duration(total)} total, ${duration(node.end - node.start)} from the first's start to the last's end`;
}

/** Where each call of a group started, on the request's timeline. */
function GroupTicks({ spans, trace, within }: { spans: readonly Span[]; trace: Trace; within: Within | undefined }) {
  return (
    <span className="dt-map-track" aria-hidden="true">
      {spans.map((span) => {
        const [at] = clipped(span.start, 0, within);
        const left = Math.min(Math.max(((at - trace.start) / Math.max(trace.duration, 1)) * 100, 0), 100);
        return <span key={span.id} className="dt-map-bar" data-tick="" style={{ left: `${left}%` }} />;
      })}
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
  return <OpText text={callText(span)} kind={span.kind} />;
}

// What a call does, then what to: SELECT shop_product, GET api.example.com/users, SET session:*.
const OP = /^([A-Z][A-Z_]+)( .*)$/;

/**
 * A call's text, its operation set apart: a statement's verb or a command a little stronger than what it acts on,
 * an HTTP call's method in its colour as every list shows one.
 */
function OpText({ text, kind }: { text: string; kind: string | undefined }) {
  const op = OP.exec(text);
  if (!op) return <span className="dt-map-text">{text}</span>;
  return (
    <span className="dt-map-text">
      <span className="dt-map-op" data-method={kind === "http.client" ? op[1] : undefined}>
        {op[1]}
      </span>
      {op[2]}
    </span>
  );
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
        data-category={ctx.categories.get(span.id)}
        data-root={span.parent_id === null ? "" : undefined}
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
          <MigrationNotes span={span} />
          <HiddenLogs count={ctx.hiddenLogs.get(span.id)} onShow={ctx.onShowLogs} />
          {issue ? <IssueChip kind={issue} className={ISSUE_CHIP_SHRINKS} /> : null}
        </span>
        <Bar trace={ctx.trace} start={span.start} length={span.duration} within={ctx.within} />
        <RowTime
          time={span.duration}
          slow={span.parent_id === null ? undefined : slowness(span.duration, ctx.trace, ctx.categories.get(span.id))}
          title={timeTitle(span, ctx.trace)}
        />
      </button>
      <RowDetails id={node.key} ctx={ctx} />
      {fold ? (
        <>
          {/* A child's bar never runs past its parent's: an SDK timing starts to the millisecond and durations to
              the microsecond puts a call that ends with its caller a little past it. */}
          <Rows
            nodes={node.children}
            depth={depth + 1}
            ctx={{ ...ctx, within: narrowed(ctx.within, span) }}
            parent={span}
          />
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
  const parts = [true, false].flatMap((waiting): CodePart[] => {
    const own = pieces.filter((piece) => piece.waiting === waiting);
    const total = own.reduce((sum, piece) => sum + piece.to - piece.from, 0);
    return total > 0 ? [{ waiting, pieces: own, total }] : [];
  });
  return parts.every((part) => partShows(part, quiet, trace)) ? parts : [oneOf(parts, pieces, quiet)];
}

/** A wait or a stretch of code on a row of its own: as long as the code's own time is said at all, of the time. */
const PART_MIN_US = 5_000;
const PART_MIN_SHARE = 0.2;
const PART_MIN_TRACE_SHARE = 0.05;

/**
 * Whether a part of a span's own time stands on its own: at least 5 ms, and a fifth of that time or a twentieth of
 * the trace's. A few ms of framework glue beside a long wait is part of the wait, not a row of its own.
 */
function partShows(part: CodePart, quiet: Quiet, trace: Trace): boolean {
  if (part.total < PART_MIN_US) return false;
  return part.total >= quiet.total * PART_MIN_SHARE || part.total >= trace.duration * PART_MIN_TRACE_SHARE;
}

/** The parts as one row: what most of it was (waited or computed), all of its time, every piece on its bar. */
function oneOf(parts: readonly CodePart[], pieces: Piece[], quiet: Quiet): CodePart {
  const most = [...parts].sort((a, b) => b.total - a.total)[0];
  return { waiting: most?.waiting ?? false, pieces, total: quiet.total };
}

/** The stretch a part spans, from its first piece to its last. */
function partRange(part: CodePart): TimeRange {
  const first = part.pieces[0] as Piece;
  const last = part.pieces.at(-1) as Piece;
  return [first.from, last.to];
}

/** Where its code ran with nothing recorded inside, hatched in its share's colour; pieces too thin to see left out. */
function CodeBars({
  part,
  category,
  trace,
  owner,
}: {
  part: CodePart;
  category: Category;
  trace: Trace;
  owner: Trace;
}) {
  const total = Math.max(trace.duration, 1);
  // A call's trace's pieces are of its own time: on this trace's from where it starts on this one's clock.
  const offset = owner.start - trace.start;
  return (
    <span className="dt-map-track" aria-hidden="true">
      {part.pieces
        .filter((piece) => piece.to - piece.from >= total * 0.004)
        .map((piece) => (
          <span
            key={piece.from}
            className="dt-map-bar"
            data-quiet=""
            data-waiting={piece.waiting ? "" : undefined}
            data-category={category}
            style={{ left: widthOf(piece.from + offset, total), width: widthOf(piece.to - piece.from, total) }}
          />
        ))}
    </span>
  );
}

/**
 * What a code row is: with a profile, the functions of yours that ran most in that stretch (or what it waited on);
 * without one, untraced code, waiting where the profile can't say.
 */
function partName(part: CodePart, trace: Trace): { name: string; yours: boolean } {
  const profile = profileOver(trace, partRange(part));
  if (part.waiting) return waited(profile);
  const name = profile ? ranMost(profile) : UNTRACED;
  return { name, yours: name !== UNTRACED };
}

const UNTRACED = "untraced code";

/** Where a wait row waited, said quietly after its name: "handlers.py:108", where the profile says. */
function WaitPlace({ part, trace }: { part: CodePart; trace: Trace }) {
  const profile = profileOver(trace, partRange(part));
  const place = part.waiting && profile ? waitPlace(profile) : null;
  return place ? <span className="dt-map-sub">{place}</span> : null;
}

/**
 * "asyncio.sleep in send_digest": what the code waited on, or just waiting where the profile can't say; yours when
 * a function of yours waited.
 */
function waited(profile: Profile | undefined): { name: string; yours: boolean } {
  const wait = profile ? waitName(profile) : null;
  return wait ?? { name: "waiting", yours: false };
}

/** "aggregate · render_csv": the two functions of yours that ran most, or untraced code where none of yours ran. */
function ranMost(profile: Profile): string {
  const names = ownHotspots(profile, 2).map((hotspot) => hotspot.name);
  return names.join(" · ") || UNTRACED;
}

/** A code row's own: a grey box ("code", or "wait"), its name, the way on to the profile, its bars and its time. */
function CodeRowParts({ span, ctx, depth, part }: { span: Span; ctx: RowContext; depth: number; part: CodePart }) {
  const category = ctx.categories.get(span.id) ?? "code";
  const owner = ctx.code.trace;
  const { name, yours } = partName(part, owner);
  return (
    <>
      <span className="dt-map-name" style={indentOf(depth)}>
        <span className="dt-map-caret" />
        <KindBadge
          kind={part.waiting ? "wait" : "code"}
          muted={true}
          className={part.waiting ? "dt-map-kind dt-map-wait" : "dt-map-kind"}
        />
        <TaskName name={name} className={yours ? "dt-map-text" : "dt-map-text dt-map-lib"} />
        <WaitPlace part={part} trace={owner} />
        <RowFlame trace={owner} />
      </span>
      <CodeBars part={part} category={category} trace={ctx.trace} owner={owner} />
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
  const parts = codeParts(ctx.code.quiet.get(span.id) as Quiet, ctx.code.trace);
  return (
    <>
      {parts.map((part) => (
        <CodePartRow key={String(part.waiting)} span={span} ctx={ctx} depth={depth} part={part} />
      ))}
    </>
  );
}

function CodePartRow({ span, ctx, depth, part }: { span: Span; ctx: RowContext; depth: number; part: CodePart }) {
  const inside = <CodeRowParts span={span} ctx={ctx} depth={depth} part={part} />;
  const open = ctx.code.onProfile;
  // With a profile, a click opens it at that stretch; without, a plain row.
  return open ? (
    <button
      type="button"
      className="dt-map-row"
      data-kind="code"
      data-category={codeCategory(span, ctx)}
      onClick={() => open(partRange(part))}
    >
      {inside}
    </button>
  ) : (
    <div className="dt-map-row" data-kind="code" data-category={codeCategory(span, ctx)}>
      {inside}
    </div>
  );
}

/** A code row's share: its span's, or your code's. */
function codeCategory(span: Span, ctx: RowContext): Category {
  return ctx.categories.get(span.id) ?? "code";
}

/** Whether a span has a code row: its code ran long with nothing recorded inside, and what is picked keeps it. */
function hasCodeRow(span: Span, ctx: RowContext): boolean {
  const quiet = ctx.code.quiet.get(span.id);
  return quiet !== undefined && codeShown(quiet, ctx.categories.get(span.id) ?? "code", ctx);
}

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
  if (node.type === "group") return findNode(node.members, key, trace);
  return findNode(childrenOf(node), key, ownerOf(node, trace));
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
  profile,
}: {
  run: TraceSummary;
  kind: "task" | "call";
  trace: Trace;
  links?: TraceLinks | undefined;
  remote?: Remote | undefined;
  /** Opens its profile, when it has one. */
  profile?: (() => void) | undefined;
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
      {profile ? (
        <button type="button" className="dt-map-open" onClick={profile}>
          Open its profile →
        </button>
      ) : null}
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

function LinkedDetails({
  node,
  trace,
  links,
  onTraceProfile,
}: {
  node: Linked;
  trace: Trace;
  links?: TraceLinks | undefined;
  onTraceProfile?: TraceProfileOpener | undefined;
}) {
  if (node.type === "waiting") return <WaitingDetails span={node.span} />;
  const whole = node.remote ? undefined : node.whole;
  const profile = whole?.profile && onTraceProfile ? () => onTraceProfile(whole.id) : undefined;
  return (
    <RunDetails run={node.run} kind={node.kind} trace={trace} links={links} remote={node.remote} profile={profile} />
  );
}

type DetailsProps<T extends Node["type"]> = {
  node: Extract<Node, { type: T }>;
  trace: Trace;
  links?: TraceLinks | undefined;
  /** EXPLAIN for a query of the trace shown, as its DB tab runs it; none for a linked trace's queries. */
  onExplain?: Explain | undefined;
  /** Opens a call's trace's profile, from its details. */
  onTraceProfile?: TraceProfileOpener | undefined;
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

function GroupDetails({ node, onExplain }: DetailsProps<"group">) {
  const [first] = node.spans;
  const origins = new Set(node.spans.map((span) => String(span.attrs["code.origin"] ?? "")));
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">
        {node.spans.length} similar {groupNoun(first)} · took {duration(node.end - node.start)} ·{" "}
        {duration(node.spans.reduce((sum, span) => sum + span.duration, 0))} total
      </p>
      {first ? (
        <>
          <Statement span={first} attrs={first.attrs} />
          <Fields rows={summaryRows(first, false)} />
          <QueryPlan span={first} onExplain={onExplain} />
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
function CallDetails({ node: { span }, trace, onExplain }: DetailsProps<"span">) {
  const parent = trace.spans.find((each) => each.id === span.parent_id);
  const summary = summaryRows(span, true, parent);
  return (
    <div className="grid gap-3 p-4">
      <SpanHead span={span} trace={trace} parent={parent} attrs={span.attrs} />
      {summary.length ? <Fields rows={summary} /> : null}
      <QueryPlan span={span} onExplain={onExplain} />
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

/** Every attribute of a span; a template's context or an LLM call's conversation first, as rows of their own. */
function SpanAttributes({ span, attrs, titled }: { span: Span; attrs: Attrs; titled: boolean }) {
  const template = span.kind === "template";
  const llm = span.kind === "llm";
  return (
    <>
      {template ? <TemplateContext attrs={attrs} /> : null}
      {llm ? <LlmConversation attrs={attrs} /> : null}
      <AllAttributes attrs={withoutMessages(withoutContext(attrs))} titled={titled || template || llm} />
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

/**
 * The pane's height: from where it is now to the view's bottom. It sticks under the tabs only once the view scrolled
 * it there; before, the tree's head (the time strip, the filters) sits above it, and a pane as tall as the view under
 * the tabs ran that far past the view's bottom. Its own scrolling stops at its edge (a wheel over it never scrolls the
 * view), so its last rows were out of reach.
 */
function fitPane(pane: HTMLElement, map: HTMLElement): void {
  const view = scrollParent(map);
  const viewTop = view ? view.getBoundingClientRect().top + view.clientTop : 0;
  const viewHeight = view?.clientHeight ?? window.innerHeight;
  const at = Math.max(stickyTop(map), pane.getBoundingClientRect().top - viewTop);
  pane.style.maxHeight = `${Math.max(0, viewHeight - at)}px`;
}

/** The view, the tree and the tabs over it, each when it resizes; the view (or the window) as it scrolls. */
function watchView(map: HTMLElement, fit: () => void): () => void {
  const observer = new ResizeObserver(fit);
  observer.observe(map);
  const view = scrollParent(map);
  if (view) observer.observe(view);
  const sticky = map.closest(".dt-trace")?.querySelector<HTMLElement>(".dt-trace-strip, .dt-tabs");
  if (sticky) observer.observe(sticky);
  let frame = 0;
  const scrolled = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fit);
  };
  const scroller: HTMLElement | Window = view ?? window;
  scroller.addEventListener("scroll", scrolled, { passive: true });
  // With no scrolling parent the window is the view.
  window.addEventListener("resize", fit);
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    scroller.removeEventListener("scroll", scrolled);
    window.removeEventListener("resize", fit);
  };
}

/**
 * Whether the call tree is wide enough for the details pane beside it. The tree's height follows the view it scrolls
 * in: a panel dragged taller or shorter changes the view alone, and a height fitted to the old one stopped the line
 * between tree and pane in mid-air.
 */
function useSidePane(map: RefObject<HTMLDivElement | null>): boolean {
  const [side, setSide] = useState(false);
  useEffect(() => {
    const element = map.current;
    if (!element) return;
    return watchView(element, () => {
      setSide(element.clientWidth >= SIDE_MIN_WIDTH);
      fitSidePane(element);
    });
  }, [map]);
  return side;
}

/** Beside the tree, like the devtools' Network panel: the tree keeps its shape, the details stay in view. */
function SidePane({ children, onClose, resize }: { children: ReactNode; onClose: () => void; resize: ReactNode }) {
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = pane.current;
    const map = element?.closest<HTMLElement>(".dt-map");
    if (!(element && map)) return;
    const fit = () => fitPane(element, map);
    fit();
    return watchView(map, fit);
  }, []);
  return (
    <aside className="dt-map-side" aria-label="Details" ref={pane}>
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

/** What is under a row, as the trace's tabs take it: a span's, a group's spans', a call's trace. */
function scopeOfNode(node: Node): SpanScope | undefined {
  if (node.type === "span") return { targets: [node.span.id], label: node.span.name, only: false };
  if (node.type === "group") {
    return {
      targets: node.spans.map((span) => span.id),
      label: `${node.spans[0]?.name} ×${node.spans.length}`,
      only: false,
    };
  }
  if (node.type === "task" && node.kind === "call") {
    return { targets: [node.run.id], label: appName(node) ?? node.run.name, only: false };
  }
  return undefined;
}

function detailsOf(
  tree: Node[],
  selected: string | null,
  trace: Trace,
  hosts: {
    links: TraceLinks | undefined;
    onExplain: Explain | undefined;
    onTraceProfile: TraceProfileOpener | undefined;
    under: ((scope: SpanScope) => ReactNode) | undefined;
  },
): ReactNode {
  const found = selected ? findNode(tree, selected, trace) : undefined;
  if (!found) return null;
  // The host explains the trace's own queries: a linked trace's are its own.
  const onExplain = found.trace === trace ? hosts.onExplain : undefined;
  const scope = hosts.under && scopeOfNode(found.node);
  return (
    <>
      {scope ? hosts.under?.(scope) : null}
      <Details
        node={found.node}
        trace={found.trace}
        links={hosts.links}
        onExplain={onExplain}
        onTraceProfile={hosts.onTraceProfile}
      />
    </>
  );
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

/** This trace's issues by span, and those of the calls' traces opened under the calls, however far down the chain. */
function withCallIssues(
  issueBySpan: ReadonlyMap<string, IssueKind>,
  related: Related | undefined,
  chain: ReadonlyMap<string, Related>,
): ReadonlyMap<string, IssueKind> {
  const issues = [related, ...chain.values()]
    .flatMap((each) => Object.values(each?.call_traces ?? {}))
    .flatMap((trace) => trace.issues);
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
function useShownLogs(trace: Trace, related: Related | undefined, all: boolean, loaded: ReadonlyMap<string, Related>) {
  const tree = useMemo(() => {
    const chain: Chain = { level: 0, relatedOf: (id) => loaded.get(id), seen: new Set([trace.id]) };
    return buildTree(withShownLogs(trace, all), related, chain);
  }, [trace, related, all, loaded]);
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
  profileAt: (range: TimeRange | null) => void,
): ((range: TimeRange) => void) | undefined {
  if (!open) return undefined;
  return (range) => {
    // The Profile tab's own stretch: the call tree's range is a drag's only.
    if (timed(trace.profile)) profileAt(range);
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
  /** Opens another trace's profile by its id: a call's trace from another app, opened under its call. */
  onTraceProfile?: TraceProfileOpener | undefined;
  /** EXPLAIN for a query of this trace: a SELECT's details then have its plan, as the DB tab's. */
  onExplain?: Explain | undefined;
  /** Linked traces: tasks this trace enqueued appear under their enqueue span. */
  related?: Related | undefined;
  links?: TraceLinks | undefined;
  /** A span to open with its details, as a link to it asks (a log line's span). */
  initialSpan?: string | undefined;
  /**
   * Loads another trace's links: a call's trace opened in the tree then has the traces its own calls reached under
   * them, down the chain (the browser's view, the BFF, each service). Without it the tree opens one level.
   */
  loadRelated?: ((traceId: string) => Promise<Related>) | undefined;
  /** Over a row's details: what is under it (its records, ...), each a way to the tab that lists them. */
  under?: ((scope: SpanScope) => ReactNode) | undefined;
}) {
  // The part of the time picked: the kinds of calls and the stretch of time the rows are kept for.
  const { slice: current, change, profileAt } = useHeldSlice();
  const chain = useChain(trace.id, wiring.loadRelated, related);
  const { tree, hidden } = useShownLogs(trace, related, current.logs, chain.loaded);
  const issues = useMemo(
    () => withCallIssues(issueBySpan, related, chain.loaded),
    [issueBySpan, related, chain.loaded],
  );
  const { selected, select, close } = useSelection(initialSpan);
  const map = useRef<HTMLDivElement>(null);
  const side = useSidePane(map);
  const rows = useScrolledToInitial(initialSpan);
  const [collapsed, toggle] = useToggleSet();
  const details = detailsOf(tree, selected, trace, {
    links,
    onExplain: wiring.onExplain,
    onTraceProfile: wiring.onTraceProfile,
    under: wiring.under,
  });
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
                code: { trace, quiet, onProfile: profileOpener(wiring.onProfile, trace, profileAt) },
                categories,
                slice: current,
                onTraceProfile: wiring.onTraceProfile,
                onShowLogs: () => change({ ...current, logs: true }),
                onChain: chain.want,
              }}
            />
          </div>
        </TimedRows>
      </MapBody>
    </div>
  );
}
