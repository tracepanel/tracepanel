import { useEffect, useMemo, useRef, useState } from "react";
import { duration, percent } from "./format";
import { GraphqlCode } from "./GraphqlCode";
import { ChevronRightIcon } from "./icons";
import { keyed } from "./keys";
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
 * 3+ identical leaf queries or cache calls under one parent collapse into a group shown where the first one ran,
 * even when they interleave (an N+1 in a template loop alternates between several statements).
 */
const GROUP_MIN = 3;

function isLeafCall(node: Node): node is Extract<Node, { type: "span" }> {
  return node.type === "span" && node.children.length === 0 && (node.span.kind === "sql" || node.span.kind === "cache");
}

function collapse(nodes: Node[]): Node[] {
  const byName = new Map<string, Span[]>();
  for (const node of nodes) {
    if (isLeafCall(node))
      byName.set(`${node.span.kind}:${node.span.name}`, [
        ...(byName.get(`${node.span.kind}:${node.span.name}`) ?? []),
        node.span,
      ]);
  }
  const result: Node[] = [];
  const emitted = new Set<string>();
  for (const node of nodes) {
    if (isLeafCall(node)) {
      const name = `${node.span.kind}:${node.span.name}`;
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
  { id: "cache", label: "Cache", kinds: ["cache"] },
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

type Category = "django" | "view" | "code" | "template" | "sql" | "cache" | "mail";

const CATEGORY_LABELS: Record<Category, string> = {
  django: "Framework & middleware",
  view: "View code",
  code: "Your code",
  template: "Templates",
  sql: "Database",
  cache: "Cache",
  mail: "Email",
};

function categoryOf(span: Span): Category | null {
  if (span.kind === "sql") return "sql";
  if (span.kind === "cache") return "cache";
  if (span.kind === "mail") return "mail";
  if (span.kind === "template") return "template";
  if (span.kind === "view") return "view";
  // A task or command root is the user's own code; so are spans they add with tracepanel.span().
  if (span.kind === "function" || span.kind === "task.run" || span.kind === "command") return "code";
  // An API framework's own steps (Django Ninja's auth, input validation, response serialization).
  if (span.parent_id === null || span.kind === "middleware" || span.kind === "framework") return "django";
  return null;
}

/**
 * Where the wall-clock time went, per category. Each moment of the trace counts once, for the deepest span
 * running then: concurrent spans (async resolvers, asyncio.gather) can't add up to more than the trace took.
 */
function breakdown(trace: Trace): [Category, number][] {
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  const depths = new Map<string, number>();
  const depth = (span: Span): number => {
    const known = depths.get(span.id);
    if (known !== undefined) return known;
    const parent = span.parent_id ? byId.get(span.parent_id) : undefined;
    const value = parent ? depth(parent) + 1 : 0;
    depths.set(span.id, value);
    return value;
  };
  // A span without a category of its own (a transaction: the code inside atomic(), a signal…) is its owner's time.
  const owner = (span: Span): Category | null => {
    let current: Span | undefined = span;
    while (current) {
      const category = current.kind === "transaction" ? null : categoryOf(current);
      if (category) return category;
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return null;
  };
  const spans = trace.spans.filter((span) => span.duration > 0);
  const edges = [...new Set(spans.flatMap((span) => [span.start, span.start + span.duration]))].sort((a, b) => a - b);
  const totals = new Map<Category, number>();
  for (let index = 0; index + 1 < edges.length; index++) {
    const from = edges[index] ?? 0;
    const to = edges[index + 1] ?? from;
    let innermost: Span | undefined;
    for (const span of spans) {
      if (span.start > from || span.start + span.duration < to) continue;
      if (
        !innermost ||
        depth(span) > depth(innermost) ||
        (depth(span) === depth(innermost) && span.start > innermost.start)
      ) {
        innermost = span;
      }
    }
    const category = innermost ? owner(innermost) : null;
    if (category) totals.set(category, (totals.get(category) ?? 0) + (to - from));
  }
  return (Object.keys(CATEGORY_LABELS) as Category[])
    .map((category): [Category, number] => [category, totals.get(category) ?? 0])
    .filter(([, value]) => value > 0);
}

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
            <button
              key={node.key}
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
          );
        }
        if (node.type === "task" || node.type === "waiting") {
          const after = (node.type === "task" ? node.run.start : node.span.start) - ctx.trace.start;
          return (
            <button
              key={node.key}
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
                  <span className="dt-map-text">{first?.name}</span>
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
      <div className="mx-4 mt-3 mb-4 grid gap-3 rounded-lg border bg-card p-4">
        <p className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
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
      <div className="mx-4 mt-3 mb-4 grid gap-3 rounded-lg border bg-card p-4">
        <p className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
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
      <div className="mx-4 mt-3 mb-4 grid gap-3 rounded-lg border bg-card p-4">
        <p className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Error</p>
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
      <div className="mx-4 mt-3 mb-4 grid gap-3 rounded-lg border bg-card p-4">
        <p className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          {node.spans.length} similar {first?.kind === "cache" ? "cache calls" : "queries"} ·{" "}
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
    <div className="mx-4 mt-3 mb-4 grid gap-3 rounded-lg border bg-card p-4">
      <p className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
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

/* ---------- component ---------- */

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
  const [selected, setSelected] = useState<string | null>(initialSpan ?? null);
  const rows = useRef<HTMLDivElement>(null);
  // Brought into view once, when a link opened the tree on it.
  useEffect(() => {
    if (initialSpan) rows.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
  }, [initialSpan]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Clicking the selected row again closes its details.
  const select = (key: string) => setSelected((current) => (current === key ? null : key));
  const node = selected ? findNode(tree, selected) : undefined;
  const [active, setActive] = useState<ReadonlySet<FilterId>>(new Set());
  const counts = useMemo(() => countFilters(tree), [tree]);
  const marks = useMemo(() => {
    if (active.size === 0) return undefined;
    const found = new Map<string, Mark>();
    markTree(tree, active, found);
    return found;
  }, [tree, active]);

  return (
    <div className="dt-map">
      <Breakdown trace={trace} />
      <Filters counts={counts} active={active} onChange={setActive} />
      <div className="dt-map-head">
        <span>Call tree</span>
        <span>Time</span>
      </div>
      <div className="dt-map-rows" ref={rows}>
        <Rows
          nodes={tree}
          depth={0}
          ctx={{ trace, issueBySpan, selected, onSelect: select, collapsed, onToggle: toggle, marks }}
        />
      </div>
      {node ? (
        <Details node={node} trace={trace} links={links} />
      ) : (
        <p className="dt-map-hint">Select a row to see its details.</p>
      )}
    </div>
  );
}
