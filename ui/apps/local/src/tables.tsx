import {
  AliasChip,
  ago,
  CopyButton,
  type DataSource,
  duration,
  type EndpointRow,
  ExplainView,
  type GraphqlRow,
  IssueChip,
  type IssueRow,
  type JobRow,
  type LogRow,
  MailList,
  type MailRow,
  MethodBadge,
  type OpRow,
  RoutePath,
  type Span,
  SqlCode,
  StatusBadge,
  type TaskRow,
  type TraceSummary,
  type WebsocketRow,
} from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { Button } from "@tracepanel/ui/components/ui/button";
import { TableCell, TableRow } from "@tracepanel/ui/components/ui/table";
import { systemOfPage } from "@tracepanel/ui/lib/systems";
import { ArrowRightIcon, ListFilterIcon } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { currentPeriod, endpointGroup, go, groupRoute, href, issueRoute, traceHref, withPeriod } from "./routes";
import { graphqlOperation } from "./sections";
import { DataTable, LevelBadge, Meter, Mono, Td, Th, Tr } from "./ui";

export function TracesTable({
  items,
  selectedId,
  hrefFor,
  compact = false,
}: {
  items: readonly TraceSummary[];
  selectedId: string | null;
  /** Where a row opens: its trace page, as a link. */
  hrefFor: (id: string) => string;
  /** Narrow list beside an open trace: drops the Queries column (the trace pane shows it). */
  compact?: boolean;
}) {
  return (
    <DataTable
      dense={compact}
      head={
        <>
          <Th>Trace</Th>
          <Th num>Status</Th>
          <Th num>Duration</Th>
          {compact ? null : <Th num>Queries</Th>}
          <Th>Issues</Th>
          <Th num>When</Th>
        </>
      }
    >
      {items.map((trace) => (
        <Tr
          key={trace.id}
          selected={trace.id === selectedId}
          tone={trace.status === "error" ? "error" : trace.issues > 0 ? "warn" : undefined}
          href={hrefFor(trace.id)}
        >
          <Td>
            {graphqlOperation(trace) ? (
              <span className="flex min-w-0 items-center gap-2.5">
                <KindBadge kind="graphql" />
                <Mono className="truncate">{graphqlOperation(trace)}</Mono>
              </span>
            ) : trace.kind === "http" ? (
              <span className="flex min-w-0 items-center gap-2.5">
                <MethodBadge method={trace.method ?? trace.name.split(" ")[0]} htmx={trace.htmx} />
                <Mono className="truncate">{trace.path ?? trace.name}</Mono>
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-2.5">
                <KindBadge kind={trace.kind} />
                {/* The badge already says WS. */}
                <Mono className="truncate">
                  {trace.kind === "websocket" ? trace.name.replace(/^WS /, "") : trace.name}
                </Mono>
              </span>
            )}
          </Td>
          <Td num>
            {trace.task_state ? <TaskState state={trace.task_state} /> : <StatusBadge status={trace.http_status} />}
          </Td>
          <Td num>{duration(trace.duration)}</Td>
          {compact ? null : <Td num>{trace.queries}</Td>}
          <Td>
            <span className="flex flex-wrap gap-1">
              {(trace.issue_kinds ?? []).map((kind) => (
                <IssueChip key={kind} kind={kind} />
              ))}
            </span>
          </Td>
          <Td num className="text-muted-foreground">
            {ago(trace.start)}
          </Td>
        </Tr>
      ))}
    </DataTable>
  );
}

export function EndpointsTable({ items }: { items: readonly EndpointRow[] }) {
  const slowest = Math.max(...items.map((item) => item.p95), 1);
  return (
    <DataTable
      head={
        <>
          <Th>Endpoint</Th>
          <Th num>Calls</Th>
          <Th num>p50</Th>
          <Th>p95</Th>
          <Th num>Queries / call</Th>
          <Th num>With issues</Th>
          <Th num>Errors</Th>
          <Th num>Last</Th>
        </>
      }
    >
      {items.map((item) => (
        <Tr
          key={`${item.method} ${item.route}`}
          tone={item.errors > 0 ? "error" : item.with_issues > 0 ? "warn" : undefined}
          href={href(endpointGroup(item.method, item.route))}
        >
          <Td>
            <span className="flex items-center gap-2.5">
              <MethodBadge method={item.method} />
              <RoutePath path={item.route} />
              {item.graphql_operations > 0 ? (
                <button
                  type="button"
                  className="ml-1 rounded-md border border-brand/30 bg-brand-soft px-1.5 font-sans text-xs text-brand hover:bg-brand/15"
                  title="One URL, many GraphQL operations: see them one by one"
                  onClick={(event) => {
                    event.stopPropagation();
                    go({ name: "graphql", q: withPeriod(`route:${item.route}`, currentPeriod()) });
                  }}
                >
                  GraphQL · {item.graphql_operations} {item.graphql_operations === 1 ? "operation" : "operations"}
                </button>
              ) : null}
            </span>
          </Td>
          <Td num>{item.calls}</Td>
          <Td num>{duration(item.p50)}</Td>
          <Td>
            <Meter value={item.p95} max={slowest}>
              {duration(item.p95)}
            </Meter>
          </Td>
          <Td num>{item.avg_queries}</Td>
          <Td num className={item.with_issues ? "font-semibold text-warn" : "text-muted-foreground"}>
            {item.with_issues || "—"}
          </Td>
          <Td num className={item.errors ? "font-semibold text-error" : "text-muted-foreground"}>
            {item.errors || "—"}
          </Td>
          <Td num className="text-muted-foreground">
            {ago(item.last_seen)}
          </Td>
        </Tr>
      ))}
    </DataTable>
  );
}

/** What every page of calls lists per row: how often, in how many requests, how many failed, how long. */
type CallStats = Pick<OpRow, "calls" | "traces" | "errors" | "total" | "slowest" | "most_per_trace" | "origin">;

/** A column only one page has (the cache's hit rate). */
interface ExtraColumn<T> {
  head: string;
  cell: (item: T) => ReactNode;
}

/**
 * The table of the pages of calls (Database, Redis, Cache, HTTP calls): the same columns on each, heaviest first.
 * A row opens in place to what the page shows for it: the statement, the ways to its requests.
 */
function CallStatsTable<T extends CallStats>({
  items,
  keyOf,
  name,
  extra,
  details,
  open,
  onOpen,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  name: (item: T) => ReactNode;
  extra?: ExtraColumn<T> | undefined;
  details: (item: T) => ReactNode;
  open: string | null;
  onOpen: (key: string | null) => void;
}) {
  const heaviest = Math.max(...items.map((item) => item.total), 1);
  return (
    <DataTable
      head={
        <>
          <Th>Name</Th>
          <Th num>Calls</Th>
          <Th num>Requests</Th>
          <Th num>Max / request</Th>
          <Th num>Failed</Th>
          {extra ? <Th num>{extra.head}</Th> : null}
          <Th>Total time</Th>
          <Th num>Slowest</Th>
        </>
      }
    >
      {items.map((item) => (
        <CallStatsRow
          key={keyOf(item)}
          item={item}
          rowKey={keyOf(item)}
          name={name}
          extra={extra}
          details={details}
          heaviest={heaviest}
          open={open === keyOf(item)}
          onOpen={onOpen}
        />
      ))}
    </DataTable>
  );
}

function CallStatsRow<T extends CallStats>({
  item,
  rowKey,
  name,
  extra,
  details,
  heaviest,
  open,
  onOpen,
}: {
  item: T;
  rowKey: string;
  name: (item: T) => ReactNode;
  extra: ExtraColumn<T> | undefined;
  details: (item: T) => ReactNode;
  heaviest: number;
  open: boolean;
  onOpen: (key: string | null) => void;
}) {
  return (
    <>
      <Tr selected={open} tone={toneOf(item)} onClick={() => onOpen(open ? null : rowKey)}>
        <Td>
          <span className="flex flex-col gap-0.5">
            <Mono className="flex items-center gap-2 font-semibold">{name(item)}</Mono>
            <Mono className="text-base text-muted-foreground">{item.origin}</Mono>
          </span>
        </Td>
        <Td num>{item.calls}</Td>
        <Td num>{item.traces}</Td>
        <Td num>
          <RepeatedCount most={item.most_per_trace} />
        </Td>
        <Td num>{item.errors}</Td>
        <ExtraCell item={item} extra={extra} />
        <Td>
          <Meter value={item.total} max={heaviest}>
            {duration(item.total)}
          </Meter>
        </Td>
        <Td num>{duration(item.slowest)}</Td>
      </Tr>
      <CallStatsDetails open={open} span={extra ? 8 : 7}>
        {open ? details(item) : null}
      </CallStatsDetails>
    </>
  );
}

const toneOf = (item: CallStats) => (item.errors > 0 ? "error" : undefined);

function ExtraCell<T>({ item, extra }: { item: T; extra: ExtraColumn<T> | undefined }) {
  return extra ? <Td num>{extra.cell(item)}</Td> : null;
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

/** What an open SQL row adds: the statement and its plan. */
function SqlDetails({ item, source }: { item: OpRow; source: DataSource }) {
  const statement = item.statement ?? item.template;
  const vendor = item.vendor ?? "";
  return (
    <>
      <SqlCode sql={statement} vendor={vendor} />
      {/^\s*SELECT\b/i.test(statement) ? (
        <ExplainView vendor={vendor} load={(analyze) => source.explain(item.sample_trace, item.sample_span, analyze)} />
      ) : null}
    </>
  );
}

/** What a row is: its operation and template, where it went, and what kind of call it was (an HTTP method). */
function OpName({ item }: { item: OpRow }) {
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
const EXTRA: Partial<Record<OpRow["family"], ExtraColumn<OpRow>>> = {
  redis: { head: "Via", cell: (item) => VIA_LABELS[item.via ?? ""] ?? item.via ?? "—" },
  cache: { head: "Hit rate", cell: hitRate },
};

/** What sent a Redis command: the app itself, a cache, or a task queue publishing a task. */
const VIA_LABELS: Record<string, string> = { direct: "Direct", cache: "Cache", task: "Task queue" };

/** How often a cache's reads found their key. */
function hitRate({ hits, misses }: OpRow): string {
  const found = hits ?? 0;
  const reads = found + (misses ?? 0);
  return reads > 0 ? percentOf(found, reads) : "—";
}

function percentOf(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * One system's operations, the same table for every system: SQL, Redis, a cache, MongoDB, a broker, HTTP calls, or a
 * system the console has never heard of. An open row shows SQL's statement and plan, and the requests that made it.
 */
export function OpsTable({ items, source, open, onOpen }: TableProps<OpRow> & { source: DataSource }) {
  const family = items[0]?.family ?? "datastore";
  return (
    <CallStatsTable
      items={items}
      keyOf={(item) => item.key}
      name={(item) => <OpName item={item} />}
      extra={EXTRA[family]}
      details={(item) => (
        <>
          {item.family === "sql" ? <SqlDetails item={item} source={source} /> : null}
          <RequestLinks
            q={item.family === "sql" ? `query:${item.key}` : `op:${item.key}`}
            traces={item.traces}
            what={systemOfPage(item.system, item.family).one}
            sample={item.sample_trace}
          />
        </>
      )}
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

export function LogsTable({
  items,
  onFilter,
  open,
  onOpen,
}: {
  items: readonly LogRow[];
  /** The record shown open, by id, kept in the URL by the page. */
  open: string | null;
  onOpen: (key: string | null) => void;
  /** Narrows the current list: each key replaces the same filter in the query. */
  onFilter: (terms: Record<string, string>) => void;
}) {
  return (
    <DataTable
      head={
        <>
          <Th>Time</Th>
          <Th>Level</Th>
          <Th>Message</Th>
          <Th>Logger</Th>
          <Th>Request</Th>
        </>
      }
    >
      {items.map((log) => (
        <Fragment key={log.id}>
          <Tr
            selected={open === String(log.id)}
            tone={
              log.level === "error" || log.level === "critical" ? "error" : log.level === "warning" ? "warn" : undefined
            }
            onClick={() => onOpen(open === String(log.id) ? null : String(log.id))}
          >
            <Td className="text-muted-foreground tabular-nums">{new Date(log.time / 1000).toLocaleTimeString()}</Td>
            <Td>
              <LevelBadge level={log.level} />
            </Td>
            {/* Takes the width the other columns leave and truncates: the table never outgrows the page. */}
            <Td className="w-full max-w-0">
              <Mono className="block truncate">{log.message}</Mono>
            </Td>
            <Td>
              <Mono className="text-base text-muted-foreground">{log.logger}</Mono>
            </Td>
            <Td>
              <SourceCell
                kind={log.trace_kind}
                htmx={log.trace_htmx}
                method={log.method}
                path={log.path}
                name={log.trace_name}
              />
            </Td>
          </Tr>
          {open === String(log.id) ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={5} className="bg-muted/40 px-5 py-4 whitespace-normal">
                <LogDetails log={log} onFilter={onFilter} />
              </TableCell>
            </TableRow>
          ) : null}
        </Fragment>
      ))}
    </DataTable>
  );
}

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
function logContext(log: LogRow): LogField[] {
  const user: LogField[] = log.user_id ? [["user", log.user_id, { user: term(log.user_id) }]] : [];
  return [["app", log.service, { service: term(log.service) }], requestField(log), ...user];
}

/** "GET /api/stats/ → 200", filtering by its path; a task's or job's name as it is. */
function requestField(log: LogRow): LogField {
  if (!(log.method && log.path)) return ["request", log.trace_name];
  const status = log.http_status ? ` → ${log.http_status}` : "";
  return ["request", `${log.method} ${log.path}${status}`, { path: term(log.path) }];
}

function LogDetails({ log, onFilter }: { log: LogRow; onFilter: (terms: Record<string, string>) => void }) {
  const fields: LogField[] = [
    ...logContext(log),
    ["trace_id", log.trace_id],
    ["logger", log.logger],
    ["level", log.level],
    ["time", new Date(log.time / 1000).toISOString()],
    ...Object.entries(log.attrs).map(([key, value]): LogField => {
      const text = String(value);
      return [key, text, key.startsWith("extra.") ? { [key]: term(text) } : undefined];
    }),
  ];
  return (
    <div className="grid gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-base text-muted-foreground">Show logs from</span>
        <Button variant="outline" size="xs" onClick={() => onFilter({ trace: log.trace_id })}>
          this request
        </Button>
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
        <Button size="xs" className="ml-auto" asChild>
          <a href={traceHref(log.trace_id, "logs")}>
            Open request
            <ArrowRightIcon />
          </a>
        </Button>
      </div>
      <div className="group/message relative rounded-md border bg-background">
        <pre className="m-0 px-4 py-3 pr-12 font-mono text-base whitespace-pre-wrap">{log.message}</pre>
        <CopyButton text={log.message} label="Copy message" className="absolute top-2 right-2" />
      </div>
      {log.exception ? (
        <pre className="m-0 max-h-80 overflow-auto rounded-md border border-error/30 bg-error-soft px-4 py-3 font-mono text-sm text-foreground">
          {log.exception}
        </pre>
      ) : null}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)_auto] items-center overflow-hidden rounded-md border bg-background text-base">
        {fields.map(([key, value, filter]) => (
          <Fragment key={key}>
            <dt className="border-b px-3 py-1.5 font-mono text-muted-foreground">{key}</dt>
            <dd className="m-0 truncate border-b px-3 py-1.5 font-mono" title={value}>
              {value}
            </dd>
            <span className="flex items-center border-b px-1.5 py-1">
              {filter ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  title={`Show logs with ${key} = ${value}`}
                  aria-label={`Show logs with ${key} = ${value}`}
                  onClick={() => onFilter(filter)}
                >
                  <ListFilterIcon />
                </Button>
              ) : null}
              <CopyButton text={value} label={`Copy ${key}`} className="size-6 border-0" />
            </span>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

export function IssuesTable({ items }: { items: readonly IssueRow[] }) {
  return (
    <DataTable
      head={
        <>
          <Th>Issue</Th>
          <Th>Type</Th>
          <Th>Endpoints</Th>
          <Th num>Events</Th>
          <Th num>Last seen</Th>
          <Th num>First seen</Th>
        </>
      }
    >
      {items.map((item) => {
        const error = item.kind === "error";
        const [type, ...message] = item.title.split(": ");
        return (
          <Tr
            key={item.fingerprint}
            tone={error ? "error" : "warn"}
            href={href(issueRoute(item.fingerprint, item.kind))}
          >
            <Td className="whitespace-normal">
              <span className="flex flex-col gap-0.5">
                {error ? (
                  <span>
                    <strong className="font-semibold text-error">{type}</strong>
                    {message.length ? <span>: {message.join(": ")}</span> : null}
                  </span>
                ) : (
                  <span className="font-medium">{item.title}</span>
                )}
                {item.culprit ? <Mono className="text-base text-muted-foreground">{item.culprit}</Mono> : null}
              </span>
            </Td>
            <Td>
              <IssueChip kind={item.kind} />
            </Td>
            <Td>
              <span className="flex flex-col gap-0.5">
                {item.endpoints.slice(0, 3).map((endpoint) => (
                  <Mono key={endpoint} className="text-base">
                    {endpoint}
                  </Mono>
                ))}
                {item.endpoints.length > 3 ? (
                  <span className="text-base text-muted-foreground">+{item.endpoints.length - 3} more</span>
                ) : null}
              </span>
            </Td>
            <Td num className="font-semibold">
              {item.occurrences}
            </Td>
            <Td num className="text-muted-foreground">
              {ago(item.last_seen)}
            </Td>
            <Td num className="text-muted-foreground">
              {ago(item.first_seen)}
            </Td>
          </Tr>
        );
      })}
    </DataTable>
  );
}

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
    <DataTable
      head={
        <>
          <Th>Subject</Th>
          <Th>To</Th>
          <Th>From</Th>
          <Th>Request</Th>
          <Th num>When</Th>
        </>
      }
    >
      {items.map((mail) => (
        <Fragment key={mail.span_id}>
          <Tr
            selected={open === mail.span_id}
            tone={mail.sent === false ? "error" : undefined}
            onClick={() => onOpen(open === mail.span_id ? null : mail.span_id)}
          >
            <Td className="max-w-[26.25rem]">
              <span className="block truncate font-medium">{mail.subject || "(no subject)"}</span>
            </Td>
            <Td>
              <span className="flex flex-col gap-0.5">
                {mail.recipients.slice(0, 2).map((address) => (
                  <Mono key={address} className="text-base">
                    {address}
                  </Mono>
                ))}
                {mail.recipients.length > 2 ? (
                  <span className="text-sm text-muted-foreground">+{mail.recipients.length - 2} more</span>
                ) : null}
              </span>
            </Td>
            <Td>
              <Mono className="text-base text-muted-foreground">{mail.sender ?? "—"}</Mono>
            </Td>
            <Td>
              <SourceCell
                kind={mail.trace_kind}
                htmx={mail.trace_htmx}
                method={mail.method}
                path={mail.path}
                name={mail.trace_name}
              />
            </Td>
            <Td num className="text-muted-foreground">
              {ago(mail.time)}
            </Td>
          </Tr>
          {open === mail.span_id ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={5} className="bg-muted/40 px-5 py-4 whitespace-normal">
                <MailPreview mail={mail} source={source} />
              </TableCell>
            </TableRow>
          ) : null}
        </Fragment>
      ))}
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
          <a href={traceHref(mail.trace_id, "mail")}>
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
}: {
  kind: TraceSummary["kind"];
  htmx: TraceSummary["htmx"];
  method: string | null;
  path: string | null;
  name: string;
}) {
  const operation = graphqlOperation({ kind, name });
  return (
    // A table cell ignores max-width: the cell's content holds the limit, so a long task name truncates.
    <span className="flex max-w-[21.25rem] min-w-0 items-center gap-2">
      {operation ? (
        <KindBadge kind="graphql" />
      ) : kind === "http" ? (
        <MethodBadge method={method} htmx={htmx} />
      ) : (
        <KindBadge kind={kind} />
      )}
      <Mono className="truncate text-base">
        {operation ?? (kind === "http" ? (path ?? name) : kind === "websocket" ? name.replace(/^WS /, "") : name)}
      </Mono>
    </span>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  return (
    <Badge
      variant="outline"
      className="h-[1.375rem] rounded-md border-brand/30 bg-brand-soft px-1.5 font-mono text-2xs text-brand uppercase"
    >
      {{ command: "job", websocket: "ws", graphql: "gql" }[kind] ?? kind}
    </Badge>
  );
}

/** task.system: which queue ran the task. */
const TASK_SYSTEMS: Record<string, string> = { celery: "Celery", django: "Django Tasks" };

export function TasksTable({ items }: { items: readonly TaskRow[] }) {
  const slowest = Math.max(...items.map((item) => item.p95), 1);
  return (
    <DataTable
      head={
        <>
          <Th>Task</Th>
          <Th>System</Th>
          <Th num>Runs</Th>
          <Th num>Failed</Th>
          <Th num>Retried</Th>
          <Th>p95</Th>
          <Th num>Queue wait p95</Th>
          <Th>Queues</Th>
          <Th num>Last</Th>
        </>
      }
    >
      {items.map((item) => (
        <Tr
          key={item.task}
          tone={item.failures ? "error" : item.with_issues ? "warn" : undefined}
          href={href(groupRoute("tasks", item.task))}
        >
          <Td className="max-w-[26.25rem]">
            <Mono className="block truncate">{item.task}</Mono>
          </Td>
          <Td>
            <Badge variant="outline" className="text-xs">
              {TASK_SYSTEMS[item.system] ?? item.system}
            </Badge>
          </Td>
          <Td num>{item.runs}</Td>
          <Td num className={item.failures ? "font-semibold text-error" : "text-muted-foreground"}>
            {item.failures || "—"}
          </Td>
          <Td num className={item.retries ? "font-semibold text-warn" : "text-muted-foreground"}>
            {item.retries || "—"}
          </Td>
          <Td>
            <Meter value={item.p95} max={slowest}>
              {duration(item.p95)}
            </Meter>
          </Td>
          <Td num className={item.wait_p95 === null ? "text-muted-foreground" : ""}>
            {item.wait_p95 === null ? "eager" : duration(item.wait_p95)}
          </Td>
          <Td>
            <span className="flex flex-wrap gap-1">
              {item.queues.map((queue) => (
                <Badge key={queue} variant="outline" className="font-mono text-xs">
                  {queue}
                </Badge>
              ))}
            </span>
          </Td>
          <Td num className="text-muted-foreground">
            {ago(item.last_seen)}
          </Td>
        </Tr>
      ))}
    </DataTable>
  );
}

export function GraphqlTable({ items }: { items: readonly GraphqlRow[] }) {
  const slowest = Math.max(...items.map((item) => item.p95), 1);
  return (
    <DataTable
      head={
        <>
          <Th>Type</Th>
          <Th>Operation name</Th>
          <Th num>Calls</Th>
          <Th num>Errors</Th>
          <Th>p95</Th>
          <Th num>p50</Th>
          <Th num>Queries / call</Th>
          <Th num>Last</Th>
        </>
      }
    >
      {items.map((item) => (
        <Tr
          key={item.operation}
          tone={item.errors ? "error" : item.with_issues ? "warn" : undefined}
          href={href(groupRoute("graphql", item.operation))}
        >
          <Td>
            <Badge variant="outline" className="font-mono text-xs">
              {item.type ?? "query"}
            </Badge>
          </Td>
          <Td className="max-w-[26.25rem]">
            {item.name ? (
              <Mono className="block truncate">{item.name}</Mono>
            ) : (
              <span className="text-muted-foreground italic" title="The client sent no operationName">
                anonymous
              </span>
            )}
          </Td>
          <Td num>{item.calls}</Td>
          <Td num className={item.errors ? "font-semibold text-error" : "text-muted-foreground"}>
            {item.errors || "—"}
          </Td>
          <Td>
            <Meter value={item.p95} max={slowest}>
              {duration(item.p95)}
            </Meter>
          </Td>
          <Td num>{duration(item.p50)}</Td>
          <Td num>{item.avg_queries}</Td>
          <Td num className="text-muted-foreground">
            {ago(item.last_seen)}
          </Td>
        </Tr>
      ))}
    </DataTable>
  );
}

const JOB_SOURCES: Record<string, string> = { "manage.py": "manage.py", custom: "tracepanel.trace" };

export function JobsTable({ items }: { items: readonly JobRow[] }) {
  const slowest = Math.max(...items.map((item) => item.p95), 1);
  return (
    <DataTable
      head={
        <>
          <Th>Job</Th>
          <Th>Source</Th>
          <Th num>Runs</Th>
          <Th num>Failed</Th>
          <Th>p95</Th>
          <Th num>Queries / run</Th>
          <Th num>Last</Th>
        </>
      }
    >
      {items.map((item) => (
        <Tr
          key={item.job}
          tone={item.failures ? "error" : item.with_issues ? "warn" : undefined}
          href={href(groupRoute("jobs", item.job))}
        >
          <Td className="max-w-[26.25rem]">
            <Mono className="block truncate">{item.job}</Mono>
          </Td>
          <Td>
            <Badge variant="outline" className="font-mono text-xs">
              {JOB_SOURCES[item.source] ?? item.source}
            </Badge>
          </Td>
          <Td num>{item.runs}</Td>
          <Td num className={item.failures ? "font-semibold text-error" : "text-muted-foreground"}>
            {item.failures || "—"}
          </Td>
          <Td>
            <Meter value={item.p95} max={slowest}>
              {duration(item.p95)}
            </Meter>
          </Td>
          <Td num>{item.avg_queries}</Td>
          <Td num className="text-muted-foreground">
            {ago(item.last_seen)}
          </Td>
        </Tr>
      ))}
    </DataTable>
  );
}

export function WebsocketsTable({ items }: { items: readonly WebsocketRow[] }) {
  const slowest = Math.max(...items.map((item) => item.p95), 1);
  return (
    <DataTable
      head={
        <>
          <Th>Consumer</Th>
          <Th num>Connections</Th>
          <Th num>Received</Th>
          <Th num>From layer</Th>
          <Th num>Errors</Th>
          <Th>Handler p95</Th>
          <Th>Paths</Th>
          <Th num>Last</Th>
        </>
      }
    >
      {items.map((item) => (
        <Tr
          key={item.consumer}
          tone={item.errors ? "error" : item.with_issues ? "warn" : undefined}
          href={href(groupRoute("websockets", item.consumer))}
        >
          <Td className="max-w-[22.5rem]">
            <Mono className="block truncate">{item.consumer}</Mono>
          </Td>
          <Td num>{item.connections}</Td>
          <Td num>{item.received}</Td>
          <Td num className={item.delivered ? "" : "text-muted-foreground"}>
            {item.delivered || "—"}
          </Td>
          <Td num className={item.errors ? "font-semibold text-error" : "text-muted-foreground"}>
            {item.errors || "—"}
          </Td>
          <Td>
            <Meter value={item.p95} max={slowest}>
              {duration(item.p95)}
            </Meter>
          </Td>
          <Td className="max-w-[16.25rem]">
            <Mono className="block truncate text-muted-foreground">{item.paths.join(", ")}</Mono>
          </Td>
          <Td num className="text-muted-foreground">
            {ago(item.last_seen)}
          </Td>
        </Tr>
      ))}
    </DataTable>
  );
}

const TASK_STATE: Record<string, [string, string]> = {
  success: ["success", "border-ok/30 bg-ok-soft text-ok"],
  failure: ["failed", "border-error/30 bg-error-soft text-error"],
  retry: ["retry", "border-warn/30 bg-warn-soft text-warn"],
};

/** How a task run ended, where requests show their status code. */
export function TaskState({ state }: { state: string }) {
  const [label, tone] = TASK_STATE[state] ?? [state, ""];
  return (
    <Badge variant="outline" className={`h-[1.375rem] rounded-md px-1.5 font-mono text-2xs ${tone}`}>
      {label}
    </Badge>
  );
}
