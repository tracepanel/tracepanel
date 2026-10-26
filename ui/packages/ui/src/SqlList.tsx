import { cn } from "@tracepanel/ui/lib/utils";
import { useMemo, useState } from "react";
import { CallLine, CallLines, CallTable, DetailsTitle, type Explain, QueryPlan, timeColumns } from "./CallTable";
import type { DataColumn } from "./DataTable";
import { duration } from "./format";
import { ListBar } from "./ListBar";
import { callFields, templatePlace } from "./lib/callFields";
import { queryFingerprint } from "./lib/fingerprint";
import { plural } from "./lib/plural";
import { linkProps, type TraceLinks } from "./links";
import { type NameValue, NameValues, RowsLookContext } from "./NameValues";
import { AliasChip, IssueChip, SectionHeading, TemplateChip, Times } from "./primitives";
import { type Segment, Segmented } from "./Segmented";
import { SqlCode } from "./SqlCode";
import type { IssueKind, Span } from "./types";

export interface SqlListProps {
  spans: readonly Span[];
  /** Issue kind per span id, to mark the queries an issue points at. */
  issueBySpan: ReadonlyMap<string, IssueKind>;
  /** Spans to highlight and expand, e.g. after "Show queries" on an issue. */
  focus?: ReadonlySet<string> | undefined;
  onExplain?: Explain | undefined;
  links?: TraceLinks | undefined;
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
  total: number;
  issue: IssueKind | undefined;
}

function groupSpans(spans: readonly Span[], issueBySpan: ReadonlyMap<string, IssueKind>): Group[] {
  const groups = new Map<string, Group>();
  for (const span of spans) {
    const key = String(span.attrs["db.fingerprint"] ?? span.name);
    const group = groups.get(key) ?? {
      key,
      name: span.name,
      statement: String(span.attrs["db.statement"] ?? span.name),
      spans: [],
      total: 0,
      issue: undefined,
    };
    group.spans.push(span);
    group.total += span.duration;
    group.issue ??= issueBySpan.get(span.id);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
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

/** Where each query of a group was made, one line each, with its time. */
function CalledFromList({ spans, focus }: { spans: readonly Span[]; focus: ReadonlySet<string> | undefined }) {
  const heading = spans.length === 1 ? "Called from" : `Called ${spans.length} times from`;
  return (
    <CallLines heading={<SectionHeading>{heading}</SectionHeading>}>
      {spans.map((span, index) => (
        <CallLine key={span.id} index={index} focused={focus?.has(span.id) ?? false} time={span.duration}>
          <CalledFrom span={span} className="truncate" />
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
  const [first] = spans;
  if (!first) return null;
  return (
    <>
      <DetailsTitle>{title}</DetailsTitle>
      <SqlCode sql={String(first.attrs["db.statement"] ?? first.name)} vendor={vendorOf(first)} />
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

type Mode = "grouped" | "timeline";

const MODES: readonly Segment<Mode>[] = [
  { id: "grouped", label: "Grouped" },
  { id: "timeline", label: "In order" },
];

function groupColumns(total: number): DataColumn<Group>[] {
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
    ...timeColumns<Group>((group) => group.total, total),
  ];
}

function orderColumns(start: number, total: number, issueBySpan: ReadonlyMap<string, IssueKind>): DataColumn<Placed>[] {
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
      cell: ({ span }) => (
        <QueryName
          name={span.name}
          count={1}
          alias={span.attrs["db.alias"]}
          from={span.attrs}
          issue={issueBySpan.get(span.id)}
        />
      ),
    },
    {
      id: "start",
      label: "Start",
      width: 6.5,
      num: true,
      drop: 2,
      className: "text-muted-foreground",
      cell: ({ span }) => `+${duration(Math.max(span.start - start, 0))}`,
    },
    ...timeColumns<Placed>((item) => item.span.duration, total),
  ];
}

/** A query in the order it ran: its place among them. */
interface Placed {
  span: Span;
  index: number;
}

export function SqlList({ spans, issueBySpan, focus, onExplain, links }: SqlListProps) {
  const [mode, setMode] = useState<Mode>("grouped");
  const groups = useMemo(() => groupSpans(spans, issueBySpan), [spans, issueBySpan]);
  const placed = useMemo(() => spans.map((span, index) => ({ span, index })), [spans]);
  const total = spans.reduce((sum, span) => sum + span.duration, 0);
  const start = Math.min(...spans.map((span) => span.start));

  if (spans.length === 0) return <p className="dt-note">No database queries in this request.</p>;

  return (
    <>
      <ListBar end={<Segmented label="Queries shown" segments={MODES} value={mode} onChange={setMode} />}>
        {plural(spans.length, "query", "queries")} · {groups.length} unique · {duration(total)}
      </ListBar>
      {mode === "grouped" ? (
        <CallTable
          table="trace-sql"
          columns={groupColumns(total)}
          items={groups}
          focus={focus}
          row={{
            key: (group) => group.key,
            focused: (group) => (focus ? group.spans.some((span) => focus.has(span.id)) : false),
            details: (group) => (
              <QueryDetails
                title={groupTitle(group)}
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
          columns={orderColumns(start, total, issueBySpan)}
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

/** An open group's first line, as the call tree's: "13 similar queries · 40 ms total". */
function groupTitle(group: Group): string {
  if (group.spans.length === 1) return `1 query · ${duration(group.total)}`;
  return `${group.spans.length} similar queries · ${duration(group.total)} total`;
}
