import { cn } from "@tracepanel/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";
import { duration } from "./format";
import { focusMark, useScrollToFocus } from "./hooks/useScrollToFocus";
import { callTemplate } from "./lib/calls";
import { IssueChip, MethodBadge, StatusBadge } from "./primitives";
import type { IssueKind, Span } from "./types";

export interface CallsListProps {
  /** The request's calls to one system: HTTP calls, Redis commands, MongoDB commands… */
  spans: readonly Span[];
  /** Issue kind per span id, to mark the calls an issue points at. */
  issueBySpan: ReadonlyMap<string, IssueKind>;
  /** Spans to highlight and expand, e.g. after "Show calls" on an issue. */
  focus?: ReadonlySet<string> | undefined;
}

interface Group {
  template: string;
  spans: Span[];
  total: number;
  issue: IssueKind | undefined;
  /** One of its calls failed: the row has the red edge a failed request's has in a list. */
  failed: boolean;
}

const HTTP_METHOD = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT) (.+)$/;

/** A call failed: an error, or a 5xx answer. */
function failed(span: Span): boolean {
  const status = span.attrs["http.response.status_code"];
  return span.status === "error" || (typeof status === "number" && status >= 500);
}

/** What a group repeats: an HTTP call's method in its badge, as every list shows a request's, then the rest. */
function Template({ template }: { template: string }) {
  const http = HTTP_METHOD.exec(template);
  if (!http) return <span className="truncate font-mono text-base">{template}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <MethodBadge method={http[1]} /> <span className="truncate font-mono text-base">{http[2]}</span>
    </span>
  );
}

/** A group with one more of its calls: its time, its issue, whether one failed. */
function withCall(group: Group, span: Span, issue: IssueKind | undefined): Group {
  group.spans.push(span);
  group.total += span.duration;
  group.issue ??= issue;
  group.failed ||= failed(span);
  return group;
}

/** The calls by what they are a repeat of (`GET api.example.com/users/{id}`), the heaviest first. */
function groupCalls(spans: readonly Span[], issueBySpan: ReadonlyMap<string, IssueKind>): Group[] {
  const groups = new Map<string, Group>();
  for (const span of spans) {
    const template = callTemplate(span);
    const group = groups.get(template) ?? { template, spans: [], total: 0, issue: undefined, failed: false };
    groups.set(template, withCall(group, span, issueBySpan.get(span.id)));
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

/** One call's outcome: its HTTP status as every list shows one, else whether it failed. */
function Status({ span }: { span: Span }) {
  const status = span.attrs["http.response.status_code"];
  if (typeof status === "number") return <StatusBadge status={status} />;
  return span.status === "error" ? <span className="text-destructive">failed</span> : <span>—</span>;
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
    <li
      data-focused={focused ? "" : undefined}
      className="grid grid-cols-[32px_48px_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-1.5 text-sm last:border-b-0 data-focused:bg-brand-soft"
    >
      <span className="text-right text-muted-foreground tabular-nums">{index + 1}</span>
      <span className="font-mono tabular-nums" title={failure}>
        <Status span={span} />
      </span>
      <span className="grid min-w-0">
        <code className="truncate font-mono">{url}</code>
        <code className="truncate font-mono text-muted-foreground">{origin}</code>
      </span>
      <span className="tabular-nums">{duration(span.duration)}</span>
    </li>
  );
}

/** One system's calls, grouped by what they repeat (an endpoint, a key pattern) like queries by statement. */
export function CallsList({ spans, issueBySpan, focus }: CallsListProps) {
  const groups = useMemo(() => groupCalls(spans, issueBySpan), [spans, issueBySpan]);
  const heaviest = Math.max(...groups.map((group) => group.total), 1);
  const list = useScrollToFocus<HTMLUListElement>(focus);
  if (spans.length === 0)
    return <p className="px-4 py-6 text-sm text-muted-foreground">No calls of this kind in this request.</p>;
  return (
    <div className="grid gap-3 p-4">
      <span className="text-sm text-muted-foreground">
        {spans.length} {spans.length === 1 ? "call" : "calls"} · {groups.length} unique
      </span>
      <ul ref={list} className="m-0 list-none overflow-hidden rounded-lg border bg-card p-0">
        {groups.map((group) => (
          <CallGroup key={group.template} group={group} heaviest={heaviest} focus={focus} />
        ))}
      </ul>
    </div>
  );
}

/** One group of calls: how many, what they repeat, its issue, its share of the time; open, each call. */
function CallGroup({
  group,
  heaviest,
  focus,
}: {
  group: Group;
  heaviest: number;
  focus: ReadonlySet<string> | undefined;
}) {
  const focused = focus ? group.spans.some((span) => focus.has(span.id)) : false;
  return (
    <li
      {...focusMark(focused)}
      data-tone={group.failed ? "error" : undefined}
      className={cn(
        "border-b last:border-b-0 data-[tone=error]:shadow-[inset_3px_0_0_var(--color-error)]",
        focused && "bg-brand-soft/40",
      )}
    >
      <details open={focused} className="group/row">
        <CallGroupSummary group={group} heaviest={heaviest} />
        <div className="border-t bg-muted/30 px-5 py-4">
          <ol className="m-0 grid list-none overflow-hidden rounded-md border bg-background p-0">
            {group.spans.map((span, index) => (
              <Call key={span.id} span={span} index={index} focused={focus?.has(span.id) ?? false} />
            ))}
          </ol>
        </div>
      </details>
    </li>
  );
}

/** A group's line: its fold, how many, what they repeat, its issue, its share of the time. */
function CallGroupSummary({ group, heaviest }: { group: Group; heaviest: number }) {
  return (
    <summary className="grid cursor-pointer list-none grid-cols-[14px_36px_minmax(0,1fr)_auto_88px_64px] items-center gap-2.5 px-3 py-1.5 hover:bg-accent [&::-webkit-details-marker]:hidden">
      <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open/row:rotate-90" />
      <span className="text-right font-mono text-sm text-muted-foreground tabular-nums">{group.spans.length}×</span>
      <Template template={group.template} />
      {group.issue ? <IssueChip kind={group.issue} /> : <span />}
      <span className="h-1.5 overflow-hidden rounded-full bg-muted-foreground/15" aria-hidden="true">
        <span
          className="block h-full rounded-full bg-chart-1"
          style={{ width: `${Math.max((group.total / heaviest) * 100, 2)}%` }}
        />
      </span>
      <span className="text-right text-base tabular-nums">{duration(group.total)}</span>
    </summary>
  );
}
