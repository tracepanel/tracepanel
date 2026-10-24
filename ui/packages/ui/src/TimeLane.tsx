import { type CSSProperties, type PointerEvent, useMemo, useState } from "react";
import { partOfCategory } from "./CallMap";
import { duration } from "./format";
import { categoryLabel, type Stretch, stretches } from "./lib/breakdown";
import { percent } from "./lib/percent";
import { ownHotspots } from "./lib/profile";
import { type Quiet, quietSpans } from "./lib/quiet";
import { useProfiling } from "./Profiling";
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

/** Over the share under the pointer: its numbers; over its code's own time, what that time is and what ran in it. */
function LaneTip({ hover, shares, trace }: { hover: Hover | null; shares: readonly ShareOf[]; trace: Trace }) {
  const share = shares.find((each) => each.category === hover?.category);
  if (!(hover && share)) return null;
  if (hover.quiet) {
    return (
      <div role="tooltip" className={`dt-lane-tip ${QUIET_TIP_CLASS}`} style={{ left: hover.x }}>
        <span className="flex items-center gap-2">
          <ShareTip share={share} />
        </span>
        <span className="flex items-center gap-2">
          <span className="dt-swatch" data-quiet="" data-category={share.category} />
          <span>Of it {hover.quiet} with nothing recorded inside</span>
        </span>
        <WhatRan trace={trace} />
      </div>
    );
  }
  return (
    <div role="tooltip" className={`dt-lane-tip ${TIP_CLASS}`} style={{ left: hover.x }}>
      <ShareTip share={share} />
    </div>
  );
}

/** The tooltip's look, a few lines: what a quiet stretch is, and where to see what ran in it. */
const QUIET_TIP_CLASS =
  "grid w-80 gap-1.5 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-[var(--dt-popover-shadow)]";

/**
 * What ran in the code's own time: the trace's profile, which samples it (the whole trace's: its samples aren't
 * timed, so not this stretch's alone), its own functions by where they were when sampled; without one, how to get
 * one, unless the app doesn't profile.
 */
function WhatRan({ trace }: { trace: Trace }) {
  const profiling = useProfiling();
  if (trace.profile) return <Hotspots profile={trace.profile} />;
  if (!profiling.available) return null;
  return (
    <span className="text-muted-foreground">
      To see what ran here, turn on Profile and run it again
      {profiling.turnOn
        ? " (Profile, in the legend below)."
        : ": the panel's Profile toggle, or an X-Tracepanel-Profile: 1 header."}
    </span>
  );
}

function Hotspots({ profile }: { profile: NonNullable<Trace["profile"]> }) {
  const hotspots = ownHotspots(profile);
  return (
    <span className="text-muted-foreground">
      {hotspots.length ? "Where your code was, over the whole trace's profile (its samples aren't timed): " : null}
      {hotspots.map(({ name, share }) => `${name} ${percent(share, 1)}`).join(" · ")}
      {hotspots.length ? ". " : null}
      Click to open the profile.
    </span>
  );
}

/** "your code · 1.6 s": a span's own time, its share's, hatched, with nothing it called recorded inside. */
function quietLabel(label: string, quiet: string): string {
  return `${label.toLowerCase()} · ${quiet}`;
}

/** Each stretch, with what it says when it is a span's own time with no recorded calls (it is hatched then). */
interface Drawn {
  stretch: Stretch;
  quiet: string | undefined;
}

function drawnOf(list: readonly Stretch[], quiet: ReadonlyMap<string, Quiet>): Drawn[] {
  return list.map((stretch) => {
    const of = stretch.quiet ? quiet.get(stretch.span) : undefined;
    return { stretch, quiet: of ? duration(of.total) : undefined };
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
            data-quiet={quiet}
            style={place(stretch, total)}
          />
        ))}
        {saidAt(drawn).map(({ stretch, quiet }) => (
          <span key={`said:${stretch.from}`} className="dt-quiet-said" style={place(stretch, total)}>
            <span className="dt-quiet-label">{quietLabel(categoryLabel(stretch.category, trace), quiet ?? "")}</span>
          </span>
        ))}
        <LaneTip hover={hover} shares={shares} trace={trace} />
      </div>
    </div>
  );
}
