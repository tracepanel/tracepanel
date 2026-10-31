import { type FocusEvent, type ReactNode, useMemo } from "react";
import { buildTree, chipCounts, FILTERS, type FilterId, partOfCategory, withShownLogs } from "./CallMap";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { duration } from "./format";
import { CloseIcon } from "./icons";
import { breakdown, type Category, categoryLabel, spanCategories, stretches } from "./lib/breakdown";
import { cutByPauses, GC, gcPauses } from "./lib/memory";
import { percent } from "./lib/percent";
import { plural } from "./lib/plural";
import { type Quiet, quietSpans } from "./lib/quiet";
import { cleared, isShown, rangeLabel, type Slice, togglePart } from "./lib/slice";
import { waitedIn } from "./lib/waiting";
import { litKey } from "./lit";
import { largestFirst, ShareFace } from "./Shares";
import { useHeldSlice } from "./TimeSlice";
import type { Related, Trace } from "./types";

/** What a share of the time is: a category of spans, or the collector's pauses. */
export type ShareKind = Category | typeof GC;

/** A share of the time, as the legend and the strip's tooltip say it. */
export interface ShareOf {
  category: ShareKind;
  value: number;
  total: number;
  /** How many spans count in it; the collector's, how many times it ran. */
  calls: number;
  label: string;
  /** Of its time, how much its code waited (a sleep, a socket), where the profile says when its samples were taken. */
  waiting: number;
}

/** "26 ms · 96% · 12 calls": how long, of the whole, how many spans (the collector's runs). */
function shareNumbers(share: ShareOf): string {
  const counted =
    share.category === GC ? plural(share.calls, "collection", "collections") : plural(share.calls, "call", "calls");
  return `${duration(share.value)} · ${percent(share.value, share.total)} · ${counted}`;
}

/** Numbers added up by category. */
function addUp<K>(items: readonly [K, number][]): Map<K, number> {
  const sums = new Map<K, number>();
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

/**
 * Where the wall-clock time went, per share: the stretches added up, the collector's pauses (a profile's) taken out
 * of the shares they stopped and counted as their own.
 */
function timeParts(trace: Trace): [ShareKind, number][] {
  const pauses = gcPauses(trace.profile, trace.duration);
  if (pauses.length === 0) return breakdown(trace);
  return [
    ...addUp(
      stretches(trace).flatMap(({ from, to, category }) =>
        cutByPauses(from, to, pauses).map(({ range, gc }): [ShareKind, number] => [
          gc ? GC : category,
          range[1] - range[0],
        ]),
      ),
    ),
  ];
}

/** A share of spans' time: one that picks its rows. */
type SpanShare = ShareOf & { category: Category };

function ofSpans(share: ShareOf): share is SpanShare {
  return share.category !== GC;
}

/** A share's name: its category's, or the collector's. */
function shareLabel(category: ShareKind, trace: Trace): string {
  return category === GC ? "GC" : categoryLabel(category, trace);
}

/** Each share of the time with its numbers: how long, of how much, how many spans; largest first. */
export function sharesOf(trace: Trace): ShareOf[] {
  const parts = timeParts(trace);
  const total = Math.max(
    parts.reduce((sum, [, value]) => sum + value, 0),
    1,
  );
  const categories = spanCategories(trace);
  const calls = addUp<ShareKind>([...categories.values()].map((category) => [category, 1]));
  calls.set(GC, trace.profile?.gc?.collections ?? 0);
  const waiting: ReadonlyMap<ShareKind, number> = byCategory([...quietSpans(trace)], categories, ({ gaps }) =>
    waitedIn(trace.profile, gaps, trace.start),
  );
  const shares = parts.map(([category, value]) => ({
    category,
    value,
    total,
    calls: calls.get(category) ?? 0,
    label: shareLabel(category, trace),
    waiting: waiting.get(category) ?? 0,
  }));
  return largestFirst(
    shares,
    (share) => share.value,
    () => 0,
  );
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

/**
 * The numbers of a share, over it: its name, how long, of the whole, how many calls, and of its time how much its
 * code waited (the strip's hatched stretches), where a profile says.
 */
export function ShareTip({ share }: { share: ShareOf }) {
  return (
    <>
      <span className="dt-swatch" data-category={share.category} />
      <span className="font-medium">{share.label}</span>
      <span className="text-muted-foreground tabular-nums">
        {shareNumbers(share)}
        {share.waiting > 0 ? ` · of it ${duration(share.waiting)} waiting` : ""}
      </span>
    </>
  );
}

/** The look of the strip's tooltips: the console's popover, one line. */
export const TIP_CLASS =
  "flex items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm whitespace-nowrap text-popover-foreground shadow-[var(--dt-popover-shadow)]";

/** The collector's share: its colour, its numbers on hover; nothing to pick, the call tree has no rows of it. */
function GcShare({ share }: { share: ShareOf }) {
  return (
    <li data-category={share.category}>
      <Tooltip delayDuration={150} disableHoverableContent={true}>
        <TooltipTrigger asChild>
          <span className="dt-share" data-fixed="" {...litKey(share.category, true)}>
            <ShareFace
              swatch={<span className="dt-swatch" />}
              name={share.label}
              value={duration(share.value)}
              share={percent(share.value, share.total)}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} arrow={false} className={TIP_CLASS}>
          <ShareTip share={share} />
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

/** A category of the time: its colour, its share; its numbers on hover; a click picks its rows. */
function Share({ share, filters }: { share: SpanShare; filters: SliceState }) {
  const part = partOfCategory(share.category);
  return (
    <li data-category={share.category}>
      <Tooltip delayDuration={150} disableHoverableContent={true}>
        <TooltipTrigger asChild onFocus={keyboardOnly}>
          <button
            type="button"
            className="dt-share"
            {...litKey(share.category, true)}
            aria-pressed={filters.slice.parts.includes(part)}
            onClick={() => filters.onChange(togglePart(filters.slice, part))}
          >
            <ShareFace
              swatch={<span className="dt-swatch" />}
              name={share.label}
              value={duration(share.value)}
              share={percent(share.value, share.total)}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} arrow={false} className={TIP_CLASS}>
          <ShareTip share={share} />
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
  if (trace.logs.every(isShown)) return null;
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
  const shares = useMemo(() => sharesOf(trace), [trace]);
  const filters = { counts, slice, onChange: change };
  const claimed = new Set(shares.filter(ofSpans).map((share) => partOfCategory(share.category)));
  const others = FILTERS.filter((filter) => !claimed.has(filter.id) && (counts.get(filter.id) ?? 0) > 0);
  return (
    <ul className="dt-breakdown-legend" aria-label="Where the time went, and what to show">
      {shares.map((share) =>
        ofSpans(share) ? (
          <Share key={share.category} share={share} filters={filters} />
        ) : (
          <GcShare key={share.category} share={share} />
        ),
      )}
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
