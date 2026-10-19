import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { duration, percent, since } from "./format";
import { GraphqlCode } from "./GraphqlCode";
import { ChevronRightIcon, CloseIcon } from "./icons";
import { keyed } from "./keys";
import { AllAttributes, LogRecordDetails } from "./LogRecordDetails";
import { breakdown, CATEGORY_LABELS, type Category } from "./lib/breakdown";
import { callFields } from "./lib/callFields";
import { callTemplate, groupNoun } from "./lib/calls";
import { runtimeKind, traceRuntime } from "./lib/runtime";
import { CALL_KINDS, DATASTORES, MESSAGING, RPC } from "./lib/systems";
import { linkProps, type TraceLinks } from "./links";
import { type PropRow, PropTable } from "./PropTable";
import { AliasChip, IssueChip } from "./primitives";
import { RuntimeIcon } from "./RuntimeIcon";
import { SideResize, useSideWidth } from "./SideResize";
import { SqlCode } from "./SqlCode";
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
 * 3+ identical leaf queries, cache calls or HTTP calls (to one path template) under one parent collapse into a group
 * shown where the first one ran, even when they interleave (an N+1 in a template loop alternates between several
 * statements).
 */
const GROUP_MIN = 3;

function isLeafCall(node: Node): node is Extract<Node, { type: "span" }> {
  return node.type === "span" && CALL_KINDS.has(node.span.kind) && node.children.every(isBackendCall);
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

function buildTree(trace: Trace, related: Related | undefined): Node[] {
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
const FILTERS = [
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
  { id: "log", label: "Logs", kinds: ["log"] },
  { id: "error", label: "Errors", kinds: ["error"] },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

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
function chipCounts(nodes: Node[], trace: Trace): Map<FilterId, number> {
  const counts = countFilters(nodes);
  const filters = trace.spans.map((span) => FILTER_OF.get(span.kind)).filter((filter) => filter !== undefined);
  for (const filter of new Set(filters)) counts.set(filter, filters.filter((each) => each === filter).length);
  return counts;
}

/**
 * With filters on: the rows that match, and the rows on the way to them ("path": shown dimmed, always open).
 * Everything else is hidden.
 */
function markTree(nodes: Node[], active: ReadonlySet<FilterId>, marks = new Map<string, Mark>()): boolean {
  let any = false;
  for (const node of nodes) {
    const filter = FILTER_OF.get(kindOf(node));
    const matches = filter !== undefined && active.has(filter);
    const below = markTree(childrenOf(node), active, marks);
    if (matches) marks.set(node.key, "match");
    else if (below) marks.set(node.key, "path");
    any = any || matches || below;
  }
  return any;
}

type Mark = "match" | "path";

function toggled(active: ReadonlySet<FilterId>, id: FilterId): ReadonlySet<FilterId> {
  const next = new Set(active);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The legend's entries that pick rows too: a category's spans are a filter's rows. */
const CATEGORY_FILTERS: Partial<Record<Category, FilterId>> = {
  template: "template",
  sql: "sql",
  redis: "redis",
  cache: "cache",
  datastore: "datastore",
  messaging: "messaging",
  http: "http",
  mail: "mail",
};

interface FilterState {
  counts: ReadonlyMap<FilterId, number>;
  active: ReadonlySet<FilterId>;
  onChange: (next: ReadonlySet<FilterId>) => void;
}

/** A chip that shows only its rows (and the rows on the way to them); pressed again, everything. */
function FilterChip({ id, filters, children }: { id: FilterId; filters: FilterState; children: ReactNode }) {
  return (
    <button
      type="button"
      className="dt-map-filter"
      aria-pressed={filters.active.has(id)}
      onClick={() => filters.onChange(toggled(filters.active, id))}
    >
      {children}
      <span className="dt-map-filter-count">{filters.counts.get(id)}</span>
    </button>
  );
}

/** A category of the time: its share, and a filter chip when the tree has its rows. */
function Share({
  category,
  value,
  total,
  filters,
}: {
  category: Category;
  value: number;
  total: number;
  filters: FilterState;
}) {
  const content = (
    <>
      <span className="dt-swatch" />
      {CATEGORY_LABELS[category]}
      <b>{duration(value)}</b>
      <span className="dt-breakdown-share">{percent(value, total)}</span>
    </>
  );
  const filter = CATEGORY_FILTERS[category];
  return (
    <li data-category={category}>
      {filter && filters.counts.get(filter) ? (
        <FilterChip id={filter} filters={filters}>
          {content}
        </FilterChip>
      ) : (
        content
      )}
    </li>
  );
}

/* ---------- time breakdown ---------- */

/**
 * Where the time went, and what to show: one row. A category with rows in the tree (Database, Templates, Cache…)
 * is a filter chip too; the filters with no time of their own (Logs, Errors, Signals…) follow it as plain chips.
 */
function Breakdown({ trace, filters }: { trace: Trace; filters: FilterState }) {
  const parts = breakdown(trace);
  const total = Math.max(
    parts.reduce((sum, [, value]) => sum + value, 0),
    1,
  );
  const claimed = new Set(parts.map(([category]) => CATEGORY_FILTERS[category]));
  const others = FILTERS.filter((filter) => !claimed.has(filter.id) && (filters.counts.get(filter.id) ?? 0) > 0);
  return (
    <div className="dt-breakdown">
      <div className="dt-breakdown-bar" role="img" aria-label="Where the time went">
        {parts.map(([category, value]) => (
          <span key={category} data-category={category} style={{ width: percent(value, total) }} />
        ))}
      </div>
      <ul className="dt-breakdown-legend" aria-label="Where the time went, and what to show">
        {parts.map(([category, value]) => (
          <Share key={category} category={category} value={value} total={total} filters={filters} />
        ))}
        {others.map((filter) => (
          <li key={filter.id}>
            <FilterChip id={filter.id} filters={filters}>
              {filter.label}
            </FilterChip>
          </li>
        ))}
        {filters.active.size > 0 ? (
          <li>
            <button type="button" className="dt-map-filter-clear" onClick={() => filters.onChange(new Set())}>
              Show all
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
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
  const total = Math.max(trace.duration, 1);
  const left = Math.min(Math.max(((start - trace.start) / total) * 100, 0), 100);
  return (
    <span className="dt-map-track" aria-hidden="true">
      <span
        className="dt-map-bar"
        data-point={point ? "" : undefined}
        // Clamped to the track: a task can run longer than the request that enqueued it.
        style={{
          left: `${left}%`,
          width: point ? undefined : `${Math.min(Math.max((length / total) * 100, 0.4), 100 - left)}%`,
        }}
      />
    </span>
  );
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
        <span className="dt-map-text">{node.run.name}</span>
        <TaskState state={node.run.task_state} />
        {node.kind === "call" ? <AppChip node={node} /> : null}
      </>
    ),
    track: <Bar trace={trace} start={node.run.start} length={node.run.duration} />,
    time: duration(node.run.duration),
  };
}

/** Which app served a call: its runtime's mark, and its project (another agent's) or its service (this one's). */
function AppChip({ node }: { node: Extract<Node, { type: "task" }> }) {
  const name = appName(node);
  if (!name) return null;
  const runtime = traceRuntime(node.whole?.attrs ?? {});
  return (
    <span className="dt-map-app" title={[name, runtime].filter(Boolean).join(" · ")}>
      <RuntimeMark runtime={runtime} />
      {name}
    </span>
  );
}

function appName(node: Extract<Node, { type: "task" }>): string | undefined {
  const service = node.whole?.attrs["service.name"];
  return node.remote?.project ?? (typeof service === "string" ? service : undefined);
}

function RuntimeMark({ runtime }: { runtime: string | undefined }) {
  const kind = runtime ? runtimeKind(runtime) : null;
  return kind ? <RuntimeIcon kind={kind} /> : null;
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
    >
      <span className="dt-map-name" style={indent}>
        <span className="dt-map-caret">{open === undefined ? null : <ChevronRightIcon />}</span>
        <span className="dt-map-kind">{view.kind}</span>
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

function Rows({ nodes, depth, ctx }: { nodes: Node[]; depth: number; ctx: RowContext }) {
  return (
    <>
      {nodes.map((node) => {
        const mark = ctx.marks?.get(node.key);
        if (ctx.marks && !mark) return null;
        const indent = { paddingLeft: `${12 + depth * 16}px` };
        if (node.type === "log" || node.type === "error") {
          const isError = node.type === "error";
          const time = isError ? node.error.time : node.log.time;
          const text = isError
            ? `${node.error.type.replace(/^builtins\./, "")}: ${node.error.message}`
            : node.log.message;
          return (
            <Fragment key={node.key}>
              <button
                type="button"
                className="dt-map-row"
                data-dim={mark === "path" ? "" : undefined}
                data-kind={isError ? "error" : "log"}
                data-level={isError ? "error" : node.log.level}
                aria-current={ctx.selected === node.key ? "true" : undefined}
                onClick={() => ctx.onSelect(node.key)}
              >
                <span className="dt-map-name" style={indent}>
                  <span className="dt-map-caret" />
                  <span className="dt-map-kind">{isError ? "error" : node.log.level}</span>
                  <span className="dt-map-text">{text}</span>
                </span>
                <Bar trace={ctx.trace} start={time} length={0} point={true} />
                <span className="dt-map-time" title={`Logged ${since(time, ctx.trace.start)}`}>
                  +{duration(Math.max(time - ctx.trace.start, 0))}
                </span>
              </button>
              <RowDetails id={node.key} ctx={ctx} />
            </Fragment>
          );
        }
        if (node.type === "task" || node.type === "waiting") {
          return <LinkedRow key={node.key} node={node} ctx={ctx} indent={indent} depth={depth} dim={mark === "path"} />;
        }
        if (node.type === "group") {
          const open = ctx.collapsed.has(`open:${node.key}`);
          const issue = node.spans.map((span) => ctx.issueBySpan.get(span.id)).find(Boolean);
          const first = node.spans[0];
          const total = node.spans.reduce((sum, span) => sum + span.duration, 0);
          return (
            <div key={node.key} className="dt-map-group">
              <button
                type="button"
                className="dt-map-row"
                data-dim={mark === "path" ? "" : undefined}
                data-kind={first?.kind}
                aria-expanded={open}
                aria-current={ctx.selected === node.key ? "true" : undefined}
                onClick={() => {
                  ctx.onSelect(node.key);
                  ctx.onToggle(`open:${node.key}`);
                }}
              >
                <span className="dt-map-name" style={indent}>
                  <span className="dt-map-caret">
                    <ChevronRightIcon />
                  </span>
                  <span className="dt-map-kind">{first?.kind}</span>
                  <span className="dt-map-text">{callTemplate(first)}</span>
                  <AliasChip value={first?.attrs["db.alias"] ?? first?.attrs["cache.alias"]} />
                  <span className="dt-map-times">×{node.spans.length}</span>
                  {issue ? <IssueChip kind={issue} /> : null}
                </span>
                <span className="dt-map-track" aria-hidden="true">
                  {node.spans.map((span) => (
                    <span
                      key={span.id}
                      className="dt-map-bar"
                      data-tick=""
                      style={{
                        left: `${Math.min(Math.max(((span.start - ctx.trace.start) / Math.max(ctx.trace.duration, 1)) * 100, 0), 100)}%`,
                      }}
                    />
                  ))}
                </span>
                <span className="dt-map-time">{duration(total)}</span>
              </button>
              <RowDetails id={node.key} ctx={ctx} />
              {open ? (
                <Rows
                  nodes={node.spans.map((span) => ({ type: "span", key: span.id, span, children: [] }))}
                  depth={depth + 1}
                  ctx={{ ...ctx, marks: undefined }}
                />
              ) : null}
            </div>
          );
        }
        const { span } = node;
        const hasChildren = node.children.length > 0;
        const open = hasChildren && (mark === "path" || !ctx.collapsed.has(node.key));
        const issue = ctx.issueBySpan.get(span.id);
        return (
          <div key={node.key}>
            <button
              type="button"
              className="dt-map-row"
              data-dim={mark === "path" ? "" : undefined}
              data-kind={span.kind}
              data-status={span.status}
              aria-expanded={hasChildren ? open : undefined}
              aria-current={ctx.selected === node.key ? "true" : undefined}
              onClick={() => {
                // First click selects the row (and opens it); a second click closes its details (and folds it).
                if (ctx.selected !== node.key) {
                  if (hasChildren && !open) ctx.onToggle(node.key);
                } else if (hasChildren && open) {
                  ctx.onToggle(node.key);
                }
                ctx.onSelect(node.key);
              }}
            >
              <span className="dt-map-name" style={indent}>
                <span className="dt-map-caret">{hasChildren ? <ChevronRightIcon /> : null}</span>
                <span className="dt-map-kind">{span.kind === "http" ? "request" : span.kind}</span>
                <span className="dt-map-text">{span.name}</span>
                <AliasChip value={span.attrs["db.alias"] ?? span.attrs["cache.alias"]} />
                {issue ? <IssueChip kind={issue} /> : null}
              </span>
              <Bar trace={ctx.trace} start={span.start} length={span.duration} />
              <span className="dt-map-time">{duration(span.duration)}</span>
            </button>
            <RowDetails id={node.key} ctx={ctx} />
            {open ? <Rows nodes={node.children} depth={depth + 1} ctx={ctx} /> : null}
          </div>
        );
      })}
    </>
  );
}

function TaskState({ state }: { state: string | null }) {
  if (!state) return null;
  return (
    <span className="dt-map-state" data-state={state.toLowerCase()}>
      {state.toLowerCase()}
    </span>
  );
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
  const open = links?.trace;
  return open ? (
    <a className="dt-map-open" {...linkProps(links, open(run.id))}>
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
      <PropTable rows={runRows(run, words.label)} />
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
      <PropTable rows={[{ label: "Task", value: name, copy: name, mono: true }]} />
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
  return <LogRecordDetails log={node.log} />;
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
          <PropTable rows={summaryRows(first, false)} />
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

function SpanTitle({ span, trace }: { span: Span; trace: Trace }) {
  const offset = duration(Math.max(span.start - trace.start, 0));
  return (
    <p className="dt-map-details-title">
      {span.kind === "http" ? "request" : span.kind} · started at +{offset} · took {duration(span.duration)}
    </p>
  );
}

function SpanDetails({ node: { span }, trace }: DetailsProps<"span">) {
  // The root span stands for the whole request: its details are the trace's own attributes. A call's own fields come
  // in words first (its topic, its URL, where in the code); every attribute after them, raw.
  const [attrs, summary] =
    span.parent_id === null ? [{ ...trace.attrs, ...span.attrs }, []] : [span.attrs, summaryRows(span)];
  const document = attrs["graphql.document"];
  return (
    <div className="grid gap-3 p-4">
      <SpanTitle span={span} trace={trace} />
      <Statement span={span} attrs={attrs} />
      {typeof document === "string" ? <GraphqlCode document={document} /> : null}
      {summary.length ? <PropTable rows={summary} /> : null}
      <AllAttributes attrs={attrs} titled={summary.length > 0} />
    </div>
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

function summaryRows(span: Span, origin = true): PropRow[] {
  return callFields(span, origin).map(({ label, value }) => ({ label, value, copy: value, mono: true }));
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

/** The rows the active filters keep, or undefined while none is on. */
function marksOf(tree: Node[], active: ReadonlySet<FilterId>): Map<string, Mark> | undefined {
  if (active.size === 0) return undefined;
  const found = new Map<string, Mark>();
  markTree(tree, active, found);
  return found;
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

/** The request as a call tree: what ran inside what, in order, and how long each part took. */
export function CallMap({
  trace,
  issueBySpan,
  related,
  links,
  initialSpan,
}: {
  trace: Trace;
  issueBySpan: ReadonlyMap<string, IssueKind>;
  /** Linked traces: tasks this trace enqueued appear under their enqueue span. */
  related?: Related | undefined;
  links?: TraceLinks | undefined;
  /** A span to open with its details, as a link to it asks (a log line's span). */
  initialSpan?: string | undefined;
}) {
  const tree = useMemo(() => buildTree(trace, related), [trace, related]);
  const issues = useMemo(() => withCallIssues(issueBySpan, related), [issueBySpan, related]);
  const { selected, select, close } = useSelection(initialSpan);
  const map = useRef<HTMLDivElement>(null);
  const side = useSidePane(map);
  const rows = useScrolledToInitial(initialSpan);
  const [collapsed, toggle] = useToggleSet();
  const details = detailsOf(tree, selected, trace, links);
  const [active, setActive] = useState<ReadonlySet<FilterId>>(new Set());
  const counts = useMemo(() => chipCounts(tree, trace), [tree, trace]);
  const marks = useMemo(() => marksOf(tree, active), [tree, active]);

  return (
    <div className="dt-map" ref={map}>
      <Breakdown trace={trace} filters={{ counts, active, onChange: setActive }} />
      <MapBody details={side ? details : null} onClose={close}>
        <div className="dt-map-head">
          <span>Call tree</span>
          <span>Time</span>
        </div>
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
              details: side ? null : details,
            }}
          />
        </div>
      </MapBody>
    </div>
  );
}
