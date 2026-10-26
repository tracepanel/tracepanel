import {
  type AwsCall,
  type AwsOperation,
  ago,
  type DataColumn,
  type DataSource,
  DetailsFooter,
  duration,
  NeutralTag,
} from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import { systemOfPage } from "@tracepanel/ui/lib/systems";
import { cn } from "@tracepanel/ui/lib/utils";
import { type ReactNode, useCallback } from "react";
import { useSearch } from "./data";
import { callsSection, href, type Route, traceHref } from "./routes";
import { errorCount, lastColumn, OpeningTable, p95Column } from "./tables";
import { Mono } from "./ui";

/** A search term's value, quoted when it has a space: `aws:"Secrets Manager"`. */
function term(key: string, value: string): string {
  return /[\s"]/.test(value) ? `${key}:"${value.replaceAll('"', '\\"')}"` : `${key}:${value}`;
}

/** An operation's own calls: the service and the operation, within the page's search. */
function callsOf(item: AwsOperation, q: string): string {
  return [q, term("aws", item.aws_service), term("op", item.operation)].filter(Boolean).join(" ");
}

/** A row's key, kept in the URL while it is open. */
const keyOf = (item: AwsOperation) => `${item.aws_service} ${item.operation}`;

// The system pages whose rows are one operation each: the link there narrows to it (`op:GetObject`).
const BY_OPERATION: ReadonlySet<string> = new Set(["storage", "dynamodb"]);

/**
 * The page that analyzes these calls as its system's (S3's on Storage, DynamoDB's, SQS's messages), where the AWS
 * page's own rows are not: none for the calls only this page lists.
 */
function systemPage(item: AwsOperation): { route: Route; label: string } | null {
  const system = item.system;
  if (!system || system === "aws-api") return null;
  const q = BY_OPERATION.has(system) ? term("op", item.operation) : "";
  return { route: { name: callsSection(system), q }, label: systemOfPage(system, undefined).label };
}

/** The failed calls, by error code: `NoSuchKey 3`. */
function FailedCodes({ item }: { item: AwsOperation }) {
  if (!item.errors) return <span className="text-muted-foreground">—</span>;
  const codes = item.error_codes.map((code) => `${code.code} ${code.calls}`).join(", ");
  return (
    <span className="flex min-w-0 flex-col items-end">
      <span>{item.errors}</span>
      <span className="max-w-full truncate font-normal text-sm text-muted-foreground" title={codes}>
        {codes}
      </span>
    </span>
  );
}

function OperationName({ item }: { item: AwsOperation }) {
  const place = item.called_from[0];
  return (
    <span className="flex flex-col gap-0.5">
      <Mono className="flex min-w-0 items-center gap-2 font-semibold">
        <NeutralTag title={item.aws_service}>{item.name}</NeutralTag>
        <span className="min-w-0 truncate">{item.operation}</span>
      </Mono>
      <Mono className="truncate text-base text-muted-foreground">{place?.origin}</Mono>
    </span>
  );
}

function awsColumns(items: readonly AwsOperation[]): DataColumn<AwsOperation>[] {
  return [
    { id: "name", label: "Operation", required: true, cell: (item) => <OperationName item={item} /> },
    { id: "calls", label: "Calls", width: 5.25, num: true, cell: (item) => item.calls },
    { id: "requests", label: "Requests", width: 6.75, num: true, drop: 2, cell: (item) => item.traces },
    {
      id: "failed",
      label: "Failed",
      width: 10,
      num: true,
      className: (item) => errorCount(item.errors),
      cell: (item) => <FailedCodes item={item} />,
    },
    {
      id: "retries",
      label: "Retries",
      width: 5.75,
      num: true,
      drop: 3,
      className: (item) => (item.retries ? "text-warn" : "text-muted-foreground"),
      cell: (item) => item.retries || "—",
    },
    p95Column(items),
    { id: "region", label: "Region", width: 8, drop: 4, className: "text-muted-foreground", cell: regions },
    lastColumn(),
  ];
}

function regions(item: AwsOperation): string {
  return item.regions.join(", ") || "—";
}

/** A heading over a part of an open row's details. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5" aria-label={title}>
      <h3 className="text-sm font-medium text-text-2">{title}</h3>
      {children}
    </section>
  );
}

/** Where the app makes the calls: each app's line of code, the most calls first. */
function CalledFrom({ item }: { item: AwsOperation }) {
  if (!item.called_from.length) return null;
  return (
    <Part title="Called from">
      <ul className="space-y-0.5">
        {item.called_from.map((place) => (
          <li key={`${place.service} ${place.origin}`} className="flex items-baseline gap-3">
            <span className="text-muted-foreground">{place.service}</span>
            <Mono className="min-w-0 truncate">{place.origin}</Mono>
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{place.calls}×</span>
          </li>
        ))}
      </ul>
    </Part>
  );
}

/** One call: when, what, from which app, how long, how it failed and how often it was retried; opens its trace. */
function CallLine({ call }: { call: AwsCall }) {
  const failure = call.failed ? (call.error_type ?? "failed") : null;
  return (
    <li>
      <a
        href={traceHref(call.trace_id, undefined, call.span_id)}
        className="flex items-baseline gap-3 rounded px-1 py-0.5 text-foreground no-underline hover:bg-accent"
      >
        <span className="w-16 shrink-0 text-muted-foreground tabular-nums">{ago(call.start)}</span>
        <Mono className="min-w-0 flex-1 truncate">{call.name}</Mono>
        {failure ? <span className="shrink-0 text-error">{failure}</span> : null}
        {call.retries ? <span className="shrink-0 text-warn">{call.retries} retries</span> : null}
        <span className="shrink-0 text-muted-foreground">{call.service}</span>
        <span className="w-16 shrink-0 text-right tabular-nums">{duration(call.duration)}</span>
      </a>
    </li>
  );
}

function LatestCalls({ item, q, source }: { item: AwsOperation; q: string; source: DataSource }) {
  const load = useCallback((query: string) => source.listAwsCalls(query), [source]);
  const calls = useSearch(load, callsOf(item, q), 0).data;
  return (
    <Part title="Latest calls">
      {calls ? (
        <ul className={cn("space-y-px", calls.length === 0 && "text-muted-foreground")}>
          {calls.map((call) => (
            <CallLine key={`${call.trace_id} ${call.span_id}`} call={call} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">Loading…</p>
      )}
    </Part>
  );
}

/** An open row: where the calls are made, the latest of them, and the system page that analyzes them too. */
function AwsDetails({ item, q, source }: { item: AwsOperation; q: string; source: DataSource }) {
  const page = systemPage(item);
  return (
    <>
      <CalledFrom item={item} />
      <LatestCalls item={item} q={q} source={source} />
      <DetailsFooter open={{ label: "Latest call", link: { href: traceHref(item.sample_trace) } }}>
        {page ? (
          <Button variant="outline" size="sm" asChild>
            <a href={href(page.route)}>Its N+1 and duplicates on {page.label}</a>
          </Button>
        ) : null}
      </DetailsFooter>
    </>
  );
}

/**
 * Calls to AWS by service and operation, the most time first: how many, how many failed with which code, the
 * retries, how long. A row opens to where the app makes them and their latest calls, each a way to its trace.
 */
export function AwsTable({
  items,
  q,
  source,
  open,
  onOpen,
}: {
  items: readonly AwsOperation[];
  q: string;
  source: DataSource;
  open: string | null;
  onOpen: (key: string | null) => void;
}) {
  return (
    <OpeningTable
      table="aws"
      items={items}
      columns={awsColumns(items)}
      keyOf={keyOf}
      details={(item) => <AwsDetails item={item} q={q} source={source} />}
      open={open}
      onOpen={onOpen}
    />
  );
}
