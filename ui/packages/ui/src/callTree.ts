import { keyed } from "./keys";
import type { Category } from "./lib/breakdown";
import { unfinished } from "./lib/callAnswer";
import { callTemplate } from "./lib/calls";
import { shifted } from "./lib/scope";
import { isShown, overlaps, type TimeRange } from "./lib/slice";
import { CALL_KINDS, DATASTORES, MESSAGING, RPC } from "./lib/systems";
import type { IssueKind, Log, Related, Span, Trace, TraceError, TraceSummary } from "./types";

export type Node =
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

export type SpanNode = Extract<Node, { type: "span" }>;

/** The trace another app served for a call (or a task's run, `kind: "task"`). */
export type ServedRun = Extract<Node, { type: "task" }>;

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
export interface Remote {
  console: string;
  project: string;
}

/**
 * Where a tree is in the chain of calls it opens: the trace on screen is `level` 0, the traces its calls reached 1,
 * theirs 2. `relatedOf` gives the links of a call's trace once they are loaded (the next level then opens under its
 * calls); `seen` the traces above, so a loop in the links can't open forever.
 */
export interface Chain {
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
export const CHAIN_LEVELS = 6;

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
export const SKEW_NOTE_MIN = 1_000;

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
export function ownChildren(node: SpanNode): Node[] {
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

/** Each kind's colour that has one of its own (`--tp-k-*`): the others are code's, as the time strip says it. */
const FILTER_COLOURS: Readonly<Record<string, string>> = {
  sql: "sql",
  redis: "redis",
  cache: "cache",
  datastore: "datastore",
  messaging: "messaging",
  http: "http",
  rpc: "http",
  storage: "storage",
  llm: "llm",
  migration: "migration",
  signal: "signal",
  template: "template",
  mail: "mail",
  task: "messaging",
  channels: "messaging",
  transaction: "sql",
  error: "log",
  log: "log",
};

/** A kind's colour, the bars' own: the closest share where a kind has none of its own (GraphQL, functions: code). */
export function filterColor(id: string): string {
  return FILTER_COLOURS[id] ?? "view";
}

/** A span kind's colour as the Show menu has it: none for a kind no filter names (a request, a view). */
export function kindColor(kind: string): string | undefined {
  const filter = FILTER_OF.get(kind);
  return filter ? filterColor(filter) : undefined;
}

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
export interface Picked {
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
export function markTree(nodes: Node[], picked: Picked, marks = new Map<string, Mark>()): boolean {
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
  // A row's own kind picked as it is (the panel's Show menu: "log", a record's warnings and errors).
  if (picked.parts.has(kindOf(node))) return true;
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

export type Mark = "match" | "path";

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

/** The row with this key, and the trace it belongs to: this one, or a call's trace opened under the call. */
export function findNode(nodes: Node[], key: string, trace: Trace): Found | undefined {
  for (const node of nodes) {
    const found = findIn(node, key, trace);
    if (found) return found;
  }
  return undefined;
}

type Found = { node: Node; trace: Trace };

/** The rows on the way to a row, outermost first, the row last; undefined when the tree hasn't got it. */
/**
 * The deepest row with every one of these spans under it (or it): where a finding on many spans shows, an N+1's group
 * rather than one of its calls. Undefined while one of them isn't in the tree yet.
 */
export function coverOf(nodes: readonly Node[], keys: readonly string[]): string | undefined {
  const [first, ...rest] = keys;
  const path = first ? pathTo(nodes, first) : undefined;
  if (!path) return undefined;
  for (let at = path.length - 1; at >= 0; at--) {
    const node = path[at];
    if (node && rest.every((key) => pathFrom(node, key))) return node.key;
  }
  return undefined;
}

export function pathTo(nodes: readonly Node[], key: string): Node[] | undefined {
  for (const node of nodes) {
    const path = pathFrom(node, key);
    if (path) return path;
  }
  return undefined;
}

function pathFrom(node: Node, key: string): Node[] | undefined {
  if (node.key === key) return [node];
  const inner = pathTo(node.type === "group" ? node.members : childrenOf(node), key);
  return inner && [node, ...inner];
}

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

/** This trace's issues by span, and those of the calls' traces opened under the calls, however far down the chain. */
export function withCallIssues(
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
export function hiddenLogsOf(traces: readonly Trace[], calls: ReadonlyMap<string, string>): Map<string, number> {
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
export function callSpans(related: Related | undefined, chain: ReadonlyMap<string, Related>): Map<string, string> {
  return new Map([related, ...chain.values()].flatMap((each) => Object.entries(each?.via ?? {})));
}

/** The calls' traces opened under the calls, however far down the chain. */
export function callTraces(related: Related | undefined, chain: ReadonlyMap<string, Related>): Trace[] {
  return [related, ...chain.values()].flatMap((each) => Object.values(each?.call_traces ?? {}));
}

export function rootOf(trace: Trace): string {
  return trace.spans.find((span) => span.parent_id === null)?.id ?? "";
}

/** The rows under a row: a span's, or those of a call's trace that came whole. */
export function childrenOf(node: Node): Node[] {
  return node.type === "span" || node.type === "task" ? node.children : [];
}

function rowText(node: Node): string {
  switch (node.type) {
    case "span":
    case "waiting":
      return spanText(node.span);
    case "group":
      return node.spans.map(spanText).join(" ");
    case "log":
      return JSON.stringify(node.log);
    case "error":
      return JSON.stringify(node.error);
    case "task":
      return node.run.name;
  }
}

function spanText(span: Span): string {
  const { "db.statement": statement, "db.query.text": query, "url.full": url, "http.url": old } = span.attrs;
  return [span.name, statement, query, url, old].filter((part) => typeof part === "string").join(" ");
}

function keptBy(node: Node, query: string): Node | null {
  // A match keeps what is under it; else only the way down to a match.
  if (rowText(node).toLowerCase().includes(query)) return node;
  if (node.type === "group") return node.members.some((member) => keptBy(member, query)) ? node : null;
  if (node.type !== "span" && node.type !== "task") return null;
  const children = node.children.flatMap((child) => keptBy(child, query) ?? []);
  return children.length > 0 ? { ...node, children } : null;
}

/** The tree cut down to the rows a query finds and the way to them. Its root stays: it is the record's own row. */
export function filteredTree(tree: readonly Node[], query: string): Node[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [...tree];
  return tree.map((root) => {
    if (root.type !== "span" && root.type !== "task") return root;
    return { ...root, children: root.children.flatMap((child) => keptBy(child, wanted) ?? []) };
  });
}
