// A trace's calls to one system as the console lists anything: its DB, Cache and HTTP calls tabs are tables with the
// console's head and hairline rows (DataTable), a row's details opened under it as a log record's are, and those
// details laid out as the call tree's.

import {
  createContext,
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { TableCell, TableRow } from "./components/ui/table";
import { type DataColumn, DataTable } from "./DataTable";
import { StatementPlan } from "./ExplainView";
import { duration } from "./format";
import { focusMark, useScrollToFocus } from "./hooks/useScrollToFocus";
import { IssueList } from "./IssueList";
import { ChevronRightIcon } from "./icons";
import { ISSUE_LABELS } from "./labels";
import { onTheClock } from "./lib/calls";
import { percents, widthOf } from "./lib/percent";
import { plural } from "./lib/plural";
import { cn } from "./lib/utils";
import type { TraceLinks } from "./links";
import { AppChip, HopName, IssueChip } from "./primitives";
import type { ExplainPlan, Issue, IssueKind, Span, Trace } from "./types";

// A failed call marks its row's edge red, one answered 4xx amber, as the console's lists mark theirs; one an issue
// points at is highlighted.
const ROW = cn(
  "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
  "data-focused:bg-brand-soft/60",
  "data-[tone=error]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-error)]",
  "data-[tone=warn]:[&>td:first-child]:shadow-[inset_3px_0_0_var(--tp-warn-strong)]",
);

/** Whether a click in a row opens it: anywhere but a link or a button in it, and not the end of selecting its text. */
function opens(event: MouseEvent): boolean {
  if (window.getSelection()?.toString()) return false;
  return !(event.target as Element).closest("a, button, [role=separator]");
}

function onRowKey(event: KeyboardEvent<HTMLTableRowElement>, onToggle: () => void) {
  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  onToggle();
}

/** What the table needs of a row: its key, its edge, whether an issue points at it, what opens under it. */
export interface CallRowOf<T> {
  key: (item: T) => string;
  tone?: ((item: T) => "error" | "warn" | undefined) | undefined;
  focused: (item: T) => boolean;
  details: (item: T) => ReactNode;
}

/** The row a cell is in: whether it is open, and what opens it (its issue's chip, at its hint). */
const OpenRow = createContext<{ opened: boolean; open: () => void }>({ opened: false, open: () => undefined });

/**
 * The calls, a row each, in the reader's columns (kept under `table`); a click, Enter or Space opens a row's details
 * under it. Rows an issue points at are highlighted, scrolled to, and open when `openFocused`. `category` colours the
 * rows' bars as the call tree's (`sql`, `cache`, `http`).
 */
export function CallTable<T>({
  table,
  columns,
  items,
  row,
  focus,
  openFocused = true,
  category,
}: {
  table: string;
  columns: readonly DataColumn<T>[];
  items: readonly T[];
  row: CallRowOf<T>;
  focus: ReadonlySet<string> | undefined;
  openFocused?: boolean | undefined;
  category?: string | undefined;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(openFocused ? items.filter(row.focused).map(row.key) : []),
  );
  const toggle = (key: string) => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    setOpen(next);
  };
  const body = useScrollToFocus<HTMLDivElement>(focus);
  return (
    <div ref={body} data-category={category}>
      <DataTable table={table} columns={columns} boxed={false} stickyHeader={false}>
        {({ cells, span }) =>
          items.map((item) => {
            const key = row.key(item);
            const opened = open.has(key);
            return (
              <Fragment key={key}>
                <TableRow
                  {...focusMark(row.focused(item))}
                  data-tone={row.tone?.(item)}
                  tabIndex={0}
                  aria-expanded={opened}
                  className={ROW}
                  onClick={(event) => opens(event) && toggle(key)}
                  onKeyDown={(event) => onRowKey(event, () => toggle(key))}
                >
                  <OpenRow value={{ opened, open: () => opened || toggle(key) }}>{cells(item)}</OpenRow>
                </TableRow>
                {opened ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={span} className="bg-muted/40 p-0 whitespace-normal">
                      <div className="tp-call-details grid gap-4 px-6 py-4">{row.details(item)}</div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })
        }
      </DataTable>
    </div>
  );
}

/**
 * A row's time, as every time of calls is said since the header's: on the clock (calls that ran side by side counted
 * once), what they add up to, how many.
 */
export interface RowTime {
  clock: number;
  total: number;
  count: number;
}

/** A row's calls' time: on the clock, added up, how many. */
export function rowTime(spans: readonly Pick<Span, "start" | "duration">[]): RowTime {
  return {
    clock: onTheClock(spans),
    total: spans.reduce((sum, span) => sum + span.duration, 0),
    count: spans.length,
  };
}

/** What a row's time says on hover: what its calls add up to, when there are several. */
function timeTitle(time: RowTime, noun: readonly [string, string]): string | undefined {
  if (time.count < 2) return undefined;
  return `${duration(time.total)} total, ${plural(time.count, ...noun)}`;
}

/** What a table's calls take, as its Share column says it is of: their time on the clock (as the header and the tab say it). */
export interface ListTime {
  /** Their time on the clock, written as the header writes it (the strip's Database for the trace's queries). */
  clock: string;
  /** Whether they ran side by side: what they add up to is then more than their time on the clock. */
  parallel: boolean;
}

/** A list of calls' time: on the clock as `clock` writes it, and whether they ran side by side. */
export function listTime(spans: readonly Pick<Span, "start" | "duration">[], clock: string): ListTime {
  return { clock, parallel: spans.reduce((sum, span) => sum + span.duration, 0) > onTheClock(spans) };
}

/** What the Share column says it is of, on hover: the calls' time, or, side by side, what they add up to. */
function shareTitle(sum: number, scope: ListTime, noun: readonly [string, string]): string {
  if (!scope.parallel) return `Of the ${scope.clock} the ${noun[1]} took`;
  return `Of the ${duration(sum)} the ${noun[1]} add up to, each its own time (side by side they took ${scope.clock} on the clock)`;
}

/**
 * The columns every such table ends with. Time: the row's time on the clock, as the header says the scope's (calls
 * side by side once), what they add up to on hover. Each: a group's time per call (~0.9 ms), where some row is a
 * group: many fast calls read apart from one slow one. Share: the row's part of what the calls add up to, each its
 * own time, as a bar in the calls' colour (the rows that are most of the time stand out) and whole percents that add
 * up to 100% (largest remainder, as the strip's); where calls ran side by side, so named: a share of their sum, not
 * of the time on the clock. A narrow table leaves out Each first, then Share: the name keeps its room.
 */
export function timeColumns<T>(
  time: (item: T) => RowTime,
  items: readonly T[],
  scope: ListTime,
  noun: readonly [string, string] = ["call", "calls"],
): DataColumn<T>[] {
  const totals = items.map((item) => time(item).total);
  const sum = totals.reduce((all, each) => all + each, 0);
  const said = percents(totals, sum);
  const shares = new Map(items.map((item, at) => [item, said[at] ?? "0%"]));
  const title = shareTitle(sum, scope, noun);
  // A row of all the calls says their time as the header does: one time, one text.
  const count = items.reduce((all, item) => all + time(item).count, 0);
  const clock = (row: RowTime) => (row.count === count ? scope.clock : duration(row.clock));
  const groups = items.some((item) => time(item).count > 1);
  return [
    {
      id: "time",
      label: "Time",
      width: 6.5,
      fixed: true,
      num: true,
      cell: (item) => (
        <span className="tp-row-time" title={timeTitle(time(item), noun)}>
          {clock(time(item))}
        </span>
      ),
    },
    ...(groups ? [eachColumn(time, noun)] : []),
    {
      id: "share",
      label: scope.parallel ? "Share of sum" : "Share",
      width: scope.parallel ? 10 : 8.5,
      num: true,
      drop: 1,
      className: "text-muted-foreground",
      cell: (item) => (
        <span className="tp-row-share" title={title}>
          <span className="tp-call-share tp-row-share-bar" aria-hidden="true">
            {/* A sliver for the least: every row's bar is there to compare. */}
            <span style={{ width: widthOf(Math.max(time(item).total, sum / 50), sum) }} />
          </span>
          <span className="tp-row-share-text">{shares.get(item) ?? "0%"}</span>
        </span>
      ),
    },
  ];
}

/** A group's time per call, "~0.9 ms": the first column to go in a narrow table, the row's time says the rest. */
function eachColumn<T>(time: (item: T) => RowTime, noun: readonly [string, string]): DataColumn<T> {
  return {
    id: "each",
    label: "Each",
    width: 7,
    num: true,
    drop: 2,
    className: "text-muted-foreground",
    cell: (item) => {
      const { total, count } = time(item);
      if (count < 2) return null;
      return (
        <span title={`${duration(total)} added up over ${plural(count, ...noun)}, ~${duration(total / count)} each`}>
          ~{duration(total / count)}
        </span>
      );
    },
  };
}

/** A row's fold, as the call tree's: a chevron that turns as the row opens (styles.css, `tr[aria-expanded]`). */
export function RowCaret() {
  const { opened } = useContext(OpenRow);
  return (
    <span className="tp-map-caret tp-row-caret" data-open={opened ? "" : undefined} aria-hidden="true">
      <ChevronRightIcon />
    </span>
  );
}

/** A row's issue: its chip, pressed, opens the row at what the issue is and how to fix it. */
export function RowIssue({ kind }: { kind: IssueKind }) {
  const { open } = useContext(OpenRow);
  return (
    <button
      type="button"
      className="tp-row-issue"
      title={`${ISSUE_LABELS[kind]}: what it is and how to fix it`}
      onClick={open}
    >
      <IssueChip kind={kind} />
    </button>
  );
}

/**
 * The issues of an open row's calls, first in its details: each as the Issues tab has it (what it is, where, the
 * hint that fixes it). `own` leaves out a repeat (an N+1, a duplicate): one run of a group says only its own.
 */
export function RowIssues({
  spans,
  issues,
  links,
  own = false,
}: {
  spans: readonly Span[];
  issues: readonly Issue[] | undefined;
  links: TraceLinks | undefined;
  own?: boolean | undefined;
}) {
  const ids = new Set(spans.map((span) => span.id));
  const found = (issues ?? []).filter((issue) => rowHas(issue, ids, own));
  if (found.length === 0) return null;
  return <IssueList issues={found} links={links} />;
}

/** Whether an issue is a row's: a finding (not an error) on its calls; with `own`, not a repeat. */
function rowHas(issue: Issue, ids: ReadonlySet<string>, own: boolean): boolean {
  if (issue.kind === "error") return false;
  if (own && (issue.kind === "n+1" || issue.kind === "duplicates")) return false;
  return issue.span_ids.some((id) => ids.has(id));
}

/**
 * Where a row's calls were made, when a table's come from more than one: the call that reached the app that made
 * them, and that app, as the call tree's row says it (`GET /api/products → shop`); the trace's own, its name and app.
 */
export interface CallSource {
  call: string;
  app: string;
  runtime: string | undefined;
  /** Made in a trace another app served for a call: the arrow to its app. */
  served: boolean;
}

/** Each call's source, where a table's calls come from more than one; none where all come from one. */
export type SourceOf = (span: Span) => CallSource | undefined;

/** The sources of some calls, each once (by its call and app), in their order. */
function sourcesOf(spans: readonly Span[], sourceOf: SourceOf): CallSource[] {
  const sources = new Map<string, CallSource>();
  for (const source of spans.map(sourceOf)) {
    if (source) sources.set(`${source.call} ${source.app}`, source);
  }
  return [...sources.values()];
}

/** A source as its call's row says it: a call another app served, the arrow to its app; the trace's own, its app. */
function SourceName({ source }: { source: CallSource }) {
  if (source.served) return <HopName call={source.call} app={source.app} runtime={source.runtime} />;
  return (
    <>
      <span className="truncate">{source.call}</span>
      <AppChip name={source.app} runtime={source.runtime} compact />
    </>
  );
}

/** A row's line under its name: its calls' source, "+2" where they come from more (all of them on hover). */
export function SourceLine({ spans, sourceOf }: { spans: readonly Span[]; sourceOf: SourceOf | undefined }) {
  const [first, ...more] = sourceOf ? sourcesOf(spans, sourceOf) : [];
  if (!first) return null;
  const all = [first, ...more].map((each) => `${each.call} · ${each.app}`).join("\n");
  return (
    <span className="tp-call-source" title={more.length > 0 ? all : undefined}>
      <SourceName source={first} />
      {more.length > 0 ? <span className="tp-call-source-more">+{more.length}</span> : null}
    </span>
  );
}

/** An open group's first line, as the call tree's: "36 similar calls · 490 ms on the clock · 12.7 s total". */
export function groupTitle(time: RowTime, noun: readonly [string, string], similar: string): string {
  if (time.count === 1) return `1 ${noun[0]} · ${duration(time.total)}`;
  const head = `${time.count} similar ${similar}`;
  if (time.clock >= time.total) return `${head} · ${duration(time.total)} total`;
  return `${head} · ${duration(time.clock)} on the clock · ${duration(time.total)} total`;
}

/**
 * What a row of repeats says of itself: an N+1 if any of its calls is in one, else a finding all of them share.
 * One slow query among 36 is that query's, on its own line: it doesn't make the 36 "Slow query".
 */
export function issueOfRepeats(
  spans: readonly { id: string }[],
  issueBySpan: ReadonlyMap<string, IssueKind>,
): IssueKind | undefined {
  const kinds = spans.map((span) => issueBySpan.get(span.id));
  if (kinds.includes("n+1")) return "n+1";
  const [first] = kinds;
  return first && kinds.every((kind) => kind === first) ? first : undefined;
}

/** Where calls were all made, when that is one place. */
export function sameOrigin(spans: readonly Span[]): string | null {
  const origins = new Set(spans.map((span) => String(span.attrs["code.origin"] ?? "")));
  const [origin] = origins;
  return origins.size === 1 && origin ? origin : null;
}

/** The heading over an open row's calls: how many, and where from when that is one place. */
export function calledFrom(count: number, origin: string | null): string {
  if (count === 1) return origin ? `Called from ${origin}` : "Call";
  return origin ? `Called ${count} times from ${origin}` : `Called ${count} times`;
}

/** What an open row's details start with, as the call tree's do: what it is, how many, how long. */
export function DetailsTitle({ children }: { children: ReactNode }) {
  return <p className="tp-map-details-title">{children}</p>;
}

/** One line of an open row's list of calls (where each was made, its time): the hairline rows of a call's fields. */
export function CallLine({
  index,
  focused,
  time,
  longest,
  bare = false,
  children,
}: {
  index: number;
  focused: boolean;
  time: number;
  /** The longest of the lines: each time's bar is its share of it, so the slow ones stand out. */
  longest?: number | undefined;
  /** The only line of its row, whose time the row says: no number, no time. */
  bare?: boolean | undefined;
  children: ReactNode;
}) {
  if (bare) return <li className="grid py-1 text-sm">{children}</li>;
  return (
    <li
      className={cn(
        "grid grid-cols-[2rem_minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border/60 py-1 text-sm",
        focused && "bg-brand-soft",
      )}
    >
      <span className="text-right text-muted-foreground tabular-nums">{index + 1}</span>
      {children}
      {longest ? (
        <span className="tp-call-share" aria-hidden="true">
          <span style={{ width: `${Math.max((time / longest) * 100, 2)}%` }} />
        </span>
      ) : (
        <span />
      )}
      <span className="w-14 text-right tabular-nums">{duration(time)}</span>
    </li>
  );
}

/** The list of an open row's calls, under its heading. */
export function CallLines({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-1">
      {heading}
      <ol className="m-0 grid list-none p-0">{children}</ol>
    </section>
  );
}

/**
 * Runs EXPLAIN for one SQL span of the trace; without it, no query shows a plan. `can` says which spans' queries it
 * runs (all of them without it): a chain's, those of the traces whose apps run EXPLAIN.
 */
export type Explain = ((spanId: string, analyze: boolean) => Promise<ExplainPlan>) & {
  can?: ((spanId: string) => boolean) | undefined;
};

/** EXPLAIN for the queries of a trace, where its app runs it; undefined where it doesn't. */
export type ExplainOf = (trace: Trace) => Explain | undefined;

/** A query's database, as the agent picks how to explain it. */
const vendorOf = (span: Span) => String(span.attrs["db.system"] || span.attrs["db.vendor"] || "");

/**
 * A query's plan on demand, the same wherever a query's details open (a trace's DB tab, its call tree): a SELECT's or
 * a WITH's, where the host can run EXPLAIN.
 */
export function QueryPlan({ span, onExplain }: { span: Span; onExplain: Explain | undefined }) {
  if (!onExplain || span.kind !== "sql" || onExplain.can?.(span.id) === false) return null;
  return (
    <StatementPlan
      statement={String(span.attrs["db.statement"] ?? "")}
      vendor={vendorOf(span)}
      load={(analyze) => onExplain(span.id, analyze)}
    />
  );
}
