import { cn } from "@tracepanel/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ExplainView } from "./ExplainView";
import { duration } from "./format";
import { focusMark, useScrollToFocus } from "./hooks/useScrollToFocus";
import { queryFingerprint } from "./lib/fingerprint";
import { linkProps, type TraceLinks } from "./links";
import { AliasChip, IssueChip } from "./primitives";
import { SqlCode } from "./SqlCode";
import type { ExplainPlan, IssueKind, Span } from "./types";

/** Runs EXPLAIN for one SQL span; the Explain button is hidden without it. */
export type Explain = (spanId: string, analyze: boolean) => Promise<ExplainPlan>;

const isSelect = (span: Span | undefined) => /^\s*SELECT\b/i.test(String(span?.attrs["db.statement"] ?? ""));

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

function Heading({ children }: { children: string }) {
  return <h4 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{children}</h4>;
}

/** One row: summary line, and when open the statement, its plan and where it was called from. */
function Row({
  lead,
  name,
  alias,
  issue,
  share,
  time,
  open,
  focused,
  children,
}: {
  lead: string;
  name: string;
  alias: unknown;
  issue: IssueKind | undefined;
  share: number;
  time: number;
  open: boolean;
  focused: boolean;
  children: React.ReactNode;
}) {
  return (
    <li {...focusMark(focused)} className={cn("border-b last:border-b-0", focused && "bg-brand-soft/40")}>
      <details open={open} className="group/row">
        <summary className="grid cursor-pointer list-none grid-cols-[14px_36px_minmax(0,1fr)_auto_88px_64px] items-center gap-2.5 px-3 py-1.5 hover:bg-accent [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open/row:rotate-90" />
          <span className="text-right font-mono text-sm text-muted-foreground tabular-nums">{lead}</span>
          <span className="flex min-w-0 items-center gap-2 font-mono text-base">
            <span className="truncate">{name}</span>
            <AliasChip value={alias} />
          </span>
          {issue ? <IssueChip kind={issue} /> : <span />}
          <span className="h-1.5 overflow-hidden rounded-full bg-muted-foreground/15" aria-hidden="true">
            <span className="block h-full rounded-full bg-chart-1" style={{ width: `${Math.max(share * 100, 2)}%` }} />
          </span>
          <span className="text-right text-base tabular-nums">{duration(time)}</span>
        </summary>
        <div className="grid gap-4 border-t bg-muted/30 px-5 py-4">{children}</div>
      </details>
    </li>
  );
}

export function SqlList({ spans, issueBySpan, focus, onExplain, links }: SqlListProps) {
  const [mode, setMode] = useState<"grouped" | "timeline">("grouped");
  const groups = useMemo(() => groupSpans(spans, issueBySpan), [spans, issueBySpan]);
  const heaviestGroup = Math.max(...groups.map((group) => group.total), 1);
  const slowestSpan = Math.max(...spans.map((span) => span.duration), 1);
  const list = useScrollToFocus<HTMLUListElement>(focus);

  if (spans.length === 0)
    return <p className="px-4 py-6 text-sm text-muted-foreground">No database queries in this request.</p>;

  return (
    <div className="grid gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {spans.length} {spans.length === 1 ? "query" : "queries"} · {groups.length} unique
        </span>
        <div className="inline-flex rounded-md border bg-muted p-0.5">
          {(["grouped", "timeline"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className="rounded-[0.3125rem] px-3 py-1 text-sm font-medium text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
            >
              {value === "grouped" ? "Grouped" : "In order"}
            </button>
          ))}
        </div>
      </div>

      <ul ref={list} className="m-0 list-none overflow-hidden rounded-lg border bg-card p-0">
        {mode === "grouped"
          ? groups.map((group) => {
              const first = group.spans[0];
              const focused = focus ? group.spans.some((span) => focus.has(span.id)) : false;
              return (
                <Row
                  key={group.key}
                  lead={`${group.spans.length}×`}
                  name={group.name}
                  alias={first?.attrs["db.alias"]}
                  issue={group.issue}
                  share={group.total / heaviestGroup}
                  time={group.total}
                  open={focused}
                  focused={focused}
                >
                  <section className="grid gap-2">
                    <Heading>Statement</Heading>
                    <SqlCode sql={group.statement} vendor={String(first?.attrs["db.vendor"] ?? "")} />
                  </section>
                  {onExplain && first && isSelect(first) ? (
                    <ExplainView
                      vendor={String(first.attrs["db.vendor"] ?? "")}
                      load={(analyze) => onExplain(first.id, analyze)}
                    />
                  ) : null}
                  <section className="grid gap-2">
                    <Heading>
                      {group.spans.length === 1 ? "Called from" : `Called ${group.spans.length} times from`}
                    </Heading>
                    <ol className="m-0 grid list-none overflow-hidden rounded-md border bg-background p-0">
                      {group.spans.map((span, index) => (
                        <li
                          key={span.id}
                          className={cn(
                            "grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-1.5 text-sm last:border-b-0",
                            focus?.has(span.id) && "bg-brand-soft",
                          )}
                        >
                          <span className="text-right text-muted-foreground tabular-nums">{index + 1}</span>
                          <code className="truncate font-mono">{String(span.attrs["code.origin"] ?? "—")}</code>
                          <span className="tabular-nums">{duration(span.duration)}</span>
                        </li>
                      ))}
                    </ol>
                  </section>
                  {first ? <AllRequests span={first} links={links} /> : null}
                </Row>
              );
            })
          : spans.map((span, index) => (
              <Row
                key={span.id}
                lead={String(index + 1)}
                name={span.name}
                alias={span.attrs["db.alias"]}
                issue={issueBySpan.get(span.id)}
                share={span.duration / slowestSpan}
                time={span.duration}
                open={false}
                focused={focus?.has(span.id) ?? false}
              >
                <section className="grid gap-2">
                  <Heading>Statement</Heading>
                  <SqlCode
                    sql={String(span.attrs["db.statement"] ?? span.name)}
                    vendor={String(span.attrs["db.vendor"] ?? "")}
                  />
                </section>
                {onExplain && isSelect(span) ? (
                  <ExplainView
                    vendor={String(span.attrs["db.vendor"] ?? "")}
                    load={(analyze) => onExplain(span.id, analyze)}
                  />
                ) : null}
                <section className="grid gap-1">
                  <Heading>Called from</Heading>
                  <code className="font-mono text-sm">{String(span.attrs["code.origin"] ?? "—")}</code>
                </section>
                <AllRequests span={span} links={links} />
              </Row>
            ))}
      </ul>
    </div>
  );
}
