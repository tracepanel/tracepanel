import { type FocusEvent, type ReactNode, useMemo } from "react";
import { buildTree, chipCounts, FILTERS, type FilterId, partOfCategory, withShownLogs } from "./callTree";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { CloseIcon } from "./icons";
import { type Category, spanCategories } from "./lib/breakdown";
import { GC } from "./lib/memory";
import { plural } from "./lib/plural";
import { WAITING } from "./lib/profile";
import { cleared, isShown, rangeLabel, type Slice, togglePart } from "./lib/slice";
import { splitOf } from "./lib/split";
import { NOT_PROFILED } from "./lib/timeShares";
import { litKey } from "./lit";
import { ShareFace } from "./Shares";
import { useHeldSlice } from "./TimeSlice";
import type { Related, Trace } from "./types";

/** What a share of the time is: a category of spans, the collector's pauses, or the code's waits. */
export type ShareKind = Category | typeof GC | typeof WAITING | typeof NOT_PROFILED;

/** A share of the time, as the legend and the strip's tooltip say it. */
export interface ShareOf {
  category: ShareKind;
  /** Its time (µs) and that time written, as the trace's split says it (lib/split). */
  value: number;
  time: string;
  total: number;
  /** Its percent of the total, as the split says it: they add up to 100%. */
  percent: string;
  /** How many spans count in it; the collector's, how many times it ran; none for waiting. */
  calls: number;
  label: string;
}

/** "26 ms · 96% · 12 calls": how long, of the whole, how many spans (the collector's runs); waiting, how long. */
function shareNumbers(share: ShareOf): string {
  const numbers = `${share.time} · ${share.percent}`;
  if (share.category === WAITING) return `${numbers} · not computing: a sleep, a timer, a socket, a lock`;
  if (share.category === NOT_PROFILED) return `${numbers} · its code's time before the profile's first sample`;
  const counted =
    share.category === GC ? plural(share.calls, "collection", "collections") : plural(share.calls, "call", "calls");
  return `${numbers} · ${counted}`;
}

/** A share of spans' time: one that picks its rows. */
type SpanShare = ShareOf & { category: Category };

function ofSpans(share: ShareOf): share is SpanShare {
  return share.category !== GC && share.category !== WAITING && share.category !== NOT_PROFILED;
}

/**
 * Each share of the time with its numbers, as the trace's split says them (lib/split): how long, of how much, how
 * many spans; largest first, waiting last.
 */
export function sharesOf(trace: Trace): ShareOf[] {
  const split = splitOf(trace);
  const calls = new Map<ShareKind, number>();
  for (const category of spanCategories(trace).values()) calls.set(category, (calls.get(category) ?? 0) + 1);
  calls.set(GC, trace.profile?.gc?.collections ?? 0);
  return split.shares.map((share) => ({
    category: share.share,
    value: share.us,
    time: share.time,
    total: split.total,
    percent: share.percent,
    calls: calls.get(share.share) ?? 0,
    label: share.label,
  }));
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

/** A share's swatch: its colour; waiting's hatched, as the strip draws the waits. */
function swatchClass(share: ShareOf): string {
  return share.category === WAITING ? "dt-swatch dt-hatched" : "dt-swatch";
}

/** The numbers of a share, over it: its name, how long, of the whole, how many calls. */
export function ShareTip({ share }: { share: ShareOf }) {
  return (
    <>
      <span className={swatchClass(share)} data-category={share.category} />
      <span className="font-medium">{share.label}</span>
      <span className="text-muted-foreground tabular-nums">{shareNumbers(share)}</span>
    </>
  );
}

/** The look of the strip's tooltips: the console's popover, one line. */
export const TIP_CLASS =
  "flex items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm whitespace-nowrap text-popover-foreground shadow-[var(--dt-popover-shadow)]";

/**
 * The collector's share, or waiting's: its colour, its numbers on hover; nothing to pick, the call tree has no rows
 * of it.
 */
function FixedShare({ share }: { share: ShareOf }) {
  return (
    <li data-category={share.category}>
      <Tooltip delayDuration={150} disableHoverableContent={true}>
        <TooltipTrigger asChild>
          <span className="dt-share" data-fixed="" {...litKey(share.category, true)}>
            <ShareFace
              swatch={<span className={swatchClass(share)} />}
              name={share.label}
              value={share.time}
              share={share.percent}
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
              value={share.time}
              share={share.percent}
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
export function TimeLegend({
  trace,
  related,
  shares: sharesOnly = false,
}: {
  trace: Trace;
  related: Related | undefined;
  /** Its shares alone, no filter chips: the panel picks the kinds shown in its Show menu. */
  shares?: boolean | undefined;
}) {
  const { slice, change } = useHeldSlice();
  const tree = useMemo(() => buildTree(withShownLogs(trace, slice.logs), related), [trace, related, slice.logs]);
  const counts = useMemo(() => chipCounts(tree, trace), [tree, trace]);
  const shares = useMemo(() => sharesOf(trace), [trace]);
  const filters = { counts, slice, onChange: change };
  const claimed = new Set(shares.filter(ofSpans).map((share) => partOfCategory(share.category)));
  const others = sharesOnly
    ? []
    : FILTERS.filter((filter) => !claimed.has(filter.id) && (counts.get(filter.id) ?? 0) > 0);
  return (
    <ul className="dt-breakdown-legend" aria-label="Where the time went, and what to show">
      {shares.map((share) =>
        ofSpans(share) ? (
          <Share key={share.category} share={share} filters={filters} />
        ) : (
          <FixedShare key={share.category} share={share} />
        ),
      )}
      {others.map((filter) => (
        <li key={filter.id}>
          <FilterChip id={filter.id} filters={filters}>
            {filter.label}
          </FilterChip>
        </li>
      ))}
      {sharesOnly ? null : <LogsChip trace={trace} filters={filters} />}
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
