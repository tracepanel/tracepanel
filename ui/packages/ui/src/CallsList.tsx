import { useContext, useMemo } from "react";
import {
  CallLine,
  CallLines,
  CallTable,
  calledFrom,
  DetailsTitle,
  groupTitle,
  issueOfRepeats,
  type ListTime,
  listTime,
  type RowTime,
  rowTime,
  sameOrigin,
  timeColumns,
} from "./CallTable";
import type { DataColumn } from "./DataTable";
import { HiddenColumns } from "./DataTable";
import { callAnswer, type GroupAnswer, groupAnswer } from "./lib/callAnswer";
import { callTemplate, groupNoun } from "./lib/calls";
import { cn } from "./lib/utils";
import { GroupStatus, IssueChip, MethodBadge, SectionHeading, StatusBadge, Times } from "./primitives";
import type { IssueKind, Span } from "./types";
import { GroupNotTraced, NotTraced } from "./Untraced";

export interface CallsListProps {
  /** The request's calls to one system: HTTP calls, Redis commands, MongoDB commands… */
  spans: readonly Span[];
  /** Issue kind per span id, to mark the calls an issue points at. */
  issueBySpan: ReadonlyMap<string, IssueKind>;
  /** Spans to highlight and expand, e.g. after "Show calls" on an issue. */
  focus?: ReadonlySet<string> | undefined;
  /** Where the reader's columns are kept: one key per tab (`trace-cache`, `trace-http`). */
  table?: string | undefined;
  /** The calls' time on the clock, as the header and the tab write it. */
  clock: string;
}

interface Group {
  template: string;
  spans: Span[];
  /** Its calls' time: on the clock, added up; set once the calls are grouped. */
  time: RowTime;
  issue: IssueKind | undefined;
  /** How its calls went: the row's edge (red for a failure, amber for a 4xx) as a request's in a list. */
  answer: GroupAnswer;
}

const NO_ANSWER: GroupAnswer = { failed: 0, warned: 0, code: null, tone: undefined };

const HTTP_METHOD = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT) (.+)$/;

/** What a group repeats: an HTTP call's method in its badge, as every list shows a request's, then the rest. */
function Template({ template }: { template: string }) {
  const http = HTTP_METHOD.exec(template);
  const beside = useContext(HiddenColumns) !== null;
  // Beside the tree every call has a word in the method's place, so the names line up.
  if (beside && template.startsWith("GraphQL ")) {
    return (
      <span className="flex min-w-0 shrink-[1000] items-center gap-2.5">
        <span className="tp-method" data-method="GQL">
          GQL
        </span>{" "}
        <span className="truncate font-mono">{template.slice("GraphQL ".length)}</span>
      </span>
    );
  }
  if (!http) return <span className="shrink-[1000] truncate font-mono">{template}</span>;
  return (
    <span className="flex min-w-0 shrink-[1000] items-center gap-2.5">
      <MethodBadge method={http[1]} /> <span className="truncate font-mono">{http[2]}</span>
    </span>
  );
}

/** A group with one more of its calls. */
function withCall(group: Group, span: Span): Group {
  group.spans.push(span);
  return group;
}

/** The calls by what they are a repeat of (`GET api.example.com/users/{id}`), the longest on the clock first. */
function groupCalls(spans: readonly Span[], issueBySpan: ReadonlyMap<string, IssueKind>): Group[] {
  const groups = new Map<string, Group>();
  for (const span of spans) {
    const template = callTemplate(span);
    const group = groups.get(template) ?? {
      template,
      spans: [],
      time: rowTime([]),
      issue: undefined,
      answer: NO_ANSWER,
    };
    groups.set(template, withCall(group, span));
  }
  // Each row's time on the clock, as the table shows it and sorts by, and how its calls went.
  for (const group of groups.values()) {
    group.time = rowTime(group.spans);
    group.issue = issueOfRepeats(group.spans, issueBySpan);
    group.answer = groupAnswer(group.spans.map((span) => ({ span })));
  }
  return [...groups.values()].sort((a, b) => b.time.clock - a.time.clock);
}

/** One call's outcome: its HTTP status as every list shows one, else whether it failed. */
function Status({ span, dot }: { span: Span; dot: boolean }) {
  const { status, tone } = callAnswer(span);
  if (status !== null) return <StatusBadge status={status} dot={dot} />;
  return tone === "error" ? <span className="text-destructive">failed</span> : <span>—</span>;
}

/** Where a call's text is: an HTTP call's URL, a command or statement. */
const TEXT_ATTRS = ["url.full", "db.statement"];

/** What a call's row shows, as text: its URL or command, where it was made, why it failed. */
function textsOf(span: Span): { url: string; origin: string | null; failure: string } {
  const attrs = span.attrs;
  return {
    url: String(TEXT_ATTRS.map((key) => attrs[key]).find((value) => value !== undefined) ?? span.name),
    origin: attrs["code.origin"] === undefined ? null : String(attrs["code.origin"]),
    failure: String(attrs["error.type"] ?? ""),
  };
}

function Call({
  span,
  index,
  focused,
  bare,
  saidOrigin = false,
}: {
  span: Span;
  index: number;
  focused: boolean;
  bare: boolean;
  /** Its list's heading says where its calls were made. */
  saidOrigin?: boolean | undefined;
}) {
  const { url, origin, failure } = textsOf(span);
  const beside = useContext(HiddenColumns) !== null;
  return (
    <CallLine index={index} focused={focused} time={span.duration} bare={bare}>
      <span
        className={cn(
          "grid min-w-0 items-center gap-3",
          beside ? "grid-cols-[auto_minmax(0,1fr)]" : "grid-cols-[3rem_minmax(0,1fr)]",
        )}
      >
        <span className="font-mono tabular-nums" title={failure}>
          <Status span={span} dot={beside} />
        </span>
        <span className="grid min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <code className="truncate font-mono">{url}</code>
            <NotTraced spanId={span.id} />
          </span>
          {/* Where it was made, where that is known: no line of a dash. */}
          {saidOrigin || !origin ? null : <code className="truncate font-mono text-muted-foreground">{origin}</code>}
        </span>
      </span>
    </CallLine>
  );
}

/** A group's name in its row: what its calls repeat, how many, how they went, its issue. */
function GroupName({ group }: { group: Group }) {
  // How many right after what, as the tree says it: ×36.
  const issue = group.issue;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Template template={group.template} />
      <Times count={group.spans.length} />
      {group.spans.length > 1 ? <GroupStatus answer={group.answer} /> : null}
      <GroupNotTraced spans={group.spans} />
      {issue ? <IssueChip kind={issue} /> : null}
    </span>
  );
}

function columns(groups: readonly Group[], scope: ListTime, noun: readonly [string, string]): DataColumn<Group>[] {
  return [
    { id: "call", label: "Call", required: true, cell: (group) => <GroupName group={group} /> },
    ...timeColumns<Group>((group) => group.time, groups, scope, noun),
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
  // Beside the tree the open row has just said how many and how long.
  const beside = useContext(HiddenColumns) !== null;
  const bare = beside && count === 1;
  const oneOrigin = beside ? sameOrigin(group.spans) : null;
  return (
    <>
      {beside ? null : <DetailsTitle>{title}</DetailsTitle>}
      <CallLines heading={bare ? null : <SectionHeading>{calledFrom(count, oneOrigin)}</SectionHeading>}>
        {group.spans.map((span, index) => (
          <Call
            key={span.id}
            span={span}
            index={index}
            focused={focus?.has(span.id) ?? false}
            bare={bare}
            saidOrigin={oneOrigin !== null && !bare}
          />
        ))}
      </CallLines>
    </>
  );
}

/** One system's calls, grouped by what they repeat (an endpoint, a key pattern) like queries by statement. */
export function CallsList({ spans, issueBySpan, focus, table = "trace-calls", clock }: CallsListProps) {
  const groups = useMemo(() => groupCalls(spans, issueBySpan), [spans, issueBySpan]);
  const scope = useMemo(() => listTime(spans, clock), [spans, clock]);
  if (spans.length === 0) return <p className="tp-note">No calls of this kind in this request.</p>;
  return (
    <CallTable
      table={table}
      columns={columns(groups, scope, nounOf(spans[0]))}
      items={groups}
      focus={focus}
      row={{
        key: (group) => group.template,
        tone: (group) => group.answer.tone,
        focused: (group) => (focus ? group.spans.some((span) => focus.has(span.id)) : false),
        details: (group) => <GroupDetails group={group} focus={focus} />,
      }}
    />
  );
}
