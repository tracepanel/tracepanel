import { type CSSProperties, type PointerEvent, useMemo, useState } from "react";
import { partOfCategory } from "./CallMap";
import { duration } from "./format";
import { quietStretches, type Stretch, stretches } from "./lib/breakdown";
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

/** "1.5 s · no recorded calls": a stretch where the code ran on its own, nothing it called recorded. */
function quietLabel(stretch: Stretch): string {
  return `${duration(stretch.to - stretch.from)} · no recorded calls`;
}

/**
 * The trace's own lane: where its time went, moment by moment, in its shares' colours (the legend's); a long
 * stretch where its code ran with no recorded calls hatched and said. A share's stretch picks its rows on a click
 * (the lanes take it), and says its numbers on hover.
 */
export function TimeLane({ trace, word, parts }: { trace: Trace; word: string; parts: readonly string[] }) {
  const total = Math.max(trace.duration, 1);
  const list = useMemo(() => stretches(trace), [trace]);
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
        {list.map((stretch) => (
          <span
            key={stretch.from}
            className="dt-stretch"
            data-category={stretch.category}
            data-faded={faded(stretch, parts)}
            style={place(stretch, total)}
          />
        ))}
        {quietStretches(list, total).map((stretch) => (
          <span
            key={`quiet:${stretch.from}`}
            className="dt-quiet"
            data-category={stretch.category}
            data-quiet={quietLabel(stretch)}
            style={place(stretch, total)}
          >
            <span className="dt-quiet-label">{quietLabel(stretch)}</span>
          </span>
        ))}
        <LaneTip hover={hover} shares={shares} />
      </div>
    </div>
  );
}
