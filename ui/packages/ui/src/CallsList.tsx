import { cn } from "@tracepanel/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";
import { duration } from "./format";
import { callTemplate } from "./lib/calls";
import { IssueChip } from "./primitives";
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
}

/** The calls by what they are a repeat of (`GET api.example.com/users/{id}`), the heaviest first. */
function groupCalls(spans: readonly Span[], issueBySpan: ReadonlyMap<string, IssueKind>): Group[] {
  const groups = new Map<string, Group>();
  for (const span of spans) {
    const template = callTemplate(span);
    const group = groups.get(template) ?? { template, spans: [], total: 0, issue: undefined };
    group.spans.push(span);
    group.total += span.duration;
    group.issue ??= issueBySpan.get(span.id);
    groups.set(template, group);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

/** One call's outcome: an HTTP status, or whether it failed. */
function statusOf(span: Span): string {
  const status = span.attrs["http.response.status_code"];
  if (typeof status === "number") return String(status);
  return span.status === "error" ? "failed" : "—";
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
      <span
        data-failed={span.status === "error" ? "" : undefined}
        className="font-mono tabular-nums data-failed:text-destructive"
        title={failure}
      >
        {statusOf(span)}
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
  if (spans.length === 0)
    return <p className="px-4 py-6 text-sm text-muted-foreground">No calls of this kind in this request.</p>;
  return (
    <div className="grid gap-3 p-4">
      <span className="text-sm text-muted-foreground">
        {spans.length} {spans.length === 1 ? "call" : "calls"} · {groups.length} unique
      </span>
      <ul className="m-0 list-none overflow-hidden rounded-lg border bg-card p-0">
        {groups.map((group) => {
          const focused = focus ? group.spans.some((span) => focus.has(span.id)) : false;
          return (
            <li key={group.template} className={cn("border-b last:border-b-0", focused && "bg-brand-soft/40")}>
              <details open={focused} className="group/row">
                <summary className="grid cursor-pointer list-none grid-cols-[14px_36px_minmax(0,1fr)_auto_88px_64px] items-center gap-2.5 px-3 py-1.5 hover:bg-accent [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open/row:rotate-90" />
                  <span className="text-right font-mono text-sm text-muted-foreground tabular-nums">
                    {group.spans.length}×
                  </span>
                  <span className="truncate font-mono text-base">{group.template}</span>
                  {group.issue ? <IssueChip kind={group.issue} /> : <span />}
                  <span className="h-1.5 overflow-hidden rounded-full bg-muted-foreground/15" aria-hidden="true">
                    <span
                      className="block h-full rounded-full bg-chart-1"
                      style={{ width: `${Math.max((group.total / heaviest) * 100, 2)}%` }}
                    />
                  </span>
                  <span className="text-right text-base tabular-nums">{duration(group.total)}</span>
                </summary>
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
        })}
      </ul>
    </div>
  );
}
