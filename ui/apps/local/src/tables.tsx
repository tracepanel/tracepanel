import {
  AliasChip,
  ago,
  type CallRow,
  CopyButton,
  type DataColumn,
  type DataSource,
  DataTable,
  duration,
  type EndpointRow,
  ExplainView,
  type GraphqlRow,
  IssueChip,
  type IssueRow,
  type JobRow,
  KindBadge,
  type LogColumn,
  LogRecord,
  type LogRow,
  LogTable,
  MailList,
  type MailRow,
  MethodBadge,
  type PageRow,
  percent,
  RoutePath,
  type RpcRow,
  type Span,
  SqlCode,
  StateBadge,
  StatusBadge,
  TaskName,
  type TaskRow,
  type TraceSummary,
  useAttributeColumns,
  type WebsocketRow,
} from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { Button } from "@tracepanel/ui/components/ui/button";
import { TableCell, TableRow } from "@tracepanel/ui/components/ui/table";
import { systemOfPage } from "@tracepanel/ui/lib/systems";
import { cn } from "@tracepanel/ui/lib/utils";
import { ArrowRightIcon, ChevronRightIcon, Columns3Icon, ListFilterIcon } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { useCapability } from "./hooks";
import { currentPeriod, endpointGroup, go, groupRoute, href, issueRoute, traceHref, withPeriod } from "./routes";
import { graphqlOperation, taskSystem } from "./sections";
import { Meter, Mono, Tr } from "./ui";

/** What a trace is: its method and path, a GraphQL operation, or its kind and name (a task, a job, a WebSocket). */
function TraceName({ trace }: { trace: TraceSummary }) {
  const operation = graphqlOperation(trace);
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <SourceBadge kind={trace.kind} graphql={operation !== null} method={traceMethod(trace)} htmx={trace.htmx} />
      <SourceText kind={trace.kind} text={operation ?? sourceText(trace.kind, trace.path ?? null, trace.name)} />
    </span>
  );
}

function traceMethod(trace: TraceSummary): string | null {
  return trace.method ?? trace.name.split(" ")[0] ?? null;
}

// A count that says something only when there is one: in its color then, a dash otherwise.
const flagged = (tone: string) => (count: number) => (count ? `font-semibold ${tone}` : "text-muted-foreground");
const errorCount = flagged("text-error");
const warnCount = flagged("text-warn");
const MUTED = "text-muted-foreground";

const TRACE_COLUMNS: DataColumn<TraceSummary>[] = [
  { id: "trace", label: "Trace", required: true, cell: (trace) => <TraceName trace={trace} /> },
  {
    id: "status",
    label: "Status",
    width: 6.5,
    num: true,
    cell: (trace) =>
      trace.task_state ? <TaskState state={trace.task_state} /> : <StatusBadge status={trace.http_status} />,
  },
  { id: "duration", label: "Duration", width: 6.75, num: true, cell: (trace) => duration(trace.duration) },
  { id: "queries", label: "Queries", width: 6.25, num: true, cell: (trace) => trace.queries },
  {
    id: "issues",
    label: "Issues",
    width: 14,
    cell: (trace) => (
      // One line, as every row of a list: a narrow column cuts the last chips off, wider shows them.
      <span className="flex gap-1">
        {(trace.issue_kinds ?? []).map((kind) => (
          <IssueChip key={kind} kind={kind} />
        ))}
      </span>
    ),
  },
  { id: "when", label: "When", width: 6.5, num: true, className: MUTED, cell: (trace) => ago(trace.start) },
];

const traceTone = (trace: TraceSummary) => (trace.status === "error" ? "error" : trace.issues > 0 ? "warn" : undefined);

/**
 * Traces, one a row, each a link to its trace. `table` names the list, where the reader's columns are kept: the
 * search's results, an entry point's calls, a group's, an issue's.
 */
export function TracesTable({
  table,
  items,
  selectedId,
  hrefFor,
  newIds,
}: {
  table: string;
  items: readonly TraceSummary[];
  selectedId: string | null;
  /** Where a row opens: its trace page, as a link. */
  hrefFor: (id: string) => string;
  /** Rows that just arrived: highlighted for a moment. */
  newIds?: ReadonlySet<string> | undefined;
}) {
  return (
    <DataTable table={table} columns={TRACE_COLUMNS}>
      {({ cells }) =>
        items.map((trace) => (
          <Tr
            key={trace.id}
            selected={trace.id === selectedId}
            tone={traceTone(trace)}
            href={hrefFor(trace.id)}
            fresh={newIds?.has(trace.id)}
          >
            {cells(trace)}
          </Tr>
        ))
      }
    </DataTable>
  );
}

/** One URL that serves many GraphQL operations: a button to see them one by one. */
function GraphqlOperations({ item }: { item: EndpointRow }) {
  if (item.graphql_operations === 0) return null;
  return (
    <button
      type="button"
      className="ml-1 shrink-0 rounded-md border border-brand/30 bg-brand-soft px-1.5 font-sans text-xs text-brand hover:bg-brand/15"
      title="One URL, many GraphQL operations: see them one by one"
      onClick={(event) => {
        event.stopPropagation();
        go({ name: "graphql", q: withPeriod(`route:${item.route}`, currentPeriod()), view: "overview" });
      }}
    >
      GraphQL · {item.graphql_operations} {item.graphql_operations === 1 ? "operation" : "operations"}
    </button>
  );
}

/** A p95 column: a bar against the slowest of the list, the time beside it. */
function p95Column<T extends { p95: number }>(items: readonly T[], label = "p95"): DataColumn<T> {
  const slowest = Math.max(...items.map((item) => item.p95), 1);
  return {
    id: "p95",
    label,
    width: 8.5,
    cell: (item) => (
      <Meter value={item.p95} max={slowest}>
        {duration(item.p95)}
      </Meter>
    ),
  };
}

/** The Last column: when the list's item was last seen. */
function lastColumn<T extends Pick<EndpointRow, "last_seen">>(): DataColumn<T> {
  return { id: "last", label: "Last", width: 6.5, num: true, className: MUTED, cell: (item) => ago(item.last_seen) };
}

function endpointColumns(items: readonly EndpointRow[]): DataColumn<EndpointRow>[] {
  return [
    {
      id: "endpoint",
      label: "Endpoint",
      required: true,
      cell: (item) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <MethodBadge method={item.method} />
          <RoutePath path={item.route} />
          <GraphqlOperations item={item} />
        </span>
      ),
    },
    { id: "calls", label: "Calls", width: 5.25, num: true, cell: (item) => item.calls },
    { id: "p50", label: "p50", width: 6.5, num: true, cell: (item) => duration(item.p50) },
    p95Column(items),
    { id: "queries", label: "Queries / call", width: 9, num: true, cell: (item) => item.avg_queries },
    {
      id: "issues",
      label: "With issues",
      width: 7.75,
      num: true,
      className: (item) => warnCount(item.with_issues),
      cell: (item) => item.with_issues || "—",
    },
    {
      id: "errors",
      label: "Errors",
      width: 6,
      num: true,
      className: (item) => errorCount(item.errors),
      cell: (item) => item.errors || "—",
    },
    lastColumn(),
  ];
}

export function EndpointsTable({ items }: { items: readonly EndpointRow[] }) {
  return (
    <DataTable table="endpoints" columns={endpointColumns(items)}>
      {({ cells }) =>
        items.map((item) => (
          <Tr
            key={`${item.method} ${item.route}`}
            tone={countTone(item.errors, item.with_issues)}
            href={href(endpointGroup(item.method, item.route))}
          >
            {cells(item)}
          </Tr>
        ))
      }
    </DataTable>
  );
}

/** What every page of calls lists per row: how often, in how many requests, how many failed, how long. */
type CallStats = Pick<CallRow, "calls" | "traces" | "errors" | "total" | "slowest" | "most_per_trace" | "origin">;

/** A column only one page has (the cache's hit rate). */
interface ExtraColumn<T> {
  head: string;
  cell: (item: T) => ReactNode;
}

function callStatsColumns<T extends CallStats>(
  items: readonly T[],
  name: (item: T) => ReactNode,
  extra: ExtraColumn<T> | undefined,
): DataColumn<T>[] {
  const heaviest = Math.max(...items.map((item) => item.total), 1);
  const own: DataColumn<T>[] = extra
    ? [{ id: "extra", label: extra.head, width: 6.75, num: true, cell: extra.cell }]
    : [];
  return [
    {
      id: "name",
      label: "Name",
      required: true,
      cell: (item) => (
        <span className="flex flex-col gap-0.5">
          <Mono className="flex min-w-0 items-center gap-2 font-semibold">{name(item)}</Mono>
          <Mono className="truncate text-base text-muted-foreground">{item.origin}</Mono>
        </span>
      ),
    },
    { id: "calls", label: "Calls", width: 5.25, num: true, cell: (item) => item.calls },
    { id: "requests", label: "Requests", width: 6.75, num: true, cell: (item) => item.traces },
    {
      id: "repeated",
      label: "Max / request",
      width: 9,
      num: true,
      cell: (item) => <RepeatedCount most={item.most_per_trace} />,
    },
    { id: "failed", label: "Failed", width: 5.5, num: true, cell: (item) => item.errors },
    ...own,
    {
      id: "total",
      label: "Total time",
      width: 8.5,
      cell: (item) => (
        <Meter value={item.total} max={heaviest}>
          {duration(item.total)}
        </Meter>
      ),
    },
    { id: "slowest", label: "Slowest", width: 6.5, num: true, cell: (item) => duration(item.slowest) },
  ];
}

/**
 * The table of the pages of calls (Database, Redis, Cache, HTTP calls): the same columns on each, heaviest first.
 * A row opens in place to what the page shows for it: the statement, the ways to its requests. `table` keeps each
 * system's columns apart.
 */
function CallStatsTable<T extends CallStats>({
  table,
  items,
  keyOf,
  name,
  extra,
  details,
  open,
  onOpen,
}: {
  table: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  name: (item: T) => ReactNode;
  extra?: ExtraColumn<T> | undefined;
  details: (item: T) => ReactNode;
  open: string | null;
  onOpen: (key: string | null) => void;
}) {
  return (
    <DataTable table={table} columns={callStatsColumns(items, name, extra)}>
      {({ cells, span }) =>
        items.map((item) => {
          const key = keyOf(item);
          const opened = open === key;
          return (
            <Fragment key={key}>
              <Tr selected={opened} tone={toneOf(item)} onClick={() => onOpen(opened ? null : key)}>
                {cells(item)}
              </Tr>
              <CallStatsDetails open={opened} span={span}>
                {opened ? details(item) : null}
              </CallStatsDetails>
            </Fragment>
          );
        })
      }
    </DataTable>
  );
}

const toneOf = (item: CallStats) => (item.errors > 0 ? "error" : undefined);

/** A row that failed is red at its edge, one with issues amber. */
function countTone(failures: number, issues: number): "error" | "warn" | undefined {
  if (failures) return "error";
  return issues ? "warn" : undefined;
}

/** An open row's details, across the table. */
function CallStatsDetails({ open, span, children }: { open: boolean; span: number; children: ReactNode }) {
  if (!open) return null;
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={span} className="space-y-3 bg-muted/40 px-5 py-4 whitespace-normal">
        {children}
      </TableCell>
    </TableRow>
  );
}

/** "Show N requests with this …" and the latest call, under an open row. */
function RequestLinks({ q, traces, what, sample }: { q: string; traces: number; what: string; sample: string }) {
  const requests = traces === 1 ? "request" : "requests";
  return (
    <p className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" asChild>
        <a href={href({ name: "traces", q })}>
          Show {traces} {requests} with this {what}
        </a>
      </Button>
      <Button variant="ghost" size="sm" asChild>
        <a href={traceHref(sample)}>Latest {what} →</a>
      </Button>
    </p>
  );
}

interface TableProps<T> {
  items: readonly T[];
  /** The row shown open, kept in the URL by the page. */
  open: string | null;
  onOpen: (key: string | null) => void;
}

/** Whether a statement gets a plan: a SELECT, where the app behind the console runs EXPLAIN. */
function useExplains(source: DataSource, statement: string): boolean {
  return useCapability(source, "explain") && /^\s*SELECT\b/i.test(statement);
}

/** What an open SQL row adds: the statement and its plan. */
function SqlDetails({ item, source }: { item: CallRow; source: DataSource }) {
  const statement = item.statement ?? item.template;
  const vendor = item.vendor ?? "";
  const explainable = useExplains(source, statement);
  return (
    <>
      <SqlCode sql={statement} vendor={vendor} />
      {explainable ? (
        <ExplainView vendor={vendor} load={(analyze) => source.explain(item.sample_trace, item.sample_span, analyze)} />
      ) : null}
    </>
  );
}

/** What a row is: its operation and template, where it went, and what kind of call it was (an HTTP method). */
function OpName({ item }: { item: CallRow }) {
  if (item.family === "sql") {
    return (
      <>
        {item.name}
        <AliasChip value={item.target} />
      </>
    );
  }
  if (item.family === "http") {
    return (
      <>
        <MethodBadge method={item.op} />
        {item.target}
        {item.template}
      </>
    );
  }
  return (
    <>
      {item.op} {item.template}
      <AliasChip value={item.target} />
    </>
  );
}

/** The column only some families have: Redis says who sent a command, a cache how often a read found its key. */
const EXTRA: Partial<Record<CallRow["family"], ExtraColumn<CallRow>>> = {
  redis: { head: "Via", cell: (item) => VIA_LABELS[item.via ?? ""] ?? item.via ?? "—" },
  cache: { head: "Hit rate", cell: hitRate },
};

/** What sent a Redis command: the app itself, a cache, or a task queue publishing a task. */
const VIA_LABELS: Record<string, string> = { direct: "Direct", cache: "Cache", task: "Task queue" };

/** How often a cache's reads found their key. */
function hitRate({ hits, misses }: CallRow): string {
  const found = hits ?? 0;
  const reads = found + (misses ?? 0);
  return reads > 0 ? percent(found, reads) : "—";
}

/** The system a page of calls lists: its rows', or its family's name while it has none. */
function systemOf(items: readonly CallRow[], family: string): string {
  return items[0]?.system ?? family;
}

/** What an open row of a page of calls shows: SQL's statement and plan, and the requests that made the call. */
function CallDetails({ item, source }: { item: CallRow; source: DataSource }) {
  return (
    <>
      {item.family === "sql" ? <SqlDetails item={item} source={source} /> : null}
      <RequestLinks
        q={`call:${item.key}`}
        traces={item.traces}
        what={systemOfPage(item.system, item.family).one}
        sample={item.sample_trace}
      />
    </>
  );
}

/**
 * One system's operations, the same table for every system: SQL, Redis, a cache, MongoDB, a broker, HTTP calls, or a
 * system the console has never heard of. An open row shows SQL's statement and plan, and the requests that made it.
 */
export function CallsTable({ items, source, open, onOpen }: TableProps<CallRow> & { source: DataSource }) {
  const family = items[0]?.family ?? "datastore";
  return (
    <CallStatsTable
      // Each system's page keeps its own columns.
      table={`calls/${systemOf(items, family)}`}
      items={items}
      keyOf={(item) => item.key}
      name={(item) => <OpName item={item} />}
      extra={EXTRA[family]}
      details={(item) => <CallDetails item={item} source={source} />}
      open={open}
      onOpen={onOpen}
    />
  );
}

/** How many times at most in one request; flagged from 3 on, where a loop (an N+1) is the likely cause. */
function RepeatedCount({ most }: { most: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      {most >= 3 ? (
        <Badge
          variant="outline"
          className="border-warn/30 bg-warn-soft text-warn"
          title="Several times in one request: an N+1, or a duplicate"
        >
          Repeated
        </Badge>
      ) : null}
      {most}×
    </span>
  );
}

// The Logs page's own columns, after Logger: what was running when a record was logged (a request, a task, a job or
// a page), the app, the trace.
const LOG_COLUMNS: LogColumn<LogRow>[] = [
  {
    id: "source",
    label: "Source",
    width: 15.5,
    cell: (log) => (
      <SourceCell
        kind={log.trace_kind}
        htmx={log.trace_htmx}
        method={log.method}
        path={log.path}
        name={log.trace_name}
        className="max-w-none"
        compact={true}
      />
    ),
  },
  {
    id: "service",
    label: "App",
    width: 7.5,
    hidden: true,
    cell: (log) => <span className="text-muted-foreground">{log.service}</span>,
  },
  {
    id: "trace",
    label: "Trace",
    width: 9.5,
    hidden: true,
    cell: (log) => (
      <a className="font-mono text-muted-foreground hover:text-foreground" href={traceHref(log.trace_id, "logs")}>
        {log.trace_id}
      </a>
    ),
  },
];

export function LogsTable({
  items,
  onFilter,
  open,
  onOpen,
  highlight,
}: {
  items: readonly LogRow[];
  /** The search's words, marked in the messages. */
  highlight?: readonly string[];
  /** The record shown open, by id, kept in the URL by the page. */
  open: string | null;
  onOpen: (key: string | null) => void;
  /** Narrows the current list: each key replaces the same filter in the query. */
  onFilter: (terms: Record<string, string>) => void;
}) {
  return (
    // Clipped, not hidden: the header stays in view as the page scrolls.
    <div className="overflow-clip rounded-lg border bg-card">
      <LogTable
        table="logs"
        logs={items}
        keyOf={logKey}
        columns={LOG_COLUMNS}
        open={open}
        onOpen={onOpen}
        highlight={highlight}
        details={(log) => (
          <div className="px-5 py-4">
            <LogDetails log={log} onFilter={onFilter} />
          </div>
        )}
        stickyHeader={true}
        windowed={true}
      />
    </div>
  );
}

/** A record's key in the list and in the page's address: its id. */
const logKey = (log: LogRow): string => String(log.id);

/** A value as a search term: quoted when it has spaces. */
function term(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** A row of the log's details, and the filter its icon applies, if any. */
type LogField = [key: string, value: string, filter?: Record<string, string> | undefined];

/**
 * Where the record was written, from its trace: the app, the request (or task, job) and its status, the user. The
 * record carries none of it itself; the trace does, once for all of its records.
 */
/** The search a record's attribute narrows to, when it is one the search knows: an extra= field, its template. */
function attrFilter(key: string, value: string): Record<string, string> | undefined {
  if (key.startsWith("extra.")) return { [key]: term(value) };
  return key === "log.template" ? { template: term(value) } : undefined;
}

function logContext(log: LogRow): LogField[] {
  const user: LogField[] = log.user_id ? [["user", log.user_id, { user: term(log.user_id) }]] : [];
  return [["app", log.service, { service: term(log.service) }], requestField(log), ...user];
}

/** What wrote a record, by its trace's kind: a request, a task, a job, a page. */
const SOURCES: Record<string, string> = { task: "task", command: "job", page: "page", websocket: "connection" };

function sourceOf(log: LogRow): string {
  return SOURCES[log.trace_kind] ?? "request";
}

// The search key a task's or a job's records are found by: its name.
const NAMED: Record<string, "task" | "job"> = { task: "task", command: "job" };

/** "GET /api/stats/ → 200", filtering by its path; a task or a job by its name, filtering by it. */
function requestField(log: LogRow): LogField {
  const named = NAMED[log.trace_kind];
  if (named) return [named, log.trace_name, { [named]: term(log.trace_name) }];
  return log.method && log.path ? httpField(log.method, log.path, log.http_status) : [sourceOf(log), log.trace_name];
}

function httpField(method: string, path: string, status: number | null | undefined): LogField {
  return ["request", `${method} ${path}${status ? ` → ${status}` : ""}`, { path: term(path) }];
}

/** The records logged inside the same call as this one (a view, a query, a Kafka send), and inside any of its kind. */
function InsideSources({ log, onFilter }: { log: LogRow; onFilter: (terms: Record<string, string>) => void }) {
  const innermost = log.spans[0];
  if (innermost === undefined) return null;
  return (
    <>
      <Button variant="outline" size="xs" onClick={() => onFilter({ span: term(innermost.name) })}>
        this {innermost.system} call
      </Button>
      <Button variant="outline" size="xs" onClick={() => onFilter({ in: innermost.system })}>
        any {innermost.system} call
      </Button>
    </>
  );
}

/** Shortcuts to the records around this one: its trace's, every run of its task or job, its logger's, its path's. */
function LogSources({ log, onFilter }: { log: LogRow; onFilter: (terms: Record<string, string>) => void }) {
  const named = NAMED[log.trace_kind];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-base text-muted-foreground">Show logs from</span>
      <Button variant="outline" size="xs" onClick={() => onFilter({ trace: log.trace_id })}>
        this {sourceOf(log)}
      </Button>
      {named ? (
        <Button variant="outline" size="xs" onClick={() => onFilter({ [named]: log.trace_name })}>
          every run of {log.trace_name}
        </Button>
      ) : null}
      <Button variant="outline" size="xs" onClick={() => onFilter({ logger: log.logger })}>
        this logger
      </Button>
      {log.path ? (
        <Button variant="outline" size="xs" onClick={() => onFilter({ path: log.path ?? "" })}>
          this path
        </Button>
      ) : null}
      {log.user_id ? (
        <Button variant="outline" size="xs" onClick={() => onFilter({ user: log.user_id ?? "" })}>
          this user
        </Button>
      ) : null}
      <InsideSources log={log} onFilter={onFilter} />
      <span className="ml-auto flex items-center gap-1">
        <CopyButton text={JSON.stringify(log, null, 2)} label="Copy the record as JSON" />
        {/* The page's address opens this record: the URL keeps it. */}
        <CopyButton text={window.location.href} label="Copy a link to the record" icon="link" />
      </span>
      <Button size="xs" asChild>
        <a href={traceHref(log.trace_id, "logs")}>
          Open {sourceOf(log)}
          <ArrowRightIcon />
        </a>
      </Button>
    </div>
  );
}

/** The spans around a record, outermost first, each with its path from the outermost: a key no two share. */
function outward(spans: LogRow["spans"]): { path: string; span: LogRow["spans"][number] }[] {
  const reversed = [...spans].reverse();
  return reversed.map((span, depth) => ({
    path: reversed
      .slice(0, depth + 1)
      .map((around) => around.name)
      .join(" › "),
    span,
  }));
}

/**
 * Where in its trace a record was logged: the spans around it, outermost first, as one link to the call tree open at
 * the innermost.
 */
function LoggedIn({ log }: { log: LogRow }) {
  if (log.spans.length === 0) return null;
  const path = (
    <>
      {outward(log.spans).map(({ path: key, span }, index) => (
        <Fragment key={key}>
          {index > 0 ? <ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
          <KindBadge kind={span.system} muted={true} />
          <span className="max-w-80 truncate font-mono text-xs">{span.name}</span>
        </Fragment>
      ))}
    </>
  );
  return (
    <section className="flex flex-wrap items-center gap-2" aria-label="Logged inside">
      <span className="mr-1 text-base text-muted-foreground">Logged inside</span>
      {log.span_id ? (
        <a
          href={traceHref(log.trace_id, "tree", log.span_id)}
          title="Open the call tree here"
          className="inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 hover:border-brand/40 hover:bg-brand-soft"
        >
          {path}
          <ArrowRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </a>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 py-0.5">
          {path}
        </span>
      )}
    </section>
  );
}

/** A field's filter: the logs with that value. */
function FilterBy({ name, value, onFilter }: { name: string; value: string; onFilter: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="size-5 text-muted-foreground"
      title={`Show logs with ${name} = ${value}`}
      aria-label={`Show logs with ${name} = ${value}`}
      onClick={onFilter}
    >
      <ListFilterIcon />
    </Button>
  );
}

/** An attribute shown as a column of the table, or no longer: what the columns menu does, from the record. */
function AsColumn({ name }: { name: string }) {
  const columns = useAttributeColumns();
  if (columns === null) return null;
  const shown = columns.has(name);
  const label = shown ? `Hide the ${name} column` : `Show ${name} as a column`;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn("size-5", shown ? "text-brand" : "text-muted-foreground")}
      title={label}
      aria-label={label}
      aria-pressed={shown}
      onClick={() => columns.toggle(name)}
    >
      <Columns3Icon />
    </Button>
  );
}

/** The search a record's own field narrows to: its logger, its level, an attribute the search knows. */
function ownFilter(name: string, value: string): Record<string, string> | undefined {
  if (name === "logger") return { logger: term(value) };
  if (name === "level") return { level: value };
  return attrFilter(name, value);
}

function LogDetails({ log, onFilter }: { log: LogRow; onFilter: (terms: Record<string, string>) => void }) {
  const filterBy = (name: string, value: string, filter: Record<string, string> | undefined) =>
    filter ? <FilterBy key="filter" name={name} value={value} onFilter={() => onFilter(filter)} /> : null;
  const context: LogField[] = [
    ...logContext(log),
    ["trace_id", log.trace_id, { trace: log.trace_id }],
    // The span it was logged in, filtered by span_id: (the trace's call tree opens at it).
    // biome-ignore lint/style/useNamingConvention: the search's key, as the query spells it.
    ...(log.span_id ? [["span_id", log.span_id, { span_id: log.span_id }] as LogField] : []),
  ];
  return (
    <LogRecord
      log={log}
      header={
        <>
          <LogSources log={log} onFilter={onFilter} />
          <LoggedIn log={log} />
        </>
      }
      context={context.map(([name, value, filter]) => ({ name, value, actions: [filterBy(name, value, filter)] }))}
      actions={(name, value) => [
        filterBy(name, value, ownFilter(name, value)),
        name in log.attrs ? <AsColumn key="column" name={name} /> : null,
      ]}
    />
  );
}

/** An issue's title: an error's type in red and its message, the place it was raised under it. */
function IssueTitle({ item }: { item: IssueRow }) {
  const [type, ...message] = item.title.split(": ");
  return (
    <span className="flex flex-col gap-0.5">
      {item.kind === "error" ? (
        <span>
          <strong className="font-semibold text-error">{type}</strong>
          {message.length ? <span>: {message.join(": ")}</span> : null}
        </span>
      ) : (
        <span className="font-medium">{item.title}</span>
      )}
      {item.culprit ? <Mono className="text-base text-muted-foreground">{item.culprit}</Mono> : null}
    </span>
  );
}

/** Up to three of the values, one a line, and how many more there are. */
function FirstOf({ values, count }: { values: readonly string[]; count: number }) {
  return (
    <span className="flex flex-col gap-0.5">
      {values.slice(0, count).map((value) => (
        <Mono key={value} className="truncate text-base">
          {value}
        </Mono>
      ))}
      {values.length > count ? (
        <span className="text-base text-muted-foreground">+{values.length - count} more</span>
      ) : null}
    </span>
  );
}

const ISSUE_COLUMNS: DataColumn<IssueRow>[] = [
  {
    id: "issue",
    label: "Issue",
    required: true,
    // The title wraps: it is the row's reading.
    className: "whitespace-normal",
    cell: (item) => <IssueTitle item={item} />,
  },
  { id: "type", label: "Type", width: 10, cell: (item) => <IssueChip kind={item.kind} /> },
  { id: "endpoints", label: "Endpoints", width: 18, cell: (item) => <FirstOf values={item.endpoints} count={3} /> },
  {
    id: "events",
    label: "Events",
    width: 5.75,
    num: true,
    className: "font-semibold",
    cell: (item) => item.occurrences,
  },
  { id: "last", label: "Last seen", width: 7, num: true, className: MUTED, cell: (item) => ago(item.last_seen) },
  { id: "first", label: "First seen", width: 7.25, num: true, className: MUTED, cell: (item) => ago(item.first_seen) },
];

export function IssuesTable({ items }: { items: readonly IssueRow[] }) {
  return (
    <DataTable table="issues" columns={ISSUE_COLUMNS}>
      {({ cells }) =>
        items.map((item) => (
          <Tr
            key={item.fingerprint}
            tone={item.kind === "error" ? "error" : "warn"}
            href={href(issueRoute(item.fingerprint, item.kind))}
          >
            {cells(item)}
          </Tr>
        ))
      }
    </DataTable>
  );
}

const MAIL_COLUMNS: DataColumn<MailRow>[] = [
  {
    id: "subject",
    label: "Subject",
    required: true,
    cell: (mail) => <span className="block truncate font-medium">{mail.subject || "(no subject)"}</span>,
  },
  { id: "to", label: "To", width: 12, cell: (mail) => <FirstOf values={mail.recipients} count={2} /> },
  {
    id: "from",
    label: "From",
    width: 11,
    cell: (mail) => <Mono className="text-base text-muted-foreground">{mail.sender ?? "—"}</Mono>,
  },
  {
    id: "source",
    label: "Sent from",
    width: 18,
    cell: (mail) => (
      <SourceCell
        kind={mail.trace_kind}
        htmx={mail.trace_htmx}
        method={mail.method}
        path={mail.path}
        name={mail.trace_name}
        className="max-w-none"
      />
    ),
  },
  { id: "when", label: "When", width: 6.5, num: true, className: MUTED, cell: (mail) => ago(mail.time) },
];

export function MailsTable({
  items,
  source,
  open,
  onOpen,
}: {
  items: readonly MailRow[];
  source: DataSource;
  /** The email shown open, by its span, kept in the URL by the page. */
  open: string | null;
  onOpen: (key: string | null) => void;
}) {
  return (
    <DataTable table="mails" columns={MAIL_COLUMNS}>
      {({ cells, span }) =>
        items.map((mail) => (
          <Fragment key={mail.span_id}>
            <Tr
              selected={open === mail.span_id}
              tone={mail.sent === false ? "error" : undefined}
              onClick={() => onOpen(open === mail.span_id ? null : mail.span_id)}
            >
              {cells(mail)}
            </Tr>
            {open === mail.span_id ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={span} className="bg-muted/40 px-5 py-4 whitespace-normal">
                  <MailPreview mail={mail} source={source} />
                </TableCell>
              </TableRow>
            ) : null}
          </Fragment>
        ))
      }
    </DataTable>
  );
}

/** The message itself lives in its trace: load it and show the sent email. */
function MailPreview({ mail, source }: { mail: MailRow; source: DataSource }) {
  const [span, setSpan] = useState<Span | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    source.getTrace(mail.trace_id).then(
      (trace) => !cancelled && setSpan(trace?.spans.find((item) => item.id === mail.span_id) ?? null),
      () => !cancelled && setSpan(null),
    );
    return () => {
      cancelled = true;
    };
  }, [mail, source]);
  if (span === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (span === null)
    return <p className="text-sm text-muted-foreground">The request that sent it is no longer stored.</p>;
  return (
    <div className="grid gap-3">
      <MailList spans={[span]} />
      <div>
        <Button variant="outline" size="sm" asChild>
          <a href={traceHref(mail.trace_id, "tree", mail.span_id)}>
            Open request
            <ArrowRightIcon />
          </a>
        </Button>
      </div>
    </div>
  );
}

/** TASK / CMD tag where HTTP rows show their method. */
/** What a log line or an email came from: a request (method and path), a task, a job or a websocket. */
function SourceCell({
  kind,
  htmx,
  method,
  path,
  name,
  className,
  compact = false,
}: {
  kind: TraceSummary["kind"];
  htmx: TraceSummary["htmx"];
  method: string | null;
  path: string | null;
  name: string;
  /** `max-w-none` in a column of a fixed width, which holds the limit itself. */
  className?: string;
  /** The size of a dense table's cells (the logs'): the badge and the path at the text's size. */
  compact?: boolean;
}) {
  const operation = graphqlOperation({ kind, name });
  return (
    // A table cell ignores max-width: the cell's content holds the limit, so a long task name truncates.
    <span
      className={cn(
        "flex max-w-[21.25rem] min-w-0 items-center gap-2",
        compact &&
          "gap-1.5 [&_.dt-method]:min-w-0 [&_.dt-method]:px-1 [&_.dt-method]:text-2xs [&_[data-slot=badge]]:h-4 light:[&_.dt-kind]:min-w-0 light:[&_.dt-method]:px-0",
        className,
      )}
    >
      <SourceBadge kind={kind} graphql={operation !== null} method={method} htmx={htmx} />
      {/* In a dense table, the row's own size: the badge sets the path apart, not a smaller type. */}
      <SourceText
        kind={kind}
        text={operation ?? sourceText(kind, path, name)}
        className={cn(!compact && "text-base")}
      />
    </span>
  );
}

/** What a source is, at its start: an HTTP request's method, else its kind (a task, a job, a GraphQL operation). */
function SourceBadge({
  kind,
  graphql,
  method,
  htmx,
}: {
  kind: TraceSummary["kind"];
  graphql: boolean;
  method: string | null;
  htmx: TraceSummary["htmx"];
}) {
  if (graphql) return <KindBadge kind="graphql" />;
  return kind === "http" ? <MethodBadge method={method} htmx={htmx} /> : <KindBadge kind={kind} />;
}

/** A source's text after its badge, one line: a task's name cut at its start, as everywhere a task is named. */
function SourceText({ kind, text, className }: { kind: TraceSummary["kind"]; text: string; className?: string }) {
  if (kind === "task") return <TaskName name={text} className={className} />;
  return <Mono className={cn("truncate", className)}>{text}</Mono>;
}

/** A source's text: a request's path, a WebSocket's without its "WS ", anything else its name. */
function sourceText(kind: TraceSummary["kind"], path: string | null, name: string): string {
  if (kind === "http") return path ?? name;
  return kind === "websocket" ? name.replace(/^WS /, "") : name;
}

/** A name in a list's main column: one line, cut short with an ellipsis. */
const nameCell = (name: string) => <Mono className="block truncate">{name}</Mono>;

/** An outlined badge, its text in mono when it is a name (a queue, an operation's type). */
function OutlineBadge({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <Badge variant="outline" className={cn("text-xs", mono && "font-mono")}>
      {children}
    </Badge>
  );
}

function taskColumns(items: readonly TaskRow[]): DataColumn<TaskRow>[] {
  return [
    { id: "task", label: "Task", required: true, cell: (item) => <TaskName name={item.task} /> },
    {
      id: "system",
      label: "System",
      width: 7.5,
      cell: (item) => <KindBadge kind={taskSystem(item.system)} muted={true} />,
    },
    { id: "runs", label: "Runs", width: 5, num: true, cell: (item) => item.runs },
    {
      id: "failed",
      label: "Failed",
      width: 5.5,
      num: true,
      className: (item) => errorCount(item.failures),
      cell: (item) => item.failures || "—",
    },
    {
      id: "retried",
      label: "Retried",
      width: 6,
      num: true,
      className: (item) => warnCount(item.retries),
      cell: (item) => item.retries || "—",
    },
    p95Column(items),
    {
      id: "wait",
      label: "Queue wait p95",
      width: 9.25,
      num: true,
      className: (item) => (item.wait_p95 === null ? MUTED : undefined),
      cell: (item) => (item.wait_p95 === null ? "eager" : duration(item.wait_p95)),
    },
    {
      id: "queues",
      label: "Queues",
      width: 11.25,
      // In the menu, not on screen: the Queue filter says them, and the task's name keeps the room.
      hidden: true,
      cell: (item) => (
        <span className="flex gap-1">
          {item.queues.map((queue) => (
            <OutlineBadge key={queue} mono={true}>
              {queue}
            </OutlineBadge>
          ))}
        </span>
      ),
    },
    lastColumn<TaskRow>(),
  ];
}

export function TasksTable({ items }: { items: readonly TaskRow[] }) {
  return (
    <DataTable table="tasks" columns={taskColumns(items)}>
      {({ cells }) =>
        items.map((item) => (
          <Tr
            key={item.task}
            tone={countTone(item.failures, item.with_issues)}
            href={href(groupRoute("tasks", item.task))}
          >
            {cells(item)}
          </Tr>
        ))
      }
    </DataTable>
  );
}

/**
 * A GraphQL operation's name, or "anonymous" when the client sent none. A row with no type ran no operation (a
 * document that didn't parse): what the SDK named it instead (`syntax error`).
 */
function OperationName({ item }: { item: GraphqlRow }) {
  if (item.name) return nameCell(item.name);
  if (!item.type) {
    return (
      <span className="text-muted-foreground italic" title="No operation: the document didn't parse">
        {item.operation}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground italic" title="The client sent no operationName">
      anonymous
    </span>
  );
}

function graphqlColumns(items: readonly GraphqlRow[]): DataColumn<GraphqlRow>[] {
  return [
    {
      id: "type",
      label: "Type",
      // The widest type, `subscription`, whole, with room for how fonts render on other systems.
      width: 10.5,
      fixed: true,
      cell: (item) => (item.type ? <OutlineBadge mono={true}>{item.type}</OutlineBadge> : null),
    },
    { id: "operation", label: "Operation name", required: true, cell: (item) => <OperationName item={item} /> },
    { id: "calls", label: "Calls", width: 5.25, num: true, cell: (item) => item.calls },
    {
      id: "errors",
      label: "Errors",
      width: 6,
      num: true,
      className: (item) => errorCount(item.errors),
      cell: (item) => item.errors || "—",
    },
    p95Column(items),
    { id: "p50", label: "p50", width: 6.5, num: true, cell: (item) => duration(item.p50) },
    { id: "queries", label: "Queries / call", width: 9, num: true, cell: (item) => item.avg_queries },
    lastColumn(),
  ];
}

export function GraphqlTable({ items }: { items: readonly GraphqlRow[] }) {
  return (
    <DataTable table="graphql" columns={graphqlColumns(items)}>
      {({ cells }) =>
        items.map((item) => (
          <Tr
            key={item.operation}
            tone={countTone(item.errors, item.with_issues)}
            href={href(groupRoute("graphql", item.operation))}
          >
            {cells(item)}
          </Tr>
        ))
      }
    </DataTable>
  );
}

const JOB_SOURCES: Record<string, string> = { "manage.py": "manage.py", custom: "tracepanel.trace" };

/** A row of a list grouped by name (jobs, RPC methods): its name, a badge, how often it ran, failures and time. */
type NamedRow = Pick<JobRow, "failures" | "with_issues" | "p95" | "last_seen"> & {
  name: string;
  /** The first two cells, when not the name and a badge (a page and the action on it). */
  label?: ReactNode;
  badge: ReactNode;
  count: number;
  /** Queries per run or call, calls per page view. */
  average: number;
};

/** A named row's badge: a string as an outlined badge, a node (a page's action) as it is. */
function NamedBadge({ badge }: { badge: ReactNode }) {
  return typeof badge === "string" ? <OutlineBadge mono={true}>{badge}</OutlineBadge> : badge;
}

function namedColumns(head: [string, string, string, string], items: readonly NamedRow[]): DataColumn<NamedRow>[] {
  return [
    { id: "name", label: head[0], required: true, cell: (item) => item.label ?? nameCell(item.name) },
    { id: "badge", label: head[1], width: 11, cell: (item) => <NamedBadge badge={item.badge} /> },
    { id: "count", label: head[2], width: 5.5, num: true, cell: (item) => item.count },
    {
      id: "failed",
      label: "Failed",
      width: 5.5,
      num: true,
      className: (item) => errorCount(item.failures),
      cell: (item) => item.failures || "—",
    },
    p95Column(items),
    { id: "average", label: head[3], width: 8.75, num: true, cell: (item) => item.average },
    lastColumn(),
  ];
}

function NamedTable({
  section,
  head,
  items,
}: {
  section: "jobs" | "rpc" | "pages";
  /** Column titles: the name, the badge, the count, the queries. */
  head: [string, string, string, string];
  items: readonly NamedRow[];
}) {
  return (
    <DataTable table={section} columns={namedColumns(head, items)}>
      {({ cells }) =>
        items.map((item) => (
          <Tr
            key={item.name}
            tone={countTone(item.failures, item.with_issues)}
            href={href(groupRoute(section, item.name))}
          >
            {cells(item)}
          </Tr>
        ))
      }
    </DataTable>
  );
}

export function JobsTable({ items }: { items: readonly JobRow[] }) {
  const rows = items.map((item) => ({
    ...item,
    name: item.job,
    badge: JOB_SOURCES[item.source] ?? item.source,
    count: item.runs,
    average: item.avg_queries,
  }));
  return <NamedTable section="jobs" head={["Job", "Source", "Runs", "Queries / run"]} items={rows} />;
}

export function RpcTable({ items }: { items: readonly RpcRow[] }) {
  const rows = items.map((item) => ({
    ...item,
    name: item.rpc,
    badge: item.system ?? "rpc",
    count: item.calls,
    average: item.avg_queries,
  }));
  return <NamedTable section="rpc" head={["Method", "System", "Calls", "Queries / call"]} items={rows} />;
}

/** What a row of Pages is: a page's view, or an action on it with what started it (click "Save"). */
function PageAction({ item }: { item: PageRow }) {
  if (!item.action) return <span className="text-muted-foreground">view</span>;
  return (
    <span className="block truncate">
      <span className="mr-2 inline-flex align-middle">
        <MethodBadge method={item.trigger ?? "action"} />
      </span>
      {item.action.replace(/^(click|submit) /, "")}
    </span>
  );
}

/**
 * Pages and what is done on them: a page's views (its load, an SPA's route change), then its actions (a click or a
 * submit that called the API, background calls nobody started); the path once, the actions under it.
 */
export function PagesTable({ items }: { items: readonly PageRow[] }) {
  const rows = items.map((item, index) => ({
    ...item,
    label: (
      <Mono className={cn("block truncate", items[index - 1]?.page === item.page && "text-muted-foreground/50")}>
        {item.page}
      </Mono>
    ),
    badge: <PageAction item={item} />,
    average: item.avg_calls,
  }));
  return <NamedTable section="pages" head={["Page", "Action", "Count", "Calls each"]} items={rows} />;
}

function websocketColumns(items: readonly WebsocketRow[]): DataColumn<WebsocketRow>[] {
  return [
    { id: "consumer", label: "Consumer", required: true, cell: (item) => nameCell(item.consumer) },
    { id: "connections", label: "Connections", width: 8, num: true, cell: (item) => item.connections },
    { id: "received", label: "Received", width: 6.75, num: true, cell: (item) => item.received },
    {
      id: "delivered",
      label: "From layer",
      width: 7.25,
      num: true,
      className: (item) => (item.delivered ? undefined : MUTED),
      cell: (item) => item.delivered || "—",
    },
    {
      id: "errors",
      label: "Errors",
      width: 6,
      num: true,
      className: (item) => errorCount(item.errors),
      cell: (item) => item.errors || "—",
    },
    p95Column(items, "Handler p95"),
    {
      id: "paths",
      label: "Paths",
      width: 10,
      cell: (item) => <Mono className="block truncate text-muted-foreground">{item.paths.join(", ")}</Mono>,
    },
    lastColumn(),
  ];
}

export function WebsocketsTable({ items }: { items: readonly WebsocketRow[] }) {
  return (
    <DataTable table="websockets" columns={websocketColumns(items)}>
      {({ cells }) =>
        items.map((item) => (
          <Tr
            key={item.consumer}
            tone={countTone(item.errors, item.with_issues)}
            href={href(groupRoute("websockets", item.consumer))}
          >
            {cells(item)}
          </Tr>
        ))
      }
    </DataTable>
  );
}

/** How a task run ended, where requests show their status code; or where a task in flight is. */
export function TaskState({ state }: { state: string }) {
  return <StateBadge state={state} />;
}
