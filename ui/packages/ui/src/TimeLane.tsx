import {
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { partOfCategory } from "./CallMap";
import { duration } from "./format";
import { type Stretch, stretches } from "./lib/breakdown";
import { quietSpans } from "./lib/quiet";
import type { TimeRange } from "./lib/slice";
import { quietPieces } from "./lib/waiting";
import { WhatRan, WhatWaited } from "./ProfileHint";
import { useProfilingOf } from "./Profiling";
import { type ShareOf, ShareTip, sharesOf, TIP_CLASS } from "./TimeLegend";
import { ESCAPE_FIRST } from "./TimeSlice";
import type { Trace } from "./types";

/** Where a stretch sits on the lane, as CSS offsets. */
function place(stretch: Stretch, total: number): CSSProperties {
  return { left: `${(stretch.from / total) * 100}%`, width: `${((stretch.to - stretch.from) / total) * 100}%` };
}

/** Set on a stretch whose share isn't picked while others are: it steps back. */
function faded(stretch: Stretch, parts: readonly string[]): "" | undefined {
  return parts.length > 0 && !parts.includes(partOfCategory(stretch.category)) ? "" : undefined;
}

/** What the pointer is over: a share's stretch (a quiet piece of it says its span and its stretch), and where. */
interface Hover {
  category: string;
  span: string | undefined;
  range: TimeRange | undefined;
  waiting: boolean;
  x: number;
}

function hoverAt(event: PointerEvent<HTMLDivElement>): Hover | null {
  const over = (event.target as Element).closest<HTMLElement>("[data-category]");
  if (!over) return null;
  return {
    category: over.dataset["category"] ?? "",
    span: over.dataset["quiet"],
    range: rangeIn(over),
    waiting: over.dataset["waiting"] !== undefined,
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
 * Over the share under the pointer: its numbers. Over its code's own time, what that time is, what ran in it and the
 * way on (the profile, or Profile turned on): that one holds a button, so the pointer can travel into it.
 */
function LaneTip({
  hover,
  shares,
  lane,
  tip,
}: {
  hover: Hover | null;
  shares: readonly ShareOf[];
  lane: Lane;
  tip: Tip;
}) {
  const share = shares.find((each) => each.category === hover?.category);
  if (!(hover && share)) return null;
  if (hover.span) return <QuietTip hover={hover} lane={lane} share={share} tip={tip} />;
  return (
    <div role="tooltip" className={`dt-lane-tip ${TIP_CLASS}`} style={{ left: hover.x }}>
      <ShareTip share={share} />
    </div>
  );
}

/** Over a quiet stretch: with a way on, it holds while the pointer or focus is in it, and takes Esc first. */
function QuietTip({ hover, lane, share, tip }: { hover: Hover; lane: Lane; share: ShareOf; tip: Tip }) {
  const lines = <QuietLines hover={hover} lane={lane} share={share} onOpen={tip.onOpen} />;
  if (!tip.actionable) {
    return (
      <div role="tooltip" className={`dt-lane-tip ${QUIET_TIP_CLASS}`} style={{ left: hover.x }}>
        {lines}
      </div>
    );
  }
  return (
    <div
      role="tooltip"
      ref={tip.ref}
      className={`dt-lane-tip ${QUIET_TIP_CLASS}`}
      data-hoverable=""
      {...{ [ESCAPE_FIRST]: "" }}
      style={{ left: hover.x }}
      onPointerEnter={tip.hold}
      onPointerLeave={tip.release}
      onBlur={tip.blur}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {lines}
    </div>
  );
}

/**
 * A quiet piece's lines: waited in (what on, where), or computed in, of its share's time (its profile's functions, or
 * how to get one).
 */
function QuietLines({
  hover,
  lane,
  share,
  onOpen,
}: {
  hover: Hover;
  lane: Lane;
  share: ShareOf;
  onOpen: ((range: TimeRange | undefined) => void) | undefined;
}) {
  const totals = totalOf(lane, hover);
  const open = onOpen && (() => onOpen(hover.range));
  if (hover.waiting && hover.range)
    return <WhatWaited trace={lane.trace} range={hover.range} waited={totals} onOpen={open} />;
  return <Untraced lane={lane} share={share} range={hover.range} totals={totals} onOpen={open} />;
}

/** How long the quiet span under the pointer waited, or computed, in all. */
function totalOf(lane: Lane, hover: Hover): number {
  return lane.totals.get(`${hover.span}:${hover.waiting}`) ?? 0;
}

/** A piece its code computed in: its share's numbers, how much of them untraced, and what ran. */
function Untraced({
  lane,
  share,
  range,
  totals,
  onOpen,
}: {
  lane: Lane;
  share: ShareOf;
  range: TimeRange | undefined;
  totals: number;
  onOpen: (() => void) | undefined;
}) {
  return (
    <>
      <span className="flex items-center gap-2">
        <ShareTip share={share} />
      </span>
      <span className="flex items-center gap-2">
        <span className="dt-swatch" data-quiet="" data-category={share.category} />
        <span>Of it {duration(totals)} untraced</span>
      </span>
      <WhatRan trace={lane.trace} range={range} onOpen={onOpen} />
    </>
  );
}

/** The tooltip's look, a few lines: what a quiet stretch is, and where to see what ran in it. */
const QUIET_TIP_CLASS =
  "grid w-80 gap-1.5 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-[var(--dt-popover-shadow)]";

/** Each stretch, and when it is a span's own time with no recorded calls, the span and whether it waited then. */
interface Drawn {
  stretch: Stretch;
  quiet: boolean;
  waiting: boolean;
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
  }));
}

function laneOf(trace: Trace): Lane {
  const quiet = quietSpans(trace);
  const drawn = stretches(trace).flatMap((stretch): Drawn[] =>
    stretch.quiet && quiet.has(stretch.span)
      ? piecesOfStretch(trace, stretch)
      : [{ stretch, quiet: false, waiting: false }],
  );
  const totals = new Map<string, number>();
  for (const { stretch, waiting } of drawn.filter((each) => each.quiet)) {
    const key = `${stretch.span}:${waiting}`;
    totals.set(key, (totals.get(key) ?? 0) + length(stretch));
  }
  return { trace, drawn, totals };
}

/** Where a quiet span's time is said: over the longest of its pieces that waited, and of those that didn't, once. */
function saidAt(drawn: readonly Drawn[]): Drawn[] {
  const longest = new Map<string, Drawn>();
  for (const each of drawn.filter((item) => item.quiet)) {
    const key = `${each.stretch.span}:${each.waiting}`;
    const best = longest.get(key);
    if (!best || length(each.stretch) > length(best.stretch)) longest.set(key, each);
  }
  return [...longest.values()];
}

function length(stretch: Stretch): number {
  return stretch.to - stretch.from;
}

/** "untraced · 1.6 s", "waiting · 1.5 s": a quiet span's own time, waited in or not, in its share's colour. */
function quietLabel(lane: Lane, each: Drawn): string {
  const total = lane.totals.get(`${each.stretch.span}:${each.waiting}`) ?? 0;
  const label = each.waiting ? "waiting" : "untraced";
  return `${label} · ${duration(total)}`;
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

/** How long a tooltip that holds a button stays once the pointer left, on its way into it. */
const GRACE_MS = 200;

/** The tooltip's hold on itself: the pointer in it, focus in it, the way on. */
interface Tip {
  ref: RefObject<HTMLDivElement | null>;
  hold: () => void;
  release: () => void;
  blur: (event: FocusEvent<HTMLElement>) => void;
  onOpen: ((range: TimeRange | undefined) => void) | undefined;
  /** Whether a quiet stretch's tooltip has a way on: only then does it hold. */
  actionable: boolean;
}

/**
 * What the pointer (or the keyboard) is over, said in a tooltip: a share's numbers go with the pointer; a quiet
 * stretch's tooltip holds a button, so it stays a moment after the pointer left, and while the pointer or focus is in
 * it; Esc closes it.
 */
function useLaneHover(onOpen: Tip["onOpen"], actionable: boolean) {
  const [hover, setHover] = useState<Hover | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const hold = () => window.clearTimeout(timer.current);
  const release = () => {
    hold();
    timer.current = window.setTimeout(() => setHover(null), GRACE_MS);
  };
  // Leaving a tooltip that holds: it stays a moment, for the pointer on its way into it.
  const holds = Boolean(hover?.span) && actionable;
  const show = (next: Hover | null) => {
    if (!next && holds) return release();
    hold();
    setHover(next);
  };
  const blur = (event: FocusEvent<HTMLElement>) => {
    if (!ref.current?.contains(event.relatedTarget as Node | null)) release();
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEscapeCloses(holds, () => setHover(null));
  const tip: Tip = { ref, hold, release, blur, onOpen, actionable };
  return { hover, show, tip };
}

/** While `open`, Esc closes (`close`) what holds it. */
function useEscapeCloses(open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

/** A quiet piece, from the keyboard: its tooltip, under its middle, as the pointer would open it. */
function focusAt(event: FocusEvent<HTMLElement>, each: Drawn): Hover | null {
  if (!event.currentTarget.matches(":focus-visible")) return null;
  const track = event.currentTarget.parentElement?.getBoundingClientRect();
  const box = event.currentTarget.getBoundingClientRect();
  return {
    category: each.stretch.category,
    span: each.stretch.span,
    range: [each.stretch.from, each.stretch.to],
    waiting: each.waiting,
    x: box.left + box.width / 2 - (track?.left ?? 0),
  };
}

/**
 * Over a quiet span's longest stretch: how long it ran, waited in or not. A button for the keyboard: focused, its
 * tooltip opens (its way on is the next Tab); Enter opens the profile there, as a click on the stretch does.
 */
function QuietSaid({
  lane,
  each,
  total,
  show,
  tip,
}: {
  lane: Lane;
  each: Drawn;
  total: number;
  show: (hover: Hover | null) => void;
  tip: Tip;
}) {
  const label = quietLabel(lane, each);
  const open = tip.onOpen;
  return (
    <button
      type="button"
      className="dt-quiet-said"
      style={place(each.stretch, total)}
      aria-label={label}
      // Reached from the keyboard where its tooltip has a way on: the profile, or Profile to turn on.
      tabIndex={tip.actionable ? 0 : -1}
      onFocus={(event) => show(focusAt(event, each))}
      onBlur={tip.blur}
      onClick={(event) => {
        event.stopPropagation();
        open?.([each.stretch.from, each.stretch.to]);
      }}
    >
      <span className="dt-quiet-label">{label}</span>
    </button>
  );
}

/**
 * The trace's own lane: where its time went, moment by moment, in its shares' colours (the legend's); a long
 * stretch where its code ran with no recorded calls hatched and said, split where the profile says it waited. A
 * share's stretch says its numbers on hover, and picks its rows on a click; a quiet one opens the profile (`onQuiet`).
 */
export function TimeLane({
  trace,
  word,
  parts,
  onQuiet,
}: {
  trace: Trace;
  word: string;
  parts: readonly string[];
  onQuiet: ((range: TimeRange | undefined) => void) | undefined;
}) {
  const total = Math.max(trace.duration, 1);
  const lane = useMemo(() => laneOf(trace), [trace]);
  const shares = useMemo(() => sharesOf(trace), [trace]);
  const profiling = useProfilingOf(trace);
  const actionable = Boolean(trace.profile && onQuiet) || profiling.available;
  const { hover, show, tip } = useLaneHover(onQuiet, actionable);
  return (
    <div className="dt-lane" data-own="">
      <span className="dt-lane-label">{word}</span>
      <div className="dt-lane-cell">
        <div
          className="dt-lane-track dt-time-track"
          onPointerMove={(event) => show(hoverAt(event))}
          onPointerLeave={() => show(null)}
        >
          {lane.drawn.map((each) => (
            <span
              key={each.stretch.from}
              className="dt-stretch"
              data-category={each.stretch.category}
              data-faded={faded(each.stretch, parts)}
              {...pieceData(each)}
              style={place(each.stretch, total)}
            />
          ))}
          {saidAt(lane.drawn).map((each) => (
            <QuietSaid key={`said:${each.stretch.from}`} lane={lane} each={each} total={total} show={show} tip={tip} />
          ))}
        </div>
        <LaneTip hover={hover} shares={shares} lane={lane} tip={tip} />
      </div>
    </div>
  );
}
