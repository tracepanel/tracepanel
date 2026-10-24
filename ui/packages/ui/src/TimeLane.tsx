import { type CSSProperties, type PointerEvent, type ReactNode, useMemo, useState } from "react";
import { partOfCategory } from "./CallMap";
import { type Stretch, stretches } from "./lib/breakdown";
import { quietSpans } from "./lib/quiet";
import type { TimeRange } from "./lib/slice";
import { quietPieces } from "./lib/waiting";
import { type Shares, ShareTip, sharesOf, TIP_CLASS, WaitTip } from "./TimeLegend";
import type { Trace } from "./types";

/** Where a stretch sits on the lane, as CSS offsets. */
function place(stretch: Stretch, total: number): CSSProperties {
  return { left: `${(stretch.from / total) * 100}%`, width: `${((stretch.to - stretch.from) / total) * 100}%` };
}

/** Set on a stretch whose share isn't picked while others are: it steps back. */
function faded(stretch: Stretch, parts: readonly string[]): "" | undefined {
  return parts.length > 0 && !parts.includes(partOfCategory(stretch.category)) ? "" : undefined;
}

/** What the pointer is over: a share's stretch, and where. */
interface Hover {
  category: string;
  waiting: boolean;
  x: number;
}

function hoverAt(event: PointerEvent<HTMLDivElement>): Hover | null {
  const over = (event.target as Element).closest<HTMLElement>("[data-category]");
  if (!over) return null;
  return {
    category: over.dataset["category"] ?? "",
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
 * Over the share under the pointer: its numbers, its code's own time too; over a wait, the waiting's. Nothing more:
 * the call tree's code rows name what ran there, and with a profile a click opens it.
 */
function LaneTip({ hover, shares }: { hover: Hover | null; shares: Shares }) {
  const tip = hover ? tipOf(hover, shares) : null;
  if (!(hover && tip)) return null;
  return (
    <div role="tooltip" className={`dt-lane-tip ${TIP_CLASS}`} style={{ left: hover.x }}>
      {tip}
    </div>
  );
}

function tipOf(hover: Hover, shares: Shares): ReactNode {
  if (hover.waiting) return <WaitTip waiting={shares.waiting} total={shares.total} />;
  const share = shares.shares.find((each) => each.category === hover.category);
  return share ? <ShareTip share={share} /> : null;
}

/**
 * A run of the lane in one look: its share's colour, or waiting; where it is a span's own time with no recorded calls
 * (some of it), that span, for a click to open the profile at it.
 */
interface Run {
  stretch: Stretch;
  waiting: boolean;
  quiet: string | null;
  /** Right after another run: a gap before it, as between a bar's shares. */
  cut: boolean;
}

/** A stretch in its pieces: a quiet one's waited in and computed in (one, computed, where the profile can't say). */
function piecesOfStretch(trace: Trace, stretch: Stretch, quiet: boolean): Omit<Run, "cut">[] {
  if (!quiet) return [{ stretch, waiting: false, quiet: null }];
  return quietPieces(trace.profile, stretch.from, stretch.to).map((piece) => ({
    stretch: { ...stretch, from: piece.from, to: piece.to },
    waiting: piece.waiting,
    quiet: stretch.span,
  }));
}

/** Whether a piece goes on the run before it: right after it, in the same look. */
function continues(last: Run, piece: Omit<Run, "cut">): boolean {
  return (
    last.stretch.to === piece.stretch.from &&
    last.stretch.category === piece.stretch.category &&
    last.waiting === piece.waiting
  );
}

/** A piece after the last run: the same look makes it longer, another starts a run, after a gap where they touch. */
function addPiece(runs: Run[], piece: Omit<Run, "cut">): void {
  const last = runs.at(-1);
  if (last && continues(last, piece)) {
    last.stretch = { ...last.stretch, to: piece.stretch.to };
    last.quiet ??= piece.quiet;
  } else runs.push({ ...piece, stretch: { ...piece.stretch }, cut: last?.stretch.to === piece.stretch.from });
}

/** The lane's runs: moment by moment, a stretch of one look made one, however many spans ran in it. */
function runsOf(trace: Trace): Run[] {
  const quiet = quietSpans(trace);
  const runs: Run[] = [];
  for (const stretch of stretches(trace)) {
    for (const piece of piecesOfStretch(trace, stretch, stretch.quiet && quiet.has(stretch.span)))
      addPiece(runs, piece);
  }
  return runs;
}

/** What a run says of itself: its span when quiet, its stretch, whether it waited, whether a gap comes before it. */
function runData(run: Run): Record<string, string | undefined> {
  return {
    "data-waiting": run.waiting ? "" : undefined,
    "data-cut": run.cut ? "" : undefined,
    ...(run.quiet
      ? { "data-quiet": run.quiet, "data-from": String(run.stretch.from), "data-to": String(run.stretch.to) }
      : {}),
  };
}

/**
 * The trace's own lane: where its time went, moment by moment, one line in its shares' colours (the legend's), its
 * code's own time solid in its share's, a wait hatched where the profile says so. A share's stretch says its numbers
 * on hover, and picks its rows on a click; the code's own time, with a profile, opens it.
 */
export function TimeLane({ trace, word, parts }: { trace: Trace; word: string; parts: readonly string[] }) {
  const total = Math.max(trace.duration, 1);
  const runs = useMemo(() => runsOf(trace), [trace]);
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
        <div className="dt-bar" data-timed="">
          {runs.map((run) => (
            <span
              key={run.stretch.from}
              className="dt-stretch"
              data-category={run.stretch.category}
              data-faded={faded(run.stretch, parts)}
              {...runData(run)}
              style={place(run.stretch, total)}
            />
          ))}
        </div>
        <LaneTip hover={hover} shares={shares} />
      </div>
    </div>
  );
}
