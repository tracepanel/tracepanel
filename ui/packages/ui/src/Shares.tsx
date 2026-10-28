// A whole split into its shares, said one way wherever one is: the call tree's legend of the trace's time and the
// Profile tab's time by package. A bar of the shares, and a legend of them, inline: swatch, name, how long in bold,
// its percent muted; largest first, waiting last.
import type { ReactNode } from "react";
import { cn } from "./lib/utils";
import { litKey } from "./lit";

/** A share as the legend says it: its swatch, its name, how long, its percent. */
export function ShareFace({
  swatch,
  name,
  value,
  share,
}: {
  swatch: ReactNode;
  name: ReactNode;
  value: string;
  share: string;
}) {
  return (
    <>
      {swatch}
      {name}
      <b>{value}</b>
      <span className="dt-breakdown-share">{share}</span>
    </>
  );
}

/** Largest first; a higher `rank` after the rest whatever its size (the rest folded together, then waiting). */
export function largestFirst<T>(items: readonly T[], size: (item: T) => number, rank: (item: T) => number): T[] {
  return [...items].sort((a, b) => rank(a) - rank(b) || size(b) - size(a));
}

/** One share on the bar: how much, its colour (a class), what it says on hover, whether it steps back. */
export interface BarPart {
  key: string;
  size: number;
  className: string;
  title: string;
  faded: boolean;
}

/** The shares on one bar, side by side, 2px apart; hatched only where its colour says waiting. */
export function ShareBar({ parts, total }: { parts: readonly BarPart[]; total: number }) {
  return (
    <div className="dt-share-bar">
      {parts.map((part) => (
        <span
          key={part.key}
          title={part.title}
          {...litKey(part.key)}
          className={cn(part.className, part.faded && "opacity-30")}
          style={{ width: `${(part.size / Math.max(total, 1)) * 100}%` }}
        />
      ))}
    </div>
  );
}
