import { type CSSProperties, type PointerEvent, useMemo, useState } from "react";
import { partOfCategory } from "./CallMap";
import { duration } from "./format";
import { type Stretch, stretches } from "./lib/breakdown";
import { cutByPauses, GC, gcPauses } from "./lib/memory";
import { quietSpans } from "./lib/quiet";
import type { TimeRange } from "./lib/slice";
import { quietPieces } from "./lib/waiting";
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
    category: over.dataset["category"] ?? "",
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

/** The lane: its pieces, and how long each quiet span's code waited and computed (`span:waiting`). */
interface Lane {
  trace: Trace;
  drawn: Drawn[];
  totals: Map<string, number>;
}

/** A quiet stretch in its pieces: waited in, computed in (one, computed, where the profile can't say). */
function piecesOfStretch(trace: Trace, stretch: Stretch): Drawn[] {
  return quietPieces(trace.profile, stretch.from, stretch.to).map((piece) => ({
    stretch: { ...stretch, from: piece.from, to: piece.to },
    quiet: true,
    waiting: piece.waiting,
    gc: false,
  }));
}

/** A piece of the lane with the collector's pauses cut out of it: those its own pieces, the GC share's. */
function cutOut(each: Drawn, pauses: readonly TimeRange[]): Drawn[] {
  return cutByPauses(each.stretch.from, each.stretch.to, pauses).map(({ range: [from, to], gc }) =>
    gc
      ? { stretch: { ...each.stretch, from, to }, quiet: false, waiting: false, gc }
      : { ...each, stretch: { ...each.stretch, from, to } },
  );
}

function laneOf(trace: Trace): Lane {
  const quiet = quietSpans(trace);
  const pauses = gcPauses(trace.profile, trace.duration);
  const drawn = stretches(trace)
    .flatMap((stretch): Drawn[] =>
      stretch.quiet && quiet.has(stretch.span)
        ? piecesOfStretch(trace, stretch)
        : [{ stretch, quiet: false, waiting: false, gc: false }],
    )
    .flatMap((each) => cutOut(each, pauses));
  const totals = new Map<string, number>();
  for (const { stretch, waiting } of drawn.filter((each) => each.quiet)) {
    const key = `${stretch.span}:${waiting}`;
    totals.set(key, (totals.get(key) ?? 0) + length(stretch));
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
  return `waiting · ${duration(lane.totals.get(`${each.stretch.span}:true`) ?? 0)}`;
}

/** What a piece of the lane says of itself: its span when quiet, its stretch, whether it waited. */
function pieceData(each: Drawn): Record<string, string | undefined> {
  if (!each.quiet) return {};
  return {
    "data-quiet": each.stretch.span,
    "data-from": String(each.stretch.from),
    "data-to": String(each.stretch.to),
    "data-waiting": each.waiting ? "" : undefined,
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
            {...litKey(each.gc ? GC : each.stretch.category)}
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
