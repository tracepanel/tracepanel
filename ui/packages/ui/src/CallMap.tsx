import { FlameIcon } from "lucide-react";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AsReceived } from "./AsReceived";
import { type Explain, type ExplainOf, QueryPlan } from "./CallTable";
import { DumpBadge, DumpLine } from "./Dump";
import { duration, since } from "./format";
import { GraphqlCode } from "./GraphqlCode";
import { Hint } from "./Hint";
import { useChain } from "./hooks/useChain";
import { ChevronRightIcon, CloseIcon } from "./icons";
import { keyed } from "./keys";
import { LlmConversation, withoutMessages } from "./LlmConversation";
import { AllAttributes, LogRecordDetails } from "./LogRecordDetails";
import { withoutAnsi } from "./lib/ansi";
import { type Category, spanCategories } from "./lib/breakdown";
import { answers, callAnswer, cutLength, type GroupAnswer, groupAnswer, unfinished } from "./lib/callAnswer";
import { callFields, templatePlace } from "./lib/callFields";
import { callTemplate, callText, groupNoun } from "./lib/calls";
import { isDump } from "./lib/dump";
import { spanKindLabel } from "./lib/handler";
import { foldKeys } from "./lib/keys";
import { pageParts } from "./lib/page";
import { widthOf } from "./lib/percent";
import { plural } from "./lib/plural";
import { ownHotspots, type Profile } from "./lib/profile";
import { type Quiet, quietSpans } from "./lib/quiet";
import { traceRuntime } from "./lib/runtime";
import { type SpanScope, shifted } from "./lib/scope";
import { isReceiver, raised } from "./lib/signals";
import { isShown, overlaps, type Slice, type TimeRange } from "./lib/slice";
import { CALL_KINDS, DATASTORES, MESSAGING, RPC } from "./lib/systems";
import { attrsWhere } from "./lib/values";
import {
  bucketOwners,
  ownProfile,
  type Piece,
  quietPieces,
  type Timed,
  timed,
  waitName,
  waitPlace,
} from "./lib/waiting";
import { type TraceLinks, traceLinkProps } from "./links";
import { MigrationNotes } from "./Migrations";
import { type NameValue, NameValues, RowsLookContext } from "./NameValues";
import { profileOver, RowFlame } from "./ProfileHint";
import { PropTable } from "./PropTable";
import {
  AliasChip,
  AppChip,
  GroupStatus,
  ISSUE_CHIP_SHRINKS,
  IssueChip,
  KindBadge,
  SectionHeading,
  StateBadge,
  StatusBadge,
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
  // `served`: the trace another app served for this call, merged into its row (see hopOf); its rows are then this
  // row's children, after the call's own.
  // `cut`: the call hadn't ended when its trace went out; its time is then the served trace's (see lastedFor).
  | { type: "span"; key: string; span: Span; children: Node[]; served?: ServedRun | undefined; cut?: boolean }
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

/** The trace another app served for a call (or a task's run, `kind: "task"`). */
type ServedRun = Extract<Node, { type: "task" }>;

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
  /** Every record shows (the legend's Logs chip), in the calls' traces as in this one: else warnings and worse. */
  allLogs: boolean;
}

const NO_CHAIN: Chain = { level: 0, relatedOf: () => undefined, seen: new Set(), allLogs: true };

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
  return buildTree(withShownLogs(whole, chain.allLogs), related, next).flatMap((node) =>
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
  // Merged after grouping: a call groups with its likes by the trace under it (groupName), each member merged too.
  const attach = (nodes: Node[]): Node[] =>
    collapse(
      nodes
        .map((node) => (node.type === "span" ? { ...node, children: attach(children.get(node.span.id) ?? []) } : node))
        .sort((a, b) => startOf(a) - startOf(b)),
    ).map(merged);
  return attach(children.get(null) ?? []);
}

/** A row with the calls in it that another app served merged with their traces: a group's members too. */
function merged(node: Node): Node {
  if (node.type === "group") return { ...node, members: node.members.map(hopOf) };
  return node.type === "span" ? hopOf(node) : node;
}

/**
 * A call and the trace another app served for it, one row (a hop): the call's kind, method and path, the app that
 * served it, what that trace found, the call's bar with the server's time inside it; open, that trace's rows straight
 * under it. A call with no trace served (an external API), or more than one, stays a row of its own; so does a
 * trace's own top row.
 */
function hopOf(node: SpanNode): SpanNode {
  if (node.span.parent_id === null || !HOP_KINDS.has(node.span.kind)) return node;
  const served = node.children.filter(isServed) as ServedRun[];
  const [call] = served;
  if (served.length !== 1 || !call) return node;
  const own = node.children.filter((child) => child !== call);
  const children = [...own, ...call.children].sort((a, b) => startOf(a) - startOf(b));
  return { ...node, span: lastedFor(node.span, call.run), served: call, children, cut: unfinished(node.span) };
}

/**
 * A call cut short (its trace went out before it ended, see `unfinished`) lasts at least until the trace served for
 * it ended: never 0 µs for a call whose trace took seconds.
 */
function lastedFor(span: Span, run: TraceSummary): Span {
  if (!unfinished(span)) return span;
  return { ...span, duration: Math.max(span.duration, run.start + run.duration - span.start) };
}

/** The calls that ask and wait for an answer: a message sent (a publish) is no hop, its consumer runs on its own. */
const HOP_KINDS: ReadonlySet<string> = new Set(["http.client", ...RPC]);

/** The rows under a span that are its own, not the rows of the trace served for it. */
function ownChildren(node: SpanNode): Node[] {
  const served = node.served?.children;
  return served ? node.children.filter((child) => !served.includes(child)) : node.children;
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
  profilesIn: ProfilesIn | undefined;
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
  /** Its app profiles a request when asked: untraced code then says how to see what ran. */
  profiles: boolean;
}

/** A call's trace as the owner of the code rows under it: its own quiet spans, its own profile. */
function ownerFor(whole: Trace, open: TraceProfileOpener | undefined, profilesIn: ProfilesIn | undefined): CodeOwner {
  const onProfile = open && whole.profile ? (range: TimeRange) => open(whole.id, range) : undefined;
  return { trace: whole, quiet: quietSpans(whole), onProfile, profiles: profilesIn?.(whole) === true };
}

/** Whether the app that recorded a trace profiles a request when asked. */
export type ProfilesIn = (trace: Trace) => boolean;

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
  cut,
  within,
}: {
  trace: Trace;
  start: number;
  length: number;
  point?: boolean;
  /** A call cut short (see cutLength): it fades out where it was cut, as one that runs past the end does. */
  cut?: boolean;
  within?: Within | undefined;
}) {
  const [from, long] = clipped(start, length, within);
  const place = point ? pointPlace(trace, from) : barPlace(trace, from, long);
  const past = place.past ?? (cut ? "" : undefined);
  return (
    <span className="dt-map-track" aria-hidden="true">
      <span className="dt-map-bar" data-point={point ? "" : undefined} data-past={past} style={place.style} />
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
        <RowChips>
          <RunChips trace={node.run} />
        </RowChips>
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
  return name ? <AppChip name={name} runtime={traceRuntime(node.whole?.attrs ?? {})} compact /> : null;
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
  const profilesIn = ctx.profilesIn;
  const code = useMemo(() => (whole ? ownerFor(whole, open, profilesIn) : undefined), [whole, open, profilesIn]);
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
  // A dump is a kind of its own, its badge and its line: printed to be looked at, not logged.
  if (isDump(node.log)) return { kind: "dump", level: "dump", time: node.log.time, text: "" };
  return { kind: "log", level: node.log.level, time: node.log.time, text: withoutAnsi(node.log.message) };
}

/** A leaf's badge: its level, muted, or a dump's own. */
function LeafBadge({ kind, level }: { kind: string; level: string }) {
  if (kind === "dump") return <DumpBadge className="dt-map-kind" />;
  return <KindBadge kind={level} muted={true} className="dt-map-kind" />;
}

/** A leaf's text: a dump's call site and first value, coloured; any other's message or error. */
function LeafText({ node, text }: { node: Extract<Node, { type: "log" | "error" }>; text: string }) {
  if (node.type === "log" && isDump(node.log)) return <DumpLine log={node.log} className="dt-map-text" />;
  return <span className="dt-map-text">{text}</span>;
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
          <LeafBadge kind={view.kind} level={view.level} />
          <LeafText node={node} text={view.text} />
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

/** A group's kind, its call's template, its alias, the page template that made it, how many, how they went and its issue. */
function GroupName({
  node,
  ctx,
  parent,
  answer,
}: {
  node: Extract<Node, { type: "group" }>;
  ctx: RowContext;
  parent: Span | undefined;
  answer: GroupAnswer;
}) {
  const issue = groupIssue(node, ctx.issueBySpan);
  const first = node.spans[0];
  return (
    <>
      <KindBadge kind={spanKindLabel(first?.kind, ctx.trace.attrs)} muted={true} className="dt-map-kind" />
      <OpText text={callTemplate(first)} kind={first?.kind} />
      <AliasChip value={aliasOf(first)} />
      <FromTemplate span={first} parent={parent} />
      <Times count={node.spans.length} />
      <GroupStatus answer={answer} />
      <RowChips>{issue ? <IssueChip kind={issue} className={ISSUE_CHIP_SHRINKS} /> : null}</RowChips>
    </>
  );
}

/** The calls a group's issue is on: its own, or a resolver's call it repeats, right under it (Book.author's GET /authors/{id}). */
function groupSpans(node: Extract<Node, { type: "group" }>): Span[] {
  return [...node.spans, ...node.members.flatMap(childSpans)];
}

function groupIssue(node: Extract<Node, { type: "group" }>, issueBySpan: ReadonlyMap<string, IssueKind>) {
  return groupSpans(node)
    .map((span) => issueBySpan.get(span.id))
    .find(Boolean);
}

/**
 * The issues an open group's calls show: not the group's own, which its row says once (an N+1 is the 36 calls
 * together, not each of them); another one a call has on its own still shows on its row.
 */
function withoutGroupIssue(
  node: Extract<Node, { type: "group" }>,
  issueBySpan: ReadonlyMap<string, IssueKind>,
): ReadonlyMap<string, IssueKind> {
  const issue = groupIssue(node, issueBySpan);
  if (!issue) return issueBySpan;
  const said = new Set(groupSpans(node).map((span) => span.id));
  return new Map([...issueBySpan].filter(([id, kind]) => !(said.has(id) && kind === issue)));
}

/**
 * A row's chips after its name: its issue, then what a call's trace found. Short of room they go whole, the last
 * first, onto a line that doesn't show (.dt-map-chips): never a chip cut down to an empty pill.
 */
function RowChips({ children }: { children: ReactNode }) {
  return <span className="dt-map-chips">{children}</span>;
}

/** Repeats of one call folded into one row (×N), its calls as ticks on the timeline; open, each call a row. */
function GroupRow({ node, place: { ctx, indent, depth, mark, parent } }: RowProps<"group">) {
  const open = ctx.collapsed.has(`open:${node.key}`);
  const wall = node.end - node.start;
  const issueBySpan = useMemo(() => withoutGroupIssue(node, ctx.issueBySpan), [node, ctx.issueBySpan]);
  const answer = useMemo(() => groupAnswerOf(node), [node]);
  return (
    <div className="dt-map-group">
      <button
        type="button"
        className="dt-map-row"
        {...rowState(ctx, node.key, mark)}
        data-kind={node.spans[0]?.kind}
        data-category={ctx.categories.get(node.spans[0]?.id ?? "")}
        data-status={answer.tone}
        aria-expanded={open}
        onClick={() => {
          ctx.onSelect(node.key);
          ctx.onToggle(`open:${node.key}`);
        }}
        onKeyDown={foldKeys(open, () => ctx.onToggle(`open:${node.key}`))}
      >
        <span className="dt-map-name" style={indent}>
          <Caret open={open} onToggle={() => ctx.onToggle(`open:${node.key}`)} />
          <GroupName node={node} ctx={ctx} parent={parent} answer={answer} />
        </span>
        <GroupTicks spans={node.spans} trace={ctx.trace} within={ctx.within} />
        <RowTime
          time={wall}
          slow={slowness(wall, ctx.trace, ctx.categories.get(node.spans[0]?.id ?? ""))}
          title={groupTimes(node)}
        />
      </button>
      <RowDetails id={node.key} ctx={ctx} />
      {open ? (
        <Rows nodes={node.members} depth={depth + 1} ctx={{ ...ctx, marks: undefined, issueBySpan }} parent={parent} />
      ) : null}
    </div>
  );
}

/** How a group's calls went, each with the trace served for it as its own row takes it (see rowStatus). */
function groupAnswerOf(node: Extract<Node, { type: "group" }>): GroupAnswer {
  return groupAnswer(node.members.map((member) => ({ span: member.span, served: member.served?.run })));
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
  return ownChildren(node).flatMap((child) => (child.type === "span" ? [child.span] : []));
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
function OpText({ text, kind, className }: { text: string; kind: string | undefined; className?: string }) {
  const op = OP.exec(text);
  const classes = className ? `dt-map-text ${className}` : "dt-map-text";
  if (!op) return <span className={classes}>{text}</span>;
  return (
    <span className={classes}>
      <span className="dt-map-op" data-method={kind === "http.client" ? op[1] : undefined}>
        {op[1]}
      </span>
      {op[2]}
    </span>
  );
}

/** A span: its kind, its name and what goes with it, its bar and its time; its rows under it, open or folded. */
function SpanRow({ node, place }: RowProps<"span">) {
  return node.served ? <HopRow node={node} served={node.served} place={place} /> : <OwnRow node={node} place={place} />;
}

/** A span's time; a call the page sent its trace before it ended, with no trace served for it, has none known. */
function OwnTime({ span, ctx }: { span: Span; ctx: RowContext }) {
  if (answers(span) && span.duration === 0 && unfinished(span)) {
    return (
      <span className="dt-map-time" title={UNENDED_NOTE}>
        —
      </span>
    );
  }
  const slow = span.parent_id === null ? undefined : slowness(span.duration, ctx.trace, ctx.categories.get(span.id));
  return <RowTime time={span.duration} slow={slow} title={timeTitle(span, ctx.trace)} />;
}

/** A span's bar; a call cut short runs to where it was cut, fading out there, never a 0-width mark. */
function OwnBar({ span, ctx }: { span: Span; ctx: RowContext }) {
  const cut = cutLength(span, ctx.trace);
  return (
    <Bar trace={ctx.trace} start={span.start} length={cut ?? span.duration} cut={cut !== null} within={ctx.within} />
  );
}

function OwnRow({ node, place: { ctx, indent, depth, mark, parent } }: RowProps<"span">) {
  const { span } = node;
  const fold = spanFold(node, mark, ctx);
  const issue = ctx.issueBySpan.get(span.id);
  return (
    <div>
      <button type="button" {...spanButton(ctx, node, mark, fold)} data-root={span.parent_id === null ? "" : undefined}>
        <span className="dt-map-name" style={indent}>
          <SpanFold ctx={ctx} node={node} parent={parent} fold={fold} />
          <SpanName span={span} />
          <CallStatus node={node} />
          <AliasChip value={aliasBeside(span)} />
          <FromTemplate span={span} parent={parent} />
          <SignalNotes span={span} parent={parent} under={childSpans(node)} />
          <MigrationNotes span={span} />
          <HiddenLogs count={ctx.hiddenLogs.get(span.id)} onShow={ctx.onShowLogs} />
          <RowChips>{issue ? <IssueChip kind={issue} className={ISSUE_CHIP_SHRINKS} /> : null}</RowChips>
        </span>
        <OwnBar span={span} ctx={ctx} />
        <OwnTime span={span} ctx={ctx} />
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

/* ---------- a call and the trace served for it, one row ---------- */

// A call's method and where it went: the host, the app chip beside it says better.
const HOST = /^([A-Z]+ )(?:[a-z][a-z0-9+.-]*:\/\/)?[^/\s]+(\/\S*)?$/;

/** A merged call's text: its method and path ("POST /graphql"), the host left to the app chip. */
function hopText(span: Span): string {
  const text = callText(span);
  const found = HOST.exec(text);
  return found ? `${found[1]}${found[2] ?? "/"}` : text;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a trace's name says no more than the call's path: "GET /authors/{id}" for GET /authors/2. */
function sameRoute(text: string, name: string): boolean {
  const pathOf = (each: string) => (each.replace(/^[A-Z]+ /, "").split("?")[0] ?? "").replace(/(.)\/$/, "$1");
  const [path, route] = [pathOf(text), pathOf(name)];
  if (path === route) return true;
  const parts = route.split(/\{[^}]+\}|<[^>]+>|:[A-Za-z_]\w*/);
  return parts.length > 1 && new RegExp(`^${parts.map(escaped).join("[^/]+")}$`).test(path);
}

/** The served trace's name, where it says more than the path (a GraphQL operation's): what grows in the row. */
function ServedName({ text, name }: { text: string; name: string }) {
  const shown = sameRoute(text, name) ? "" : name;
  return (
    <span className="dt-map-text dt-map-hop-name" title={shown || undefined}>
      {shown}
    </span>
  );
}

/** The call's bar, the way there and back pale; the server's time inside it, solid, on the call's clock (Clock). */
function HopBar({
  trace,
  span,
  run,
  within,
}: {
  trace: Trace;
  span: Span;
  run: TraceSummary;
  within: Within | undefined;
}) {
  const [from, long] = clipped(span.start, span.duration, within);
  const call = barPlace(trace, from, long);
  const [at, length] = clipped(run.start, run.duration, narrowed(within, span));
  const server = barPlace(trace, at, length);
  return (
    <span className="dt-map-track" aria-hidden="true">
      <span className="dt-map-bar" data-call="" data-past={call.past} style={call.style} />
      <span className="dt-map-bar" data-server="" style={server.style} />
    </span>
  );
}

/** A call cut short, on its time's hover. */
const CUT_NOTE =
  "The page sent its trace before this call ended (a route change, or its longest wait): its time is until the trace served for it ended";
/** A call cut short with no trace served for it: its time isn't known. */
const UNENDED_NOTE =
  "The page sent its trace before this call ended (a route change, or its longest wait): its time isn't known";

/** A merged call's time on hover: the server's part and the rest (the network, a queue), and what its clock did. */
function hopTimes(span: Span, served: ServedRun): string {
  const server = served.run.duration;
  // Longer than the call by the caller's clock: the two clocks disagree (the note says), no network time to say.
  const split =
    server > span.duration
      ? `server ${duration(server)} by its app's clock`
      : `server ${duration(server)} · network ${duration(span.duration - server)}`;
  const note = clockNote(served);
  return note ? `${split}\n${note}` : split;
}

/**
 * A call merged with the trace another app served for it (see hopOf): open, that trace's rows straight under it, by
 * the chain's rules (one of many deeper down starts folded); a first click selects it, as a span's.
 */
function HopRow({ node, served, place }: { node: SpanNode; served: ServedRun; place: RowPlace }) {
  const { ctx, indent, depth, mark, parent } = place;
  const { span } = node;
  const has = node.children.length > 0;
  const fold = foldOf(has, has && (mark === "path" || served.opened !== ctx.collapsed.has(node.key)));
  useChainLoad(served, fold, ctx.onChain);
  const inner = useLinkedContext(served, ctx);
  const root = served.whole?.spans.find((each) => each.parent_id === null);
  const under = { ...inner, within: narrowed(ctx.within, span) };
  const text = hopText(span);
  return (
    <div>
      <button type="button" {...spanButton(ctx, node, mark, fold)} data-hop="">
        <span className="dt-map-name" style={indent}>
          <SpanFold ctx={ctx} node={node} parent={parent} fold={fold} />
          <OpText text={text} kind={span.kind} className="dt-map-hop-path" />
          <span className="dt-map-hop" aria-hidden="true">
            →
          </span>
          <span className="sr-only">served by</span>
          <CallApp node={served} />
          <ServedName text={text} name={served.run.name} />
          {/* After what served it: the answer is the served trace's when the call says none. */}
          <CallStatus node={node} />
          <FromTemplate span={span} parent={parent} />
          <HiddenLogs count={ctx.hiddenLogs.get(span.id)} onShow={ctx.onShowLogs} />
          <RowChips>
            <HopIssue span={span} served={served} ctx={ctx} />
            <RunChips trace={served.run} />
          </RowChips>
          <LinkedFlame node={served} ctx={ctx} />
        </span>
        <HopBar trace={ctx.trace} span={span} run={served.run} within={ctx.within} />
        <RowTime
          time={span.duration}
          slow={slowness(span.duration, ctx.trace, ctx.categories.get(span.id))}
          title={node.cut ? `${CUT_NOTE}\n${hopTimes(span, served)}` : hopTimes(span, served)}
        />
      </button>
      <RowDetails id={node.key} ctx={ctx} />
      {fold ? (
        <>
          <Rows nodes={node.children} depth={depth + 1} ctx={under} />
          {/* The served request's own code, as a span's is under its rows: the request is this row. */}
          {root ? <CodeRow span={root} ctx={under} depth={depth + 1} /> : null}
          <CodeRow span={span} ctx={ctx} depth={depth + 1} />
        </>
      ) : null}
    </div>
  );
}

/** The call's own issue (an N+1 of calls), unless the served trace's chips say that one already. */
function HopIssue({ span, served, ctx }: { span: Span; served: ServedRun; ctx: RowContext }) {
  const issue = ctx.issueBySpan.get(span.id);
  if (!issue || served.run.issue_kinds.includes(issue)) return null;
  return <IssueChip kind={issue} className={ISSUE_CHIP_SHRINKS} />;
}

/** A row's look by how it went: a call by what it was answered (5xx or none red, 4xx amber), else its span's status. */
function rowStatus(node: SpanNode): string {
  if (!answers(node.span)) return node.span.status;
  const { tone } = callAnswer(node.span, node.served?.run);
  return tone ?? node.span.status;
}

/**
 * What a call was answered, beside its name: its status code as every list shows one, "failed" when no answer came
 * (a connection error, a timeout). Nothing for a call that says neither.
 */
function CallStatus({ node }: { node: SpanNode }) {
  if (!answers(node.span)) return null;
  const { status, tone } = callAnswer(node.span, node.served?.run);
  if (status !== null) return <StatusBadge status={status} />;
  if (tone !== "error") return null;
  const failure = node.span.attrs["error.type"];
  return (
    <span className="dt-status" data-tone="error" title={typeof failure === "string" ? failure : "No answer"}>
      failed
    </span>
  );
}

/** A span row's button: its state, kind and share; a click selects it and opens it, the arrows fold it. */
function spanButton(ctx: RowContext, node: SpanNode, mark: Mark | undefined, fold: boolean | undefined) {
  const { span } = node;
  return {
    className: "dt-map-row",
    ...rowState(ctx, node.key, mark),
    "data-kind": span.kind,
    "data-category": ctx.categories.get(span.id),
    "data-status": rowStatus(node),
    "aria-expanded": fold,
    onClick: () => clickSpan(ctx, node.key, fold),
    onKeyDown: foldKeys(fold, () => ctx.onToggle(node.key)),
  };
}

/** A span row's fold and its kind's badge. */
function SpanFold({
  ctx,
  node,
  parent,
  fold,
}: {
  ctx: RowContext;
  node: SpanNode;
  parent: Span | undefined;
  fold: boolean | undefined;
}) {
  return (
    <>
      <Caret open={fold} onToggle={() => ctx.onToggle(node.key)} />
      <KindBadge kind={rowKind(node.span, ctx.trace, parent)} muted={true} className="dt-map-kind" />
    </>
  );
}

/** A row's kind as its badge says it: a browser's view or action as its list names it (view, click, bg). */
function rowKind(span: Span, trace: Trace, parent: Span | undefined): string {
  if (span.kind === "page") return pageParts(span.name).badge.toLowerCase();
  return spanKindLabel(span.kind, trace.attrs, parent?.kind);
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
function partName(part: CodePart, code: CodeOwner, span: string): { name: string; yours: boolean } {
  const profile = partProfile(part, code, span);
  if (part.waiting) return waited(profile);
  const name = profile ? ranMost(profile) : UNTRACED;
  return { name, yours: name !== UNTRACED };
}

const UNTRACED = "untraced code";

const OWNERS = new WeakMap<CodeOwner, Map<number, string>>();

/** Whose code row each bucket of the owner's profile is (see bucketOwners); one map per owner. */
function ownersOf(code: CodeOwner, profile: Timed): Map<number, string> {
  let owners = OWNERS.get(code);
  if (!owners) {
    const gaps = new Map([...code.quiet].map(([id, quiet]) => [id, quiet.gaps] as const));
    owners = bucketOwners(profile, gaps, code.trace.start);
    OWNERS.set(code, owners);
  }
  return owners;
}

/**
 * The profile a code row is named by: of its own pieces' time only, not of the rows between them (a handler's code
 * before its transaction and after the commit, not the transaction's), and of the buckets that are its code's more
 * than another row's. The whole trace's where the profile doesn't say when.
 */
function partProfile(part: CodePart, code: CodeOwner, span: string): Profile | undefined {
  const profile = code.trace.profile;
  if (!timed(profile)) return profileOver(code.trace, partRange(part));
  return ownProfile(profile, part.pieces, ownersOf(code, profile), span);
}

/** Where a wait row waited, said quietly after its name: "handlers.py:108", where the profile says. */
function WaitPlace({ part, code, span }: { part: CodePart; code: CodeOwner; span: string }) {
  const profile = partProfile(part, code, span);
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
  const { name, yours } = partName(part, ctx.code, span.id);
  return (
    <>
      <span className="dt-map-name" style={indentOf(depth)}>
        <span className="dt-map-caret" />
        <KindBadge
          kind={part.waiting ? "wait" : "code"}
          muted={true}
          className={part.waiting ? "dt-map-kind dt-map-wait" : "dt-map-kind"}
        />
        <UntracedHint name={name} code={ctx.code}>
          <TaskName name={name} className={yours ? "dt-map-text" : "dt-map-text dt-map-lib"} />
        </UntracedHint>
        <WaitPlace part={part} code={ctx.code} span={span.id} />
        <RowFlame trace={owner} />
      </span>
      <CodeBars part={part} category={category} trace={ctx.trace} owner={owner} />
      <span className="dt-map-time">{duration(part.total)}</span>
    </>
  );
}

/** On untraced code of a trace without a profile, where the app can profile, on hover: how to see what ran there. */
function UntracedHint({ name, code, children }: { name: string; code: CodeOwner; children: ReactNode }) {
  if (name !== UNTRACED || !code.profiles || code.trace.profile) return children;
  return (
    <Hint
      title="Untraced code"
      detail={
        <>
          Your code between the spans here. To see which of your functions ran, profile the request with the{" "}
          <FlameIcon className="inline size-3.5 align-[-2px]" aria-label="flame" /> in the panel.
        </>
      }
      side="top"
    >
      <span className="flex min-w-0">{children}</span>
    </Hint>
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
  if (node.type === "span" && node.served) {
    return findNode(node.served.children, key, ownerOf(node.served, trace)) ?? findNode(ownChildren(node), key, trace);
  }
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
      <Inside />
      <PropTable dense rows={runRows(run, words.label)} />
      <OpenRun run={run} words={words} links={links} remote={remote} />
      <ProfileLink open={profile} />
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
  const profile = servedProfile(node, onTraceProfile);
  return (
    <RunDetails run={node.run} kind={node.kind} trace={trace} links={links} remote={node.remote} profile={profile} />
  );
}

type DetailsProps<T extends Node["type"]> = {
  node: Extract<Node, { type: T }>;
  trace: Trace;
  links?: TraceLinks | undefined;
  /** EXPLAIN for a query of the trace shown (this one or a linked one), as the DB tab runs it, where its app can. */
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
  // Where they were called from, when they all were from one place; called from several, each call's row says its.
  const origins = new Set(node.spans.map((span) => String(span.attrs["code.origin"] ?? "")));
  const [origin] = origins;
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">
        {node.spans.length} similar {groupNoun(first)} · took {duration(node.end - node.start)} ·{" "}
        {duration(node.spans.reduce((sum, span) => sum + span.duration, 0))} total
      </p>
      <Inside />
      {first ? (
        <>
          <Statement span={first} attrs={first.attrs} />
          <Fields rows={summaryRows(first, false)} />
          <QueryPlan span={first} onExplain={onExplain} />
        </>
      ) : null}
      {origins.size === 1 && origin ? (
        <p className="flex flex-wrap items-center gap-2 text-base text-muted-foreground" data-group-origin="">
          from <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">{origin}</code>
        </p>
      ) : null}
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
      <Inside />
      <Raised attrs={span.attrs} />
      <Statement span={span} attrs={attrs} />
      {typeof document === "string" ? <GraphqlCode document={document} /> : null}
    </>
  );
}

function SpanDetails(props: DetailsProps<"span">) {
  if (props.node.served) return <HopDetails {...props} served={props.node.served} />;
  return props.node.span.parent_id === null ? <RootDetails {...props} /> : <CallDetails {...props} />;
}

/** The root span stands for the whole request: its details are the trace's own attributes, as its Request tab shows them. */
function RootDetails({ node: { span }, trace }: DetailsProps<"span">) {
  const attrs = { ...trace.attrs, ...span.attrs };
  return (
    <div className="grid gap-3 p-4">
      <SpanHead span={span} trace={trace} attrs={attrs} />
      <RootAttributes attrs={attrs} />
      <AsReceived span={span} />
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
      <AsReceived span={span} />
    </div>
  );
}

/**
 * A call merged with the trace served for it: the call (its URL, status, where it was called from, its attributes),
 * then what served it (that trace's name and findings, the ways to it and to its profile).
 */
function HopDetails({
  node: { span },
  served,
  trace,
  links,
  onTraceProfile,
}: DetailsProps<"span"> & { served: ServedRun }) {
  const parent = trace.spans.find((each) => each.id === span.parent_id);
  const summary = summaryRows(span, true, parent);
  return (
    <div className="grid gap-5 p-4">
      <section className="grid gap-3" aria-label="Call">
        <SectionHeading>Call</SectionHeading>
        <SpanHead span={span} trace={trace} parent={parent} attrs={span.attrs} />
        {summary.length ? <Fields rows={summary} /> : null}
        <SpanAttributes span={span} attrs={span.attrs} titled={summary.length > 0} />
        <AsReceived span={span} />
      </section>
      <ServedBy served={served} trace={trace} links={links} onTraceProfile={onTraceProfile} />
    </div>
  );
}

/** What served a merged call: its app, its trace's name and findings, the ways to it and to its profile. */
function ServedBy({
  served,
  trace,
  links,
  onTraceProfile,
}: {
  served: ServedRun;
  trace: Trace;
  links: TraceLinks | undefined;
  onTraceProfile: TraceProfileOpener | undefined;
}) {
  return (
    <section className="grid gap-3" aria-label={`Served by ${appName(served) ?? "another app"}`}>
      <ServedHeading served={served} />
      <p className="dt-map-details-title">
        started {duration(Math.max(served.run.start - trace.start, 0))} after this request · took{" "}
        {duration(served.run.duration)}
      </p>
      <PropTable dense rows={runRows(served.run, "Trace")} />
      <RunChips trace={served.run} />
      <OpenRun run={served.run} words={RUN_WORDS.call} links={links} remote={served.remote} />
      <ProfileLink open={servedProfile(served, onTraceProfile)} />
    </section>
  );
}

/** "Served by" and the app's chip, as the row has it. */
function ServedHeading({ served }: { served: ServedRun }) {
  const app = appName(served);
  return (
    <SectionHeading>
      Served by{app ? <AppChip name={app} runtime={traceRuntime(served.whole?.attrs ?? {})} compact /> : " another app"}
    </SectionHeading>
  );
}

/** Opens a call's trace's profile, when this agent has that trace whole with one. */
function servedProfile(served: ServedRun, open: TraceProfileOpener | undefined): (() => void) | undefined {
  const whole = served.remote ? undefined : served.whole;
  return whole?.profile && open ? () => open(whole.id) : undefined;
}

function ProfileLink({ open }: { open: (() => void) | undefined }) {
  return open ? (
    <button type="button" className="dt-map-open" onClick={open}>
      Open its profile →
    </button>
  ) : null;
}

/**
 * The trace's attributes on its request row, as its Request tab shows them: the same parts behind the same switch
 * (Headers, Query, Body, Cookies, Session, Response, Attributes), in the same rows, no box. The GraphQL document is
 * shown formatted above.
 */
function RootAttributes({ attrs }: { attrs: Attrs }) {
  const { "graphql.document": _, ...rest } = attrs;
  const others = attrsWhere(rest, (key) => !isRequestDetail(key));
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
function SidePane({ children, onClose }: { children: ReactNode; onClose: () => void }) {
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
      <button type="button" className="dt-map-side-close" aria-label="Close the details" onClick={onClose}>
        <CloseIcon />
      </button>
      {children}
    </aside>
  );
}

/**
 * The tree, and its details beside it while it is wide enough. The edge between them is the grid's own (SideResize),
 * as tall as the tree and the pane together however far either reaches or scrolls: the whole line drags.
 */
function MapBody({ details, onClose, children }: { details: ReactNode; onClose: () => void; children: ReactNode }) {
  const { width, setWidth, style } = useSideWidth();
  return (
    <div className="dt-map-body" data-side={details ? "" : undefined} style={details ? style : undefined}>
      <div className="dt-map-tree">{children}</div>
      {details ? (
        <>
          <SideResize width={width} onWidth={setWidth} />
          <SidePane onClose={onClose}>{details}</SidePane>
        </>
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
  if (node.type === "span") return spanScope(node);
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

/** What a row's details call what is under it: "Inside this span", "Inside these calls". */
export type UnderSubject = "this span" | "this call" | "these calls" | "this trace";

function subjectOf(node: Node): UnderSubject {
  if (node.type === "group") return "these calls";
  if (node.type === "task") return "this trace";
  return node.type === "span" && node.served ? "this call" : "this span";
}

/** What is under the selected row, as its details show it right under their title (see UnderThis). */
const UnderSlot = createContext<ReactNode>(null);

function Inside() {
  return useContext(UnderSlot);
}

/** A span's, a merged call's (see hopScope). */
function spanScope({ span, served }: SpanNode): SpanScope {
  return served ? hopScope(span, served) : { targets: [span.id], label: span.name, only: false };
}

/** What is under a merged call: its span's, which takes the trace served for it too. */
function hopScope(span: Span, served: ServedRun): SpanScope {
  const app = appName(served);
  return { targets: [span.id], label: app ? `${hopText(span)} → ${app}` : span.name, only: false };
}

function detailsOf(
  tree: Node[],
  selected: string | null,
  trace: Trace,
  hosts: {
    links: TraceLinks | undefined;
    explainOf: ExplainOf | undefined;
    onTraceProfile: TraceProfileOpener | undefined;
    under: ((scope: SpanScope, subject: UnderSubject) => ReactNode) | undefined;
  },
): ReactNode {
  const found = selected ? findNode(tree, selected, trace) : undefined;
  if (!found) return null;
  // A query is explained by the app of the trace it is in: this one's, or a linked trace's (the agent asks that app).
  const onExplain = hosts.explainOf?.(found.trace);
  const scope = hosts.under && scopeOfNode(found.node);
  return (
    <UnderSlot value={scope ? hosts.under?.(scope, subjectOf(found.node)) : null}>
      <Details
        node={found.node}
        trace={found.trace}
        links={hosts.links}
        onExplain={onExplain}
        onTraceProfile={hosts.onTraceProfile}
      />
    </UnderSlot>
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
  const issues = callTraces(related, chain).flatMap((trace) => trace.issues);
  return new Map([
    ...issueBySpan,
    ...issues.flatMap((issue) => issue.span_ids.map((id): [string, IssueKind] => [id, issue.kind])),
  ]);
}

/** A trace with only the log records that show: its warnings and worse and its dumps, or every one of them (`all`). */
export function withShownLogs(trace: Trace, all: boolean): Trace {
  return all ? trace : { ...trace, logs: trace.logs.filter(isShown) };
}

/**
 * How many records don't show, by the span they were logged in (the root's for those logged outside any), in this
 * trace and the calls' traces opened under the calls. A call's trace's own records are its call's row's: its root
 * is that row (`calls`: the call's span by the trace's id).
 */
function hiddenLogsOf(traces: readonly Trace[], calls: ReadonlyMap<string, string>): Map<string, number> {
  const hidden = new Map<string, number>();
  for (const trace of traces) countQuiet(trace, calls.get(trace.id), hidden);
  return hidden;
}

/** A trace's info and debug records (dumps aside), counted by their span; its root's on `row` when its root shows as that row. */
function countQuiet(trace: Trace, row: string | undefined, hidden: Map<string, number>): void {
  const own = rootOf(trace);
  for (const log of trace.logs.filter((each) => !isShown(each))) {
    const span = log.span_id === null || log.span_id === own ? (row ?? own) : log.span_id;
    hidden.set(span, (hidden.get(span) ?? 0) + 1);
  }
}

/** The span of the call that reached each call's trace, by the trace's id, however far down the chain. */
function callSpans(related: Related | undefined, chain: ReadonlyMap<string, Related>): Map<string, string> {
  return new Map([related, ...chain.values()].flatMap((each) => Object.entries(each?.via ?? {})));
}

/** The calls' traces opened under the calls, however far down the chain. */
function callTraces(related: Related | undefined, chain: ReadonlyMap<string, Related>): Trace[] {
  return [related, ...chain.values()].flatMap((each) => Object.values(each?.call_traces ?? {}));
}

function rootOf(trace: Trace): string {
  return trace.spans.find((span) => span.parent_id === null)?.id ?? "";
}

/** The tree with the records that show, and how many don't, by span: none hidden while every one shows. */
function useShownLogs(trace: Trace, related: Related | undefined, all: boolean, loaded: ReadonlyMap<string, Related>) {
  const tree = useMemo(() => {
    const chain: Chain = { level: 0, relatedOf: (id) => loaded.get(id), seen: new Set([trace.id]), allLogs: all };
    return buildTree(withShownLogs(trace, all), related, chain);
  }, [trace, related, all, loaded]);
  const hidden = useMemo(
    () =>
      all
        ? new Map<string, number>()
        : hiddenLogsOf([trace, ...callTraces(related, loaded)], callSpans(related, loaded)),
    [trace, related, all, loaded],
  );
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
  /** Whether the app that recorded a trace profiles a request when asked: its untraced code then says how. */
  profilesIn?: ProfilesIn | undefined;
  /** EXPLAIN for a query of this trace or a linked one: a SELECT's details then have its plan, as the DB tab's. */
  explainOf?: ExplainOf | undefined;
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
  /** Under a row's details' title: what is under it (its records, ...), each a way to the tab that lists them. */
  under?: ((scope: SpanScope, subject: UnderSubject) => ReactNode) | undefined;
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
    explainOf: wiring.explainOf,
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
                code: {
                  trace,
                  quiet,
                  onProfile: profileOpener(wiring.onProfile, trace, profileAt),
                  profiles: wiring.profilesIn?.(trace) === true,
                },
                categories,
                slice: current,
                onTraceProfile: wiring.onTraceProfile,
                profilesIn: wiring.profilesIn,
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
