import { type CSSProperties, type PointerEvent, useMemo, useState } from "react";
import { partOfCategory } from "./CallMap";
import { duration } from "./format";
import { type Stretch, stretches } from "./lib/breakdown";
import { type Quiet, quietSpans } from "./lib/quiet";
import { type ShareOf, ShareTip, sharesOf, TIP_CLASS } from "./TimeLegend";
import type { Trace } from "./types";

/** Where a stretch sits on the lane, as CSS offsets. */
function place(stretch: Stretch, total: number): CSSProperties {
  return { left: `${(stretch.from / total) * 100}%`, width: `${((stretch.to - stretch.from) / total) * 100}%` };
}

/** Set on a stretch whose share isn't picked while others are: it steps back. */
function faded(stretch: Stretch, parts: readonly string[]): "" | undefined {
  return parts.length > 0 && !parts.includes(partOfCategory(stretch.category)) ? "" : undefined;
}

/** What the pointer is over: a share's stretch (a quiet one says how long it was quiet), and where. */
interface Hover {
  category: string;
  quiet: string | undefined;
  x: number;
}

function hoverAt(event: PointerEvent<HTMLDivElement>): Hover | null {
  const over = (event.target as Element).closest<HTMLElement>("[data-category]");
  if (!over) return null;
  return {
    category: over.dataset["category"] ?? "",
    quiet: over.dataset["quiet"],
    x: event.clientX - event.currentTarget.getBoundingClientRect().left,
  };
}

/** The numbers of the share under the pointer, over it. */
function LaneTip({ hover, shares }: { hover: Hover | null; shares: readonly ShareOf[] }) {
  const share = shares.find((each) => each.category === hover?.category);
  if (!(hover && share)) return null;
  return (
    <div role="tooltip" className={`dt-lane-tip ${TIP_CLASS}`} style={{ left: hover.x }}>
      <ShareTip share={share} />
      {hover.quiet ? <span className="text-muted-foreground">· {hover.quiet}</span> : null}
    </div>
  );
}

/** "1.6 s · no recorded calls": a span's own time with nothing it called recorded. */
function quietLabel(quiet: Quiet): string {
  return `${duration(quiet.total)} · no recorded calls`;
}

/** Each stretch, with what it says when it is a span's own time with no recorded calls (it is hatched then). */
interface Drawn {
  stretch: Stretch;
  quiet: string | undefined;
}

function drawnOf(list: readonly Stretch[], quiet: ReadonlyMap<string, Quiet>): Drawn[] {
  return list.map((stretch) => {
    const of = stretch.quiet ? quiet.get(stretch.span) : undefined;
    return { stretch, quiet: of ? quietLabel(of) : undefined };
  });
}

/** Where a quiet span's time is said: over the longest of its hatched stretches, once. */
function saidAt(drawn: readonly Drawn[]): Drawn[] {
  const longest = new Map<string, Drawn>();
  for (const each of drawn.filter((item) => item.quiet)) {
    const best = longest.get(each.stretch.span);
    if (!best || length(each.stretch) > length(best.stretch)) longest.set(each.stretch.span, each);
  }
  return [...longest.values()];
}

function length(stretch: Stretch): number {
  return stretch.to - stretch.from;
}

/** What the strip says of where to look next: the trace's profile, or how to get one. */
function profileHint(trace: Trace): string {
  return trace.profile ? "its Profile tab shows what ran" : "turn on Profile to see what ran";
}

/**
 * The trace's own lane: where its time went, moment by moment, in its shares' colours (the legend's); a long
 * stretch where its code ran with no recorded calls hatched and said. A share's stretch says its numbers on hover,
 * and picks its rows on a click where the lanes take it (over the call tree).
 */
export function TimeLane({ trace, word, parts }: { trace: Trace; word: string; parts: readonly string[] }) {
  const total = Math.max(trace.duration, 1);
  const drawn = useMemo(() => drawnOf(stretches(trace), quietSpans(trace)), [trace]);
  const shares = useMemo(() => sharesOf(trace), [trace]);
  const [hover, setHover] = useState<Hover | null>(null);
  return (
    <div className="dt-lane" data-own="">
      <span className="dt-lane-label">{word}</span>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the numbers on hover; the legend's buttons have them too. */}
      <div
        className="dt-lane-track dt-time-track"
        onPointerMove={(event) => setHover(hoverAt(event))}
        onPointerLeave={() => setHover(null)}
      >
        {drawn.map(({ stretch, quiet }) => (
          <span
            key={stretch.from}
            className="dt-stretch"
            data-category={stretch.category}
            data-faded={faded(stretch, parts)}
            data-quiet={quiet ? `${quiet}: ${profileHint(trace)}` : undefined}
            style={place(stretch, total)}
          />
        ))}
        {saidAt(drawn).map(({ stretch, quiet }) => (
          <span key={`said:${stretch.from}`} className="dt-quiet-said" style={place(stretch, total)}>
            <span className="dt-quiet-label">{quiet}</span>
          </span>
        ))}
        <LaneTip hover={hover} shares={shares} />
      </div>
    </div>
  );
}
