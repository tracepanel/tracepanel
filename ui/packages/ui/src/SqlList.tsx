import { cn } from "@tracepanel/ui/lib/utils";
import { useContext, useMemo } from "react";
import {
  CallLine,
  CallLines,
  CallTable,
  calledFrom,
  DetailsTitle,
  type Explain,
  groupTitle,
  issueOfRepeats,
  type ListTime,
  listTime,
  QueryPlan,
  type RowTime,
  rowTime,
  sameOrigin,
  timeColumns,
} from "./CallTable";
import type { DataColumn } from "./DataTable";
import { HiddenColumns } from "./DataTable";
import { duration } from "./format";
import { callFields, templatePlace } from "./lib/callFields";
import { queryFingerprint } from "./lib/fingerprint";
import { linkProps, type TraceLinks } from "./links";
import { type NameValue, NameValues, RowsLookContext } from "./NameValues";
import { AliasChip, IssueChip, SectionHeading, TemplateChip, Times } from "./primitives";
import type { Segment } from "./Segmented";
import { SqlCode } from "./SqlCode";
import { sqlLiteral } from "./sql";
import type { IssueKind, Span } from "./types";

export interface SqlListProps {
  spans: readonly Span[];
  /** Issue kind per span id, to mark the queries an issue points at. */
  issueBySpan: ReadonlyMap<string, IssueKind>;
  /** Spans to highlight and expand, e.g. after "Show queries" on an issue. */
  focus?: ReadonlySet<string> | undefined;
  onExplain?: Explain | undefined;
  links?: TraceLinks | undefined;
  /** Grouped by statement, or each query in the order it ran: the switch at the end of the tab's summary line. */
  mode: SqlMode;
  /** The queries' time on the clock, as the header and the tab write it. */
  clock: string;
}

/** "All requests with this query", where the host can list them. */
function AllRequests({ span, links }: { span: Span; links: TraceLinks | undefined }) {
  if (!links?.call) return null;
  const key = queryFingerprint(
    String(span.attrs["db.fingerprint"] ?? span.name),
    String(span.attrs["db.alias"] ?? "default"),
  );
  return (
    <a className="text-sm font-medium text-brand hover:underline" {...linkProps(links, links.call(key))}>
      All requests with this query →
    </a>
  );
}

interface Group {
  key: string;
  name: string;
  statement: string;
  spans: Span[];
  /** Its queries' time: on the clock, added up; set once the queries are grouped. */
  time: RowTime;
  issue: IssueKind | undefined;
}

const QUERY: readonly [string, string] = ["query", "queries"];

/** What groups a query with its repeats: its statement's fingerprint. */
export function sqlKey(span: Span): string {
  return String(span.attrs["db.fingerprint"] ?? span.name);
}

function groupSpans(spans: readonly Span[], issueBySpan: ReadonlyMap<string, IssueKind>): Group[] {
  const groups = new Map<string, Group>();
  for (const span of spans) {
    const key = sqlKey(span);
    const group = groups.get(key) ?? {
      key,
      name: span.name,
      statement: String(span.attrs["db.statement"] ?? span.name),
      spans: [],
      time: rowTime([]),
      issue: undefined,
    };
    group.spans.push(span);
    groups.set(key, group);
  }
  // Each row's time on the clock, as the table shows it and sorts by.
  for (const group of groups.values()) {
    group.time = rowTime(group.spans);
    group.issue = issueOfRepeats(group.spans, issueBySpan);
  }
  return [...groups.values()].sort((a, b) => b.time.clock - a.time.clock);
}

/**
 * Where a query was made: the template that made it as it rendered, if one did, and in your code, or, for a query no code of yours made (Django's admin, a library), the library
 * code that asked for it, marked as such.
 */
function CalledFrom({ span, className }: { span: Span; className?: string }) {
  if (!templatePlace(span.attrs)) return <CalledFromCode span={span} className={className} />;
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <TemplateChip attrs={span.attrs} />
      <span className="shrink-0 text-muted-foreground">rendered from</span>
      <CalledFromCode span={span} className="truncate" />
    </span>
  );
}

function CalledFromCode({ span, className }: { span: Span; className?: string | undefined }) {
  const origin = text(span.attrs["code.origin"]);
  if (origin) return <code className={cn("font-mono", className)}>{origin}</code>;
  const caller = text(span.attrs["code.caller"]);
  if (!caller) return <span className={cn("text-muted-foreground", className)}>Unknown: no caller was recorded</span>;
  return <LibraryCaller caller={caller} className={className} />;
}

/** A string attribute, or null for none or an empty one. */
function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function LibraryCaller({ caller, className }: { caller: string; className?: string | undefined }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <span
        className="shrink-0 rounded bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground"
        title="No code of yours was on the stack: this is the library code that asked for the query"
      >
        library
      </span>
      <code className="truncate font-mono text-muted-foreground" title={caller}>
        {caller}
      </code>
    </span>
  );
}

/** What a query's line says when its heading has said where it ran: what it was run with, the rows it returned. */
function rowsOf(span: Span): string | null {
  const rows = span.attrs["db.response.returned_rows"];
  const returned = rows === undefined ? null : `${rows} ${rows === 1 ? "row" : "rows"}`;
  return [paramsOf(span), returned].filter(Boolean).join(" · ") || null;
}

/** "pk_1 = 12": the values a query ran with, by name where the driver says them; none where they stay local. */
function paramsOf(span: Span): string | null {
  const values = valuesOf(span);
  return values ? `(${values.map(sqlLiteral).join(", ")})` : null;
}

/** The values a query ran with, where they were recorded (a snapshot's are dropped). */
function valuesOf(span: Span): unknown[] | undefined {
  const values = span.attrs["db.params"];
  return Array.isArray(values) && values.length > 0 ? values : undefined;
}

function namesOf(span: Span): unknown[] | undefined {
  const names = span.attrs["db.param_names"];
  return Array.isArray(names) ? names : undefined;
}

/** Where each query of a group was made, one line each, with its time. */
function CalledFromList({ spans, focus }: { spans: readonly Span[]; focus: ReadonlySet<string> | undefined }) {
  const beside = useContext(HiddenColumns) !== null;
  const oneOrigin = beside ? sameOrigin(spans) : null;
  const heading = oneOrigin
    ? calledFrom(spans.length, oneOrigin)
    : spans.length === 1
      ? "Called from"
      : `Called ${spans.length} times from`;
  const bare = beside && spans.length === 1;
  return (
    <CallLines heading={<SectionHeading>{heading}</SectionHeading>}>
      {spans.map((span, index) => (
        <CallLine key={span.id} index={index} focused={focus?.has(span.id) ?? false} time={span.duration} bare={bare}>
          {oneOrigin ? (
            <span className="text-muted-foreground">{rowsOf(span)}</span>
          ) : (
            <CalledFrom span={span} className="truncate" />
          )}
        </CallLine>
      ))}
    </CallLines>
  );
}

/** A query's fields in words, as the call tree's details list them: its database, engine, rows, server. */
function QueryFields({ span }: { span: Span }) {
  // The template it ran in is said where it was called from.
  const rows: NameValue[] = callFields({ kind: "sql", attrs: span.attrs }, false)
    .filter(({ label }) => label !== "Template")
    .map(({ label, value }) => ({ name: label, value }));
  if (rows.length === 0) return null;
  return (
    <RowsLookContext value="plain">
      <NameValues rows={rows} />
    </RowsLookContext>
  );
}

const vendorOf = (span: Span) => String(span.attrs["db.vendor"] ?? "");

/** An open row: what it is, the statement, its fields, its plan on demand, where each of its queries was made. */
function QueryDetails({
  title,
  spans,
  focus,
  onExplain,
  links,
}: {
  title: string;
  spans: readonly Span[];
  focus: ReadonlySet<string> | undefined;
  onExplain: Explain | undefined;
  links: TraceLinks | undefined;
}) {
  // Beside the tree the open row has just said how many and how long.
  const beside = useContext(HiddenColumns) !== null;
  const [first] = spans;
  if (!first) return null;
  return (
    <>
      {beside ? null : <DetailsTitle>{title}</DetailsTitle>}
      <SqlCode
        sql={String(first.attrs["db.statement"] ?? first.name)}
        vendor={vendorOf(first)}
        // One run: the values it ran with, in place.
        values={spans.length === 1 ? valuesOf(first) : undefined}
        names={spans.length === 1 ? namesOf(first) : undefined}
      />
      <QueryFields span={first} />
      <QueryPlan span={first} onExplain={onExplain} />
      <CalledFromList spans={spans} focus={focus} />
      <AllRequests span={first} links={links} />
    </>
  );
}

/** A query's name in its row: the statement in short, how many times, its alias, the template that made it, its issue. */
function QueryName({
  name,
  count,
  alias,
  from,
  issue,
}: {
  name: string;
  count: number;
  alias: unknown;
  from: Span["attrs"] | undefined;
  issue: IssueKind | undefined;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 font-mono">
      <span className="shrink-[1000] truncate">{name}</span>
      <Times count={count} />
      <AliasChip value={alias} />
      {from ? <TemplateChip attrs={from} /> : null}
      {issue ? <IssueChip kind={issue} /> : null}
    </span>
  );
}

export type SqlMode = "grouped" | "timeline";

export const SQL_MODES: readonly Segment<SqlMode>[] = [
  { id: "grouped", label: "Grouped" },
  { id: "timeline", label: "In order" },
];

function groupColumns(groups: readonly Group[], scope: ListTime): DataColumn<Group>[] {
  return [
    {
      id: "query",
      label: "Query",
      required: true,
      cell: (group) => (
        <QueryName
          name={group.name}
          count={group.spans.length}
          alias={group.spans[0]?.attrs["db.alias"]}
          from={group.spans.find((span) => templatePlace(span.attrs))?.attrs}
          issue={group.issue}
        />
      ),
    },
    ...timeColumns<Group>((group) => group.time, groups, scope, QUERY),
  ];
}

function orderColumns(
  placed: readonly Placed[],
  start: number,
  scope: ListTime,
  issueBySpan: ReadonlyMap<string, IssueKind>,
): DataColumn<Placed>[] {
  return [
    {
      id: "index",
      label: "#",
      width: 3.5,
      fixed: true,
      num: true,
      className: "text-muted-foreground",
      cell: (item) => item.index + 1,
    },
    {
      id: "query",
      label: "Query",
      required: true,
      cell: ({ span }) => {
        // What it ran with: one query run again and again tells its runs apart by their values.
        const params = paramsOf(span);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <QueryName
              name={span.name}
              count={1}
              alias={span.attrs["db.alias"]}
              from={span.attrs}
              issue={issueBySpan.get(span.id)}
            />
            {params ? <span className="dt-map-sub truncate font-mono">{params}</span> : null}
          </span>
        );
      },
    },
    {
      id: "start",
      label: "Start",
      width: 6.5,
      num: true,
      drop: 2,
      className: "text-muted-foreground",
      cell: ({ span }) => (span.start - start < 1_000 ? "+0 ms" : `+${duration(span.start - start)}`),
    },
    ...timeColumns<Placed>((item) => rowTime([item.span]), placed, scope, QUERY),
  ];
}

/** A query in the order it ran: its place among them. */
interface Placed {
  span: Span;
  index: number;
}

export function SqlList({ spans, issueBySpan, focus, onExplain, links, mode, clock }: SqlListProps) {
  const groups = useMemo(() => groupSpans(spans, issueBySpan), [spans, issueBySpan]);
  const placed = useMemo(() => spans.map((span, index) => ({ span, index })), [spans]);
  const scope = useMemo(() => listTime(spans, clock), [spans, clock]);
  const start = Math.min(...spans.map((span) => span.start));

  if (spans.length === 0) return <p className="dt-note">No database queries in this request.</p>;

  return (
    <>
      {mode === "grouped" ? (
        <CallTable
          table="trace-sql"
          columns={groupColumns(groups, scope)}
          items={groups}
          focus={focus}
          row={{
            key: (group) => group.key,
            focused: (group) => (focus ? group.spans.some((span) => focus.has(span.id)) : false),
            details: (group) => (
              <QueryDetails
                title={groupTitle(group.time, QUERY, "queries")}
                spans={group.spans}
                focus={focus}
                onExplain={onExplain}
                links={links}
              />
            ),
          }}
        />
      ) : (
        <CallTable
          table="trace-sql-order"
          columns={orderColumns(placed, start, scope, issueBySpan)}
          items={placed}
          focus={focus}
          openFocused={false}
          row={{
            key: (item) => item.span.id,
            focused: (item) => focus?.has(item.span.id) ?? false,
            details: ({ span }) => (
              <QueryDetails
                title={`query · started at +${duration(Math.max(span.start - start, 0))} · took ${duration(span.duration)}`}
                spans={[span]}
                focus={focus}
                onExplain={onExplain}
                links={links}
              />
            ),
          }}
        />
      )}
    </>
  );
}
