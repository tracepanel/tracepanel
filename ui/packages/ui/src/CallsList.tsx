import { useMemo } from "react";
import {
  CallLine,
  CallLines,
  CallTable,
  DetailsTitle,
  groupTitle,
  type RowTime,
  rowTime,
  timeColumns,
} from "./CallTable";
import type { DataColumn } from "./DataTable";
import { callAnswer } from "./lib/callAnswer";
import { callTemplate, groupNoun, onTheClock } from "./lib/calls";
import { IssueChip, MethodBadge, SectionHeading, StatusBadge, Times } from "./primitives";
import type { IssueKind, Span } from "./types";

export interface CallsListProps {
  /** The request's calls to one system: HTTP calls, Redis commands, MongoDB commands… */
  spans: readonly Span[];
  /** Issue kind per span id, to mark the calls an issue points at. */
  issueBySpan: ReadonlyMap<string, IssueKind>;
  /** Spans to highlight and expand, e.g. after "Show calls" on an issue. */
  focus?: ReadonlySet<string> | undefined;
  /** Where the reader's columns are kept: one key per tab (`trace-cache`, `trace-http`). */
  table?: string | undefined;
}

interface Group {
  template: string;
  spans: Span[];
  /** Its calls' time: on the clock, added up; set once the calls are grouped. */
  time: RowTime;
  issue: IssueKind | undefined;
  /** One of its calls failed: the row has the red edge a failed request's has in a list. */
  failed: boolean;
}

const HTTP_METHOD = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT) (.+)$/;

/** A call failed: an error, a 5xx answer, or none. */
function failed(span: Span): boolean {
  return span.status === "error" || callAnswer(span).tone === "error";
}

/** What a group repeats: an HTTP call's method in its badge, as every list shows a request's, then the rest. */
function Template({ template }: { template: string }) {
  const http = HTTP_METHOD.exec(template);
  if (!http) return <span className="shrink-[1000] truncate font-mono">{template}</span>;
  return (
    <span className="flex min-w-0 shrink-[1000] items-center gap-2.5">
      <MethodBadge method={http[1]} /> <span className="truncate font-mono">{http[2]}</span>
    </span>
  );
}

/** A group with one more of its calls: its time, its issue, whether one failed. */
function withCall(group: Group, span: Span, issue: IssueKind | undefined): Group {
  group.spans.push(span);
  group.issue ??= issue;
  group.failed ||= failed(span);
  return group;
}

/** The calls by what they are a repeat of (`GET api.example.com/users/{id}`), the longest on the clock first. */
function groupCalls(spans: readonly Span[], issueBySpan: ReadonlyMap<string, IssueKind>): Group[] {
  const groups = new Map<string, Group>();
  for (const span of spans) {
    const template = callTemplate(span);
    const group = groups.get(template) ?? { template, spans: [], time: rowTime([]), issue: undefined, failed: false };
    groups.set(template, withCall(group, span, issueBySpan.get(span.id)));
  }
  // Each row's time on the clock, as the table shows it and sorts by.
  for (const group of groups.values()) group.time = rowTime(group.spans);
  return [...groups.values()].sort((a, b) => b.time.clock - a.time.clock);
}

/** One call's outcome: its HTTP status as every list shows one, else whether it failed. */
function Status({ span }: { span: Span }) {
  const { status, tone } = callAnswer(span);
  if (status !== null) return <StatusBadge status={status} />;
  return tone === "error" ? <span className="text-destructive">failed</span> : <span>—</span>;
}

/** Where a call's text is: an HTTP call's URL, a command or statement. */
const TEXT_ATTRS = ["url.full", "db.statement"];

/** What a call's row shows, as text: its URL or command, where it was made, why it failed. */
function textsOf(span: Span): { url: string; origin: string; failure: string } {
  const attrs = span.attrs;
  return {
    url: String(TEXT_ATTRS.map((key) => attrs[key]).find((value) => value !== undefined) ?? span.name),
    origin: String(attrs["code.origin"] ?? "—"),
    failure: String(attrs["error.type"] ?? ""),
  };
}

function Call({ span, index, focused }: { span: Span; index: number; focused: boolean }) {
  const { url, origin, failure } = textsOf(span);
  return (
    <CallLine index={index} focused={focused} time={span.duration}>
      <span className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] items-center gap-3">
        <span className="font-mono tabular-nums" title={failure}>
          <Status span={span} />
        </span>
        <span className="grid min-w-0">
          <code className="truncate font-mono">{url}</code>
          <code className="truncate font-mono text-muted-foreground">{origin}</code>
        </span>
      </span>
    </CallLine>
  );
}

/** A group's name in its row: what its calls repeat, how many, its issue. */
function GroupName({ group }: { group: Group }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Template template={group.template} />
      <Times count={group.spans.length} />
      {group.issue ? <IssueChip kind={group.issue} /> : null}
    </span>
  );
}

function columns(scope: number, noun: readonly [string, string]): DataColumn<Group>[] {
  return [
    { id: "call", label: "Call", required: true, cell: (group) => <GroupName group={group} /> },
    ...timeColumns<Group>((group) => group.time, scope, noun),
  ];
}

/** What the system's calls are called, one and many: "HTTP call", "HTTP calls". */
function nounOf(span: Span | undefined): [string, string] {
  return [groupNoun(span, 1), groupNoun(span)];
}

/** An open group: what it is, as the call tree's details say it, then each of its calls. */
function GroupDetails({ group, focus }: { group: Group; focus: ReadonlySet<string> | undefined }) {
  const [first] = group.spans;
  const count = group.spans.length;
  const title = groupTitle(group.time, nounOf(first), groupNoun(first));
  return (
    <>
      <DetailsTitle>{title}</DetailsTitle>
      <CallLines heading={<SectionHeading>{count === 1 ? "Call" : `${count} calls`}</SectionHeading>}>
        {group.spans.map((span, index) => (
          <Call key={span.id} span={span} index={index} focused={focus?.has(span.id) ?? false} />
        ))}
      </CallLines>
    </>
  );
}

/** One system's calls, grouped by what they repeat (an endpoint, a key pattern) like queries by statement. */
export function CallsList({ spans, issueBySpan, focus, table = "trace-calls" }: CallsListProps) {
  const groups = useMemo(() => groupCalls(spans, issueBySpan), [spans, issueBySpan]);
  const scope = useMemo(() => onTheClock(spans), [spans]);
  if (spans.length === 0) return <p className="dt-note">No calls of this kind in this request.</p>;
  return (
    <CallTable
      table={table}
      columns={columns(scope, nounOf(spans[0]))}
      items={groups}
      focus={focus}
      row={{
        key: (group) => group.template,
        failed: (group) => group.failed,
        focused: (group) => (focus ? group.spans.some((span) => focus.has(span.id)) : false),
        details: (group) => <GroupDetails group={group} focus={focus} />,
      }}
    />
  );
}
