import { Fragment, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { duration, percent } from "./format";
import { GraphqlCode } from "./GraphqlCode";
import { ChevronRightIcon, CloseIcon } from "./icons";
import { keyed } from "./keys";
import { breakdown, CATEGORY_LABELS } from "./lib/breakdown";
import { callTemplate, groupNoun } from "./lib/calls";
import { CALL_KINDS, DATASTORES, MESSAGING, RPC } from "./lib/systems";
import { linkProps, type TraceLinks } from "./links";
import { PropTable } from "./PropTable";
import { AliasChip, IssueChip } from "./primitives";
import { SqlCode } from "./SqlCode";
import type { IssueKind, Log, Related, Span, Trace, TraceError, TraceSummary } from "./types";

/* ---------- tree ---------- */

type Node =
  | { type: "span"; key: string; span: Span; children: Node[] }
  | { type: "group"; key: string; spans: Span[]; start: number; end: number }
  | { type: "log"; key: string; log: Log }
  | { type: "error"; key: string; error: TraceError }
  // A task this trace enqueued, under its task.enqueue span: run in a worker (a trace of its own) or still waiting.
  | { type: "task"; key: string; run: TraceSummary }
  | { type: "waiting"; key: string; span: Span };

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

function buildTree(trace: Trace, related: Related | undefined): Node[] {
  const children = new Map<string | null, Node[]>();
  const push = (parent: string | null, node: Node) => children.set(parent, [...(children.get(parent) ?? []), node]);
  for (const span of trace.spans) push(span.parent_id, { type: "span", key: span.id, span, children: [] });
  // Tasks go under the span that enqueued them; an enqueue with no run yet is waiting for a worker.
  const enqueuedBy = new Set<string>();
  for (const run of related?.enqueued ?? []) {
    const span = related?.via[run.id];
    if (!span) continue;
    enqueuedBy.add(span);
    push(span, { type: "task", key: `task:${run.id}`, run });
  }
  if (related) {
    for (const span of trace.spans) {
      if (span.kind === "task.enqueue" && !enqueuedBy.has(span.id)) {
        push(span.id, { type: "waiting", key: `waiting:${span.id}`, span });
      }
    }
  }
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
  if (node.type === "task" || node.type === "waiting") return "task";
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
    const below = node.type === "span" ? markTree(node.children, active, marks) : false;
    if (matches) marks.set(node.key, "match");
    else if (below) marks.set(node.key, "path");
    any = any || matches || below;
  }
  return any;
}

type Mark = "match" | "path";

function Filters({
  counts,
  active,
  onChange,
}: {
  counts: ReadonlyMap<FilterId, number>;
  active: ReadonlySet<FilterId>;
  onChange: (next: ReadonlySet<FilterId>) => void;
}) {
  const shown = FILTERS.filter((filter) => (counts.get(filter.id) ?? 0) > 0);
  if (shown.length < 2 && active.size === 0) return null;
  return (
    <fieldset className="dt-map-filters" aria-label="Show only">
      {shown.map((filter) => (
        <button
          key={filter.id}
          type="button"
          className="dt-map-filter"
          aria-pressed={active.has(filter.id)}
          onClick={() => {
            const next = new Set(active);
            if (next.has(filter.id)) next.delete(filter.id);
            else next.add(filter.id);
            onChange(next);
          }}
        >
          {filter.label}
          <span>{counts.get(filter.id)}</span>
        </button>
      ))}
      {active.size > 0 ? (
        <button type="button" className="dt-map-filter-clear" onClick={() => onChange(new Set())}>
          Show all
        </button>
      ) : null}
    </fieldset>
  );
}

/* ---------- time breakdown ---------- */

function Breakdown({ trace }: { trace: Trace }) {
  const parts = breakdown(trace);
  const total = Math.max(
    parts.reduce((sum, [, value]) => sum + value, 0),
    1,
  );
  return (
    <div className="dt-breakdown">
      <div className="dt-breakdown-bar" role="img" aria-label="Where the time went">
        {parts.map(([category, value]) => (
          <span key={category} data-category={category} style={{ width: percent(value, total) }} />
        ))}
      </div>
      <ul className="dt-breakdown-legend">
        {parts.map(([category, value]) => (
          <li key={category} data-category={category}>
            <span className="dt-swatch" />
            {CATEGORY_LABELS[category]}
            <b>{duration(value)}</b>
            <span className="dt-breakdown-share">{percent(value, total)}</span>
          </li>
        ))}
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
                <span className="dt-map-time">+{duration(Math.max(time - ctx.trace.start, 0))}</span>
              </button>
              <RowDetails id={node.key} ctx={ctx} />
            </Fragment>
          );
        }
        if (node.type === "task" || node.type === "waiting") {
          const after = (node.type === "task" ? node.run.start : node.span.start) - ctx.trace.start;
          return (
            <Fragment key={node.key}>
              <button
                type="button"
                className="dt-map-row"
                data-dim={mark === "path" ? "" : undefined}
                data-kind="task"
                data-status={node.type === "task" ? node.run.status : undefined}
                aria-current={ctx.selected === node.key ? "true" : undefined}
                onClick={() => ctx.onSelect(node.key)}
              >
                <span className="dt-map-name" style={indent}>
                  <span className="dt-map-caret" />
                  <span className="dt-map-kind">task</span>
                  {node.type === "task" ? (
                    <>
                      <span className="dt-map-text">{node.run.name}</span>
                      <TaskState state={node.run.task_state} />
                    </>
                  ) : (
                    <span className="dt-map-text dt-map-waiting">waiting for a worker…</span>
                  )}
                </span>
                {node.type === "task" ? (
                  <Bar trace={ctx.trace} start={node.run.start} length={node.run.duration} />
                ) : (
                  <span className="dt-map-track" aria-hidden="true" />
                )}
                <span className="dt-map-time">
                  {node.type === "task" ? duration(node.run.duration) : `+${duration(Math.max(after, 0))}`}
                </span>
              </button>
              <RowDetails id={node.key} ctx={ctx} />
            </Fragment>
          );
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

function findNode(nodes: Node[], key: string): Node | undefined {
  for (const node of nodes) {
    if (node.key === key) return node;
    if (node.type === "group") {
      const span = node.spans.find((item) => item.id === key);
      if (span) return { type: "span", key: span.id, span, children: [] };
    }
    if (node.type === "span") {
      const found = findNode(node.children, key);
      if (found) return found;
    }
  }
  return undefined;
}

function Details({ node, trace, links }: { node: Node; trace: Trace; links?: TraceLinks | undefined }) {
  if (node.type === "task" || node.type === "waiting") {
    const run = node.type === "task" ? node.run : null;
    const name =
      run?.name ?? (node.type === "waiting" ? String(node.span.attrs["task.name"] ?? node.span.name) : "task");
    return (
      <div className="grid gap-3 p-4">
        <p className="dt-map-details-title">
          task ·{" "}
          {run
            ? `started ${duration(Math.max(run.start - trace.start, 0))} after this request · took ${duration(run.duration)}`
            : "enqueued, not run yet"}
        </p>
        <PropTable
          rows={[
            { label: "Task", value: name, copy: name, mono: true },
            ...(run?.task_state ? [{ label: "State", value: <TaskState state={run.task_state} /> }] : []),
            ...(run ? [{ label: "Queries", value: String(run.queries) }] : []),
            ...(run?.issues ? [{ label: "Issues", value: String(run.issues) }] : []),
          ]}
        />
        {run && links?.trace ? (
          <a className="dt-map-open" {...linkProps(links, links.trace(run.id))}>
            Open the task's trace →
          </a>
        ) : null}
        {run ? null : (
          <p className="text-sm text-muted-foreground">
            It shows up here once a worker has run it (is a worker running?).
          </p>
        )}
      </div>
    );
  }
  if (node.type === "log") {
    return (
      <div className="grid gap-3 p-4">
        <p className="dt-map-details-title">
          Log · {node.log.level} · {node.log.logger}
        </p>
        <pre className="m-0 overflow-auto rounded-md border bg-muted/60 px-4 py-3 font-mono text-sm whitespace-pre-wrap">
          {node.log.exception ? `${node.log.message}\n\n${node.log.exception}` : node.log.message}
        </pre>
      </div>
    );
  }
  if (node.type === "error") {
    return (
      <div className="grid gap-3 p-4">
        <p className="dt-map-details-title">Error</p>
        <p className="dt-error-message">
          <b>{node.error.type.replace(/^builtins\./, "")}</b>: {node.error.message}
        </p>
      </div>
    );
  }
  if (node.type === "group") {
    const first = node.spans[0];
    const origins = new Set(node.spans.map((span) => String(span.attrs["code.origin"] ?? "")));
    return (
      <div className="grid gap-3 p-4">
        <p className="dt-map-details-title">
          {node.spans.length} similar {groupNoun(first)} ·{" "}
          {duration(node.spans.reduce((sum, span) => sum + span.duration, 0))} total
        </p>
        {first?.kind === "sql" ? (
          <SqlCode sql={String(first.attrs["db.statement"] ?? "")} vendor={String(first.attrs["db.vendor"] ?? "")} />
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
  const { span } = node;
  // The root span stands for the whole request: its details are the trace's own attributes.
  const attrs = span.parent_id === null ? { ...trace.attrs, ...span.attrs } : span.attrs;
  // The statement is shown formatted above; its fingerprint would repeat it on one line.
  const hidden = new Set(["db.statement", "db.fingerprint", "graphql.document"]);
  const shown = Object.entries(attrs).filter(([key, value]) => !hidden.has(key) && value !== null && value !== "");
  const offset = duration(Math.max(span.start - trace.start, 0));
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">
        {span.kind === "http" ? "request" : span.kind} · started at +{offset} · took {duration(span.duration)}
      </p>
      {span.kind === "sql" ? (
        <SqlCode sql={String(attrs["db.statement"] ?? span.name)} vendor={String(attrs["db.vendor"] ?? "")} />
      ) : null}
      {typeof attrs["graphql.document"] === "string" ? <GraphqlCode document={attrs["graphql.document"]} /> : null}
      {shown.length === 0 ? null : (
        <PropTable
          rows={shown.map(([key, value]) => ({ label: key, value: String(value), copy: String(value), mono: true }))}
        />
      )}
    </div>
  );
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
function SidePane({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <aside className="dt-map-side" aria-label="Details">
      <button type="button" className="dt-map-side-close" aria-label="Close the details" onClick={onClose}>
        <CloseIcon />
      </button>
      {children}
    </aside>
  );
}

/** The tree, and its details beside it while it is wide enough. */
function MapBody({ details, onClose, children }: { details: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div className="dt-map-body" data-side={details ? "" : undefined}>
      <div className="dt-map-tree">{children}</div>
      {details ? <SidePane onClose={onClose}>{details}</SidePane> : null}
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
  const node = selected ? findNode(tree, selected) : undefined;
  return node ? <Details node={node} trace={trace} links={links} /> : null;
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
      <Breakdown trace={trace} />
      <Filters counts={counts} active={active} onChange={setActive} />
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
              issueBySpan,
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
