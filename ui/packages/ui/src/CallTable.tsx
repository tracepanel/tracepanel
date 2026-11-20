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
import { percent, percents, widthOf } from "./lib/percent";
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
 * A table's rows where its calls come from more than one call of a chain: those made where one call went (the call,
 * its app), under a header that says it as the call tree's row does, with how many and their time on the clock.
 */
export interface CallSection<T> {
  /** Its source as one key (its call and app); empty for the one section of a table whose calls all come from one. */
  key: string;
  /** Where its calls were made; none where the table's all come from one place: no header then. */
  source: CallSource | undefined;
  items: readonly T[];
  time: RowTime;
}

/**
 * Calls in sections by their source (sourceOf), each its own rows (`rows`, out of its calls in their order): a row of
 * repeats from two calls is a row in each, its count and time each call's. In the order the calls started, as the call
 * tree has them: the trace's own first, then each call it made. One source, or none: one section, no header.
 */
export function callSections<T>(
  spans: readonly Span[],
  sourceOf: SourceOf | undefined,
  rows: (spans: readonly Span[]) => T[],
): CallSection<T>[] {
  const parts = new Map<string, { source: CallSource; spans: Span[] }>();
  for (const span of spans) {
    const source = sourceOf?.(span);
    if (!source) continue;
    const key = `${source.call} ${source.app}`;
    const part = parts.get(key) ?? { source, spans: [] };
    // One call made again (three GET /authors/{id} to one app) is one source: it started with the first.
    if (source.start < part.source.start) part.source = source;
    part.spans.push(span);
    parts.set(key, part);
  }
  if (parts.size < 2 || [...parts.values()].reduce((all, part) => all + part.spans.length, 0) < spans.length) {
    return [{ key: "", source: undefined, items: rows(spans), time: rowTime(spans) }];
  }
  return [...parts]
    .sort(([, a], [, b]) => a.source.start - b.source.start)
    .map(([key, part]) => ({ key, source: part.source, items: rows(part.spans), time: rowTime(part.spans) }));
}

/** Every row of a table's sections, in their order: what its Share column is worked out over. */
export function sectionRows<T>(sections: readonly CallSection<T>[]): T[] {
  return sections.flatMap((section) => section.items);
}

/** A line of the table: a section's header, or a row of calls (its key the section's and its own). */
type Line<T> = { kind: "section"; section: CallSection<T> } | { kind: "row"; item: T; key: string };

/**
 * The columns over a table's lines: a row's cells as its columns say them; a section's header its source in the name
 * column (the required one) with how many calls, and its time on the clock in the Time column.
 */
function lineColumns<T>(columns: readonly DataColumn<T>[], noun: readonly [string, string]): DataColumn<Line<T>>[] {
  return columns.map((column) => ({
    ...column,
    className: (line: Line<T>) => {
      if (line.kind === "section") return column.num ? "text-right" : undefined;
      return typeof column.className === "function" ? column.className(line.item) : column.className;
    },
    cell: (line: Line<T>) => {
      if (line.kind === "row") return column.cell(line.item);
      if (column.required) return <SectionName section={line.section} noun={noun} />;
      if (column.id === "time")
        return <span title={timeTitle(line.section.time, noun)}>{duration(line.section.time.clock)}</span>;
      return null;
    },
  }));
}

/** A section's header in its name column: its call and app as the call tree's row says them, how many calls. */
function SectionName<T>({ section, noun }: { section: CallSection<T>; noun: readonly [string, string] }) {
  if (!section.source) return null;
  return (
    <span className="tp-call-section-name">
      <SourceName source={section.source} />
      <span className="tp-call-section-count">{plural(section.time.count, ...noun)}</span>
    </span>
  );
}

/**
 * The calls, a row each, in the reader's columns (kept under `table`), in sections where they come from more than one
 * call (callSections); a click, Enter or Space opens a row's details under it. Rows an issue points at are
 * highlighted, scrolled to, and open when `openFocused`. `category` colours the rows' bars as the call tree's (`sql`,
 * `cache`, `http`); `noun` names the calls a section's header counts.
 */
export function CallTable<T>({
  table,
  columns,
  sections,
  row,
  focus,
  openFocused = true,
  category,
  noun,
}: {
  table: string;
  columns: readonly DataColumn<T>[];
  sections: readonly CallSection<T>[];
  row: CallRowOf<T>;
  focus: ReadonlySet<string> | undefined;
  openFocused?: boolean | undefined;
  category?: string | undefined;
  noun: readonly [string, string];
}) {
  const lines = sections.flatMap((section): Line<T>[] => [
    ...(section.source ? [{ kind: "section" as const, section }] : []),
    ...section.items.map((item) => ({ kind: "row" as const, item, key: `${section.key} § ${row.key(item)}` })),
  ]);
  const focused = () => lines.flatMap((line) => (line.kind === "row" && row.focused(line.item) ? [line.key] : []));
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(openFocused ? focused() : []));
  const toggle = (key: string) => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    setOpen(next);
  };
  const body = useScrollToFocus<HTMLDivElement>(focus);
  return (
    <div ref={body} data-category={category}>
      <DataTable table={table} columns={lineColumns(columns, noun)} boxed={false} stickyHeader={false}>
        {({ cells, span }) =>
          lines.map((line) => {
            if (line.kind === "section") {
              return (
                // A header, not a row to open: it keeps its tint under the pointer.
                <TableRow key={`§${line.section.key}`} data-section="" className="bg-muted/30 hover:bg-muted/30">
                  {cells(line)}
                </TableRow>
              );
            }
            const { item, key } = line;
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
                  <OpenRow value={{ opened, open: () => opened || toggle(key) }}>{cells(line)}</OpenRow>
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

/** What a table's calls take, the whole its Share column is of: their time on the clock, as the header says it. */
export interface ListTime {
  /** Their time on the clock, written as the header writes it (the strip's Database for the trace's queries). */
  clock: string;
  /** That time (µs): calls side by side counted once. */
  us: number;
}

/** A list of calls' time on the clock: as `clock` writes it, and in µs. */
export function listTime(spans: readonly Pick<Span, "start" | "duration">[], clock: string): ListTime {
  return { clock, us: onTheClock(spans) };
}

/** What the Share column says it is of, on hover: the calls' time on the clock; rows side by side each count theirs. */
function shareTitle(scope: ListTime, noun: readonly [string, string], overlap: boolean): string {
  const of = `The row's time on the clock, of the ${scope.clock} the ${noun[1]} took`;
  return overlap
    ? `${of}; rows that ran side by side each count their own, so the shares add up to more than 100%`
    : of;
}

/**
 * The columns every such table ends with. Time: the row's time on the clock, as the header says the scope's (calls
 * side by side once), what they add up to on hover. Each: a group's time per call (~0.9 ms), where some row is a
 * group: many fast calls read apart from one slow one. Share: that time's part of the calls' time on the clock (the
 * total under the table), so Time and Share say one thing, as a bar of that whole in the calls' colour (the rows that
 * are most of the time stand out). Whole percents that add up to 100% (largest remainder, as the strip's) where no two
 * rows ran side by side; where some did, their shares overlap as their times do, each rounded on its own. A narrow
 * table leaves out Each first, then Share: the name keeps its room.
 */
export function timeColumns<T>(
  time: (item: T) => RowTime,
  items: readonly T[],
  scope: ListTime,
  noun: readonly [string, string] = ["call", "calls"],
): DataColumn<T>[] {
  const clocks = items.map((item) => time(item).clock);
  // The rows' calls are the table's: their times add up to more than its own only where rows overlap.
  const overlap = clocks.reduce((all, each) => all + each, 0) > scope.us + 0.5;
  const said = overlap ? clocks.map((each) => percent(each, scope.us)) : percents(clocks, scope.us);
  const shares = new Map(items.map((item, at) => [item, said[at] ?? "0%"]));
  const title = shareTitle(scope, noun, overlap);
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
      label: "Share",
      // Room for the bar and the percent (6.25rem) inside the cell's padding: narrower, the bar goes (styles.css).
      width: 9.5,
      num: true,
      drop: 1,
      className: "text-muted-foreground",
      cell: (item) => (
        <span className="tp-row-share" title={title}>
          <span className="tp-call-share tp-row-share-bar" aria-hidden="true">
            {/* A sliver for the least: every row's bar is there to compare. */}
            <span style={{ width: widthOf(Math.min(Math.max(time(item).clock, scope.us / 50), scope.us), scope.us) }} />
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
 * Where calls were made, when a table's come from more than one call: the call that reached the app that made them,
 * and that app, as the call tree's row says it (`GET /api/products → shop`); the trace's own, its name and app.
 */
export interface CallSource {
  call: string;
  app: string;
  runtime: string | undefined;
  /** Made in a trace another app served for a call: the arrow to its app. */
  served: boolean;
  /** When the call started (the trace's own: when it did), on the chain's clock: its section's place. */
  start: number;
}

/** Each call's source, where a table's calls come from more than one; none where all come from one. */
export type SourceOf = (span: Span) => CallSource | undefined;

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
