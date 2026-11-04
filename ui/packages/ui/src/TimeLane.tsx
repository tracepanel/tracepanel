import { type CSSProperties, type PointerEvent, useMemo, useState } from "react";
import { partOfCategory } from "./callTree";
import { duration } from "./format";
import type { Category, Stretch } from "./lib/breakdown";
import { GC } from "./lib/memory";
import { quietSpans } from "./lib/quiet";
import type { TimeRange } from "./lib/slice";
import { type Segment, segmentsOf } from "./lib/timeShares";
import { WAITED_SHARE } from "./lib/waitingShare";
import { litKey } from "./lit";
import { type ShareOf, ShareTip, sharesOf, TIP_CLASS } from "./TimeLegend";
import type { Trace } from "./types";

/** Where a stretch sits on the lane, as CSS offsets. */
function place(stretch: Stretch, total: number): CSSProperties {
  return { left: `${(stretch.from / total) * 100}%`, width: `${((stretch.to - stretch.from) / total) * 100}%` };
}

/**
 * A stretch at either end of the lane rounds that end: the lane doesn't clip its stretches, so a lit one's ring shows
 * whole.
 */
function ends(stretch: Stretch, total: number): CSSProperties {
  const [start, end] = [stretch.from <= 0, stretch.to >= total];
  if (!(start || end)) return {};
  const [left, right] = [start ? "var(--dt-bar-radius)" : "0", end ? "var(--dt-bar-radius)" : "0"];
  return { borderRadius: `${left} ${right} ${right} ${left}` };
}

/** Set on a stretch whose share isn't picked while others are: it steps back (the collector's, never picked, too). */
function faded(each: Drawn, parts: readonly string[]): "" | undefined {
  if (parts.length === 0) return undefined;
  return each.gc || !parts.includes(partOfCategory(each.stretch.category)) ? "" : undefined;
}

/** What the pointer is over: a share's stretch, and where. */
interface Hover {
  category: string;
  x: number;
}

function hoverAt(event: PointerEvent<HTMLDivElement>): Hover | null {
  const over = (event.target as Element).closest<HTMLElement>("[data-category]");
  if (!over) return null;
  return {
    // A wait is waiting's share, whichever span's own time it is.
    category: "waiting" in over.dataset ? WAITED_SHARE : (over.dataset["category"] ?? ""),
    x: event.clientX - event.currentTarget.getBoundingClientRect().left,
  };
}

/** The stretch a piece of the lane stands for, as its data says it (µs since the trace started). */
export function rangeIn(element: HTMLElement): TimeRange | undefined {
  const from = Number(element.dataset["from"]);
  const to = Number(element.dataset["to"]);
  return Number.isFinite(from) && to > from ? [from, to] : undefined;
}

/**
 * Over the share under the pointer: its numbers, its code's own time too. Its quiet stretches say nothing more: the
 * call tree's code rows name what ran there, and with a profile a click opens it.
 */
function LaneTip({ hover, shares }: { hover: Hover | null; shares: readonly ShareOf[] }) {
  const share = shares.find((each) => each.category === hover?.category);
  if (!(hover && share)) return null;
  return (
    <div role="tooltip" className={`dt-lane-tip ${TIP_CLASS}`} style={{ left: hover.x }}>
      <ShareTip share={share} />
    </div>
  );
}

/**
 * Each stretch, and when it is a span's own time with no recorded calls, the span and whether it waited then; or a
 * pause of the collector's (`gc`), whatever ran around it.
 */
interface Drawn {
  stretch: Stretch;
  quiet: boolean;
  waiting: boolean;
  gc: boolean;
}

/** The lane: its pieces, and how long each span's code waited, by span (whether or not it made calls). */
interface Lane {
  trace: Trace;
  drawn: Drawn[];
  totals: Map<string, number>;
}

/**
 * The lane's pieces: the trace's segments (lib/timeShares), those that meet with the same share and span as one. A
 * wait is drawn in its span's colour, hatched; the framework's time in a view's own code in the framework's.
 */
function drawnOf(trace: Trace): Drawn[] {
  const quiet = quietSpans(trace);
  const drawn: Drawn[] = [];
  for (const segment of segmentsOf(trace)) {
    const next = pieceOf(segment, quiet);
    const last = drawn.at(-1);
    if (last && meets(last, next)) last.stretch.to = next.stretch.to;
    else drawn.push(next);
  }
  return drawn;
}

/** A segment as the lane draws it: a wait in its span's colour, hatched; a pause in GC's. */
function pieceOf(segment: Segment, quiet: ReadonlyMap<string, unknown>): Drawn {
  const gc = segment.share === GC;
  const waiting = segment.share === WAITED_SHARE;
  const category = gc || waiting ? segment.category : (segment.share as Category);
  return {
    stretch: { from: segment.from, to: segment.to, category, quiet: segment.quiet, span: segment.span },
    quiet: !gc && segment.quiet && quiet.has(segment.span),
    waiting,
    gc,
  };
}

/** What a piece is, whatever its stretch: its span, its colour, whether it waited, GC's, quiet. */
function kindOf(each: Drawn): string {
  return [each.stretch.span, each.stretch.category, each.waiting, each.gc, each.quiet].join("|");
}

/** Whether a piece goes on from the one before: where it ends, of the same kind. */
function meets(last: Drawn, next: Drawn): boolean {
  return Math.abs(last.stretch.to - next.stretch.from) < 0.5 && kindOf(last) === kindOf(next);
}

function laneOf(trace: Trace): Lane {
  const drawn = drawnOf(trace);
  const totals = new Map<string, number>();
  for (const { stretch } of drawn.filter((each) => each.waiting)) {
    totals.set(stretch.span, (totals.get(stretch.span) ?? 0) + length(stretch));
  }
  return { trace, drawn, totals };
}

/**
 * Where a span's waiting is said: over the longest of its pieces that waited, once. Its code's own time without a
 * wait is said by its colour alone: it is its share's.
 */
function saidAt(drawn: readonly Drawn[]): Drawn[] {
  const longest = new Map<string, Drawn>();
  for (const each of drawn.filter((item) => item.waiting)) {
    const key = String(each.stretch.span);
    const best = longest.get(key);
    if (!best || length(each.stretch) > length(best.stretch)) longest.set(key, each);
  }
  return [...longest.values()];
}

function length(stretch: Stretch): number {
  return stretch.to - stretch.from;
}

/** "waiting · 1.5 s": how long a span's code waited, in all. */
function quietLabel(lane: Lane, each: Drawn): string {
  return `waiting · ${duration(lane.totals.get(each.stretch.span) ?? 0)}`;
}

/** The share a piece of the lane counts in: the collector's, waiting's, or its category's. */
function shareOf(each: Drawn): string {
  if (each.gc) return GC;
  return each.waiting ? WAITED_SHARE : each.stretch.category;
}

/**
 * What a piece of the lane says of itself: whether it waited (hatched, as the legend's Waiting, in any span's own
 * time, a leaf's with no calls too); its span and its stretch when quiet.
 */
function pieceData(each: Drawn): Record<string, string | undefined> {
  const waiting = each.waiting ? "" : undefined;
  if (!each.quiet) return { "data-waiting": waiting };
  return {
    "data-quiet": each.stretch.span,
    "data-from": String(each.stretch.from),
    "data-to": String(each.stretch.to),
    "data-waiting": waiting,
  };
}

/**
 * The trace's own lane: where its time went, moment by moment, one clear line in its shares' colours (the legend's),
 * the collector's pauses in theirs; hatched only where a timed profile says its code waited, and said there
 * ("waiting · 1.5 s"). A
 * share's stretch says its numbers on hover, and picks its rows on a click; a quiet one, with a profile, opens it.
 */
export function TimeLane({ trace, word, parts }: { trace: Trace; word: string; parts: readonly string[] }) {
  const total = Math.max(trace.duration, 1);
  const lane = useMemo(() => laneOf(trace), [trace]);
  const shares = useMemo(() => sharesOf(trace), [trace]);
  const [hover, setHover] = useState<Hover | null>(null);
  return (
    <div className="dt-lane" data-own="">
      <span className="dt-lane-label">{word}</span>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the numbers on hover; the legend's buttons have them too. */}
      <div
        className="dt-lane-track dt-time-track"
        data-profiled={trace.profile ? "" : undefined}
        onPointerMove={(event) => setHover(hoverAt(event))}
        onPointerLeave={() => setHover(null)}
      >
        {lane.drawn.map((each) => (
          <span
            key={each.stretch.from}
            className="dt-stretch"
            data-category={each.gc ? GC : each.stretch.category}
            data-faded={faded(each, parts)}
            {...litKey(shareOf(each))}
            {...pieceData(each)}
            style={{ ...place(each.stretch, total), ...ends(each.stretch, total) }}
          />
        ))}
        {saidAt(lane.drawn).map((each) => (
          <span key={`said:${each.stretch.from}`} className="dt-quiet-said" style={place(each.stretch, total)}>
            <span className="dt-quiet-label">{quietLabel(lane, each)}</span>
          </span>
        ))}
        <LaneTip hover={hover} shares={shares} />
      </div>
    </div>
  );
}
