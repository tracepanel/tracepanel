import { type FocusEvent, type ReactNode, useMemo } from "react";
import { buildTree, chipCounts, FILTERS, type FilterId, partOfCategory, withShownLogs } from "./CallMap";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { duration } from "./format";
import { CloseIcon } from "./icons";
import { breakdown, type Category, categoryLabel, spanCategories } from "./lib/breakdown";
import { percent } from "./lib/percent";
import { plural } from "./lib/plural";
import { type Quiet, quietSpans } from "./lib/quiet";
import { cleared, isLoud, rangeLabel, type Slice, togglePart } from "./lib/slice";
import { waitedIn } from "./lib/waiting";
import { ordered, ShareButton, ShareSwatch, ShareText } from "./Shares";
import { useHeldSlice } from "./TimeSlice";
import type { Related, Trace } from "./types";

/** A share of the time, as the legend and the strip's tooltip say it. */
export interface ShareOf {
  category: Category;
  /** Its time, less what its code waited (waiting is a share of its own). */
  value: number;
  total: number;
  /** How many spans count in it. */
  calls: number;
  label: string;
  /** Of its time, how much its code ran with no recorded calls: untraced, as the call tree's code rows say it. */
  untraced: number;
}

/** Where the time went: each category's share, largest first, and how long the code waited, said last. */
export interface Shares {
  shares: ShareOf[];
  /** How long the code waited (a sleep, a socket), where the profile says when its samples were taken. */
  waiting: number;
  total: number;
}

/** "26 ms · 96% · 12 calls": how long, of the whole, how many spans. */
function shareNumbers(share: ShareOf): string {
  return `${duration(share.value)} · ${percent(share.value, share.total)} · ${plural(share.calls, "call", "calls")}`;
}

/** Numbers added up by category. */
function addUp(items: readonly [Category, number][]): Map<Category, number> {
  const sums = new Map<Category, number>();
  for (const [category, value] of items) sums.set(category, (sums.get(category) ?? 0) + value);
  return sums;
}

/** Quiet spans' numbers added up by their share. */
function byCategory(
  spans: readonly [string, Quiet][],
  categories: ReadonlyMap<string, Category>,
  value: (quiet: Quiet) => number,
): Map<Category, number> {
  return addUp(
    spans.flatMap(([span, quiet]): [Category, number][] => {
      const category = categories.get(span);
      return category ? [[category, value(quiet)]] : [];
    }),
  );
}

/** Each share of the time with its numbers (how long, of how much, how many spans), and the waiting apart. */
export function sharesOf(trace: Trace): Shares {
  const parts = breakdown(trace);
  const total = Math.max(
    parts.reduce((sum, [, value]) => sum + value, 0),
    1,
  );
  const categories = spanCategories(trace);
  const calls = addUp([...categories.values()].map((category) => [category, 1]));
  const spans = [...quietSpans(trace)];
  const quiet = byCategory(spans, categories, ({ total }) => total);
  const waits = byCategory(spans, categories, ({ gaps }) => waitedIn(trace.profile, gaps, trace.start));
  const shares = parts
    .map(([category, value]) => {
      const waited = waits.get(category) ?? 0;
      return {
        category,
        value: value - waited,
        total,
        calls: calls.get(category) ?? 0,
        label: categoryLabel(category, trace),
        untraced: (quiet.get(category) ?? 0) - waited,
      };
    })
    .filter((share) => share.value > 0);
  const waiting = [...waits.values()].reduce((sum, value) => sum + value, 0);
  return {
    shares: ordered(
      shares,
      (share) => share.value,
      () => false,
    ),
    waiting,
    total,
  };
}

interface SliceState {
  counts: ReadonlyMap<FilterId, number>;
  slice: Slice;
  onChange: (next: Slice) => void;
}

/** A chip that shows only its rows (and the rows on the way to them); pressed again, everything. */
function FilterChip({ id, filters, children }: { id: FilterId; filters: SliceState; children: ReactNode }) {
  return (
    <button
      type="button"
      className="dt-map-filter"
      aria-pressed={filters.slice.parts.includes(id)}
      onClick={() => filters.onChange(togglePart(filters.slice, id))}
    >
      {children}
      <span className="dt-map-filter-count">{filters.counts.get(id)}</span>
    </button>
  );
}

/** Opened by focus only from the keyboard: a clicked share keeps focus, and its numbers would stay over the next. */
function keyboardOnly(event: FocusEvent<HTMLElement>): void {
  if (!event.currentTarget.matches(":focus-visible")) event.preventDefault();
}

/** The numbers of a share, over it: its name, how long, of the whole, how many calls, and how much of it is untraced. */
export function ShareTip({ share }: { share: ShareOf }) {
  return (
    <>
      <span className="dt-swatch" data-category={share.category} />
      <span className="font-medium">{share.label}</span>
      <span className="text-muted-foreground tabular-nums">
        {shareNumbers(share)}
        {share.untraced > 0 ? ` · of it ${duration(share.untraced)} untraced` : ""}
      </span>
    </>
  );
}

/** The numbers of the waiting, over it: how long, of the whole, and what it is. */
export function WaitTip({ waiting, total }: { waiting: number; total: number }) {
  return (
    <>
      <ShareSwatch look={{ waiting: true }} />
      <span className="font-medium">{WAITING_LABEL}</span>
      <span className="text-muted-foreground tabular-nums">
        {duration(waiting)} · {percent(waiting, total)} · the code waited (a sleep, a socket), as its profile says
      </span>
    </>
  );
}

const WAITING_LABEL = "Waiting";

/** The look of the strip's tooltips: the console's popover, one line. */
export const TIP_CLASS =
  "flex items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm whitespace-nowrap text-popover-foreground shadow-[var(--dt-popover-shadow)]";

/** A category of the time: its colour (its item's, the swatch takes it), its share; its numbers on hover; a click picks its rows. */
function Share({ share, filters }: { share: ShareOf; filters: SliceState }) {
  const part = partOfCategory(share.category);
  return (
    <li data-category={share.category}>
      <Tooltip delayDuration={150} disableHoverableContent={true}>
        <TooltipTrigger asChild onFocus={keyboardOnly}>
          <ShareButton
            name={share.label}
            value={share.value}
            total={share.total}
            look={{}}
            aria-pressed={filters.slice.parts.includes(part)}
            onClick={() => filters.onChange(togglePart(filters.slice, part))}
          />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} arrow={false} className={TIP_CLASS}>
          <ShareTip share={share} />
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

/** The code's waiting, last: its share of the time, hatched as on the strip; it picks nothing. */
function Waiting({ waiting, total }: { waiting: number; total: number }) {
  if (waiting <= 0) return null;
  return (
    <li data-waiting="">
      <Tooltip delayDuration={150} disableHoverableContent={true}>
        <TooltipTrigger asChild>
          <ShareText name={WAITING_LABEL} value={waiting} total={total} look={{ waiting: true }} />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} arrow={false} className={TIP_CLASS}>
          <WaitTip waiting={waiting} total={total} />
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

/**
 * The trace's log records: by default only its warnings and worse show, in the tree and on the strip; pressed, every
 * one of them. There only when it has info or debug records to show.
 */
function LogsChip({ trace, filters }: { trace: Trace; filters: SliceState }) {
  if (trace.logs.every((log) => isLoud(log.level))) return null;
  return (
    <li>
      <button
        type="button"
        className="dt-map-filter"
        aria-pressed={filters.slice.logs}
        title={filters.slice.logs ? "Show warnings and worse only" : "Show info and debug records too"}
        onClick={() => filters.onChange({ ...filters.slice, logs: !filters.slice.logs })}
      >
        Logs
        <span className="dt-map-filter-count">{trace.logs.length}</span>
      </button>
    </li>
  );
}

/** The picked range, said: a pressed chip that lets it go. */
function RangeChip({ filters }: { filters: SliceState }) {
  const range = filters.slice.range;
  if (!range) return null;
  return (
    <li>
      <button
        type="button"
        className="dt-map-filter"
        aria-pressed={true}
        aria-label={`Time ${rangeLabel(range)}`}
        title="Only calls in this time range; × shows all"
        onClick={() => filters.onChange({ ...filters.slice, range: null })}
      >
        Time {rangeLabel(range)}
        <span className="dt-map-filter-x">
          <CloseIcon />
        </span>
      </button>
    </li>
  );
}

/** How many things are picked: kinds and a range. One lets go by its own chip; "Show all" is for two or more. */
function picks(slice: Slice): number {
  return slice.parts.length + (slice.range ? 1 : 0);
}

/**
 * The time strip's legend, and what to show in the call tree: each share (Database, Templates, Your code…) in its
 * lane's colour picks its rows; the filters with no time of their own (Logs, Errors, Tasks…) follow as plain chips,
 * then the range picked. A pick opens the call tree (`onPick`).
 */
export function TimeLegend({ trace, related }: { trace: Trace; related: Related | undefined }) {
  const { slice, change } = useHeldSlice();
  const tree = useMemo(() => buildTree(withShownLogs(trace, slice.logs), related), [trace, related, slice.logs]);
  const counts = useMemo(() => chipCounts(tree, trace), [tree, trace]);
  const { shares, waiting, total } = useMemo(() => sharesOf(trace), [trace]);
  const filters = { counts, slice, onChange: change };
  const claimed = new Set(shares.map((share) => partOfCategory(share.category)));
  const others = FILTERS.filter((filter) => !claimed.has(filter.id) && (counts.get(filter.id) ?? 0) > 0);
  return (
    <ul className="dt-breakdown-legend" aria-label="Where the time went, and what to show">
      {shares.map((share) => (
        <Share key={share.category} share={share} filters={filters} />
      ))}
      <Waiting waiting={waiting} total={total} />
      {others.map((filter) => (
        <li key={filter.id}>
          <FilterChip id={filter.id} filters={filters}>
            {filter.label}
          </FilterChip>
        </li>
      ))}
      <LogsChip trace={trace} filters={filters} />
      <RangeChip filters={filters} />
      {picks(slice) < 2 ? null : (
        <li>
          <button type="button" className="dt-map-filter-clear" onClick={() => change(cleared(slice))}>
            Show all
          </button>
        </li>
      )}
    </ul>
  );
}
