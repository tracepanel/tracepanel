// Shares of a time, one look wherever they are drawn: the time strip's legend and the Profile tab's packages. A bar
// of the shares, largest first and waiting last, solid in each one's colour (waiting, no code's time, hatched); a
// legend of them inline, each its swatch, its name, how long in bold and of the whole muted.
import type { ComponentProps, CSSProperties } from "react";
import { duration } from "./format";
import { percent } from "./lib/percent";
import { cn } from "./lib/utils";

/** How a share is coloured: a category's colour (the strip's), or a colour of its own (a package's); waiting hatched. */
export interface ShareLook {
  category?: string | undefined;
  colour?: string | undefined;
  waiting?: boolean | undefined;
}

/** A share's colour, as data attributes and a style: on a bar's part, on a swatch. */
function lookOf(look: ShareLook): {
  "data-category"?: string | undefined;
  "data-waiting"?: string | undefined;
  style?: CSSProperties;
} {
  return {
    "data-category": look.category,
    "data-waiting": look.waiting ? "" : undefined,
    ...(look.colour ? { style: { "--dt-k": look.colour } as CSSProperties } : {}),
  };
}

/** Largest first, waiting last: the order every bar and legend of shares is in. */
export function ordered<T>(items: readonly T[], value: (item: T) => number, waiting: (item: T) => boolean): T[] {
  return [...items].sort((a, b) => Number(waiting(a)) - Number(waiting(b)) || value(b) - value(a));
}

export function ShareSwatch({ look }: { look: ShareLook }) {
  return <span className="dt-swatch" {...lookOf(look)} />;
}

/** "Database 7 ms 13%": its name, how long, of the whole. */
function ShareWords({ name, value, total }: { name: string; value: number; total: number }) {
  return (
    <>
      <span className="dt-share-name">{name}</span>
      <b>{duration(value)}</b>
      <span className="dt-breakdown-share">{percent(value, total)}</span>
    </>
  );
}

interface ShareItem {
  name: string;
  value: number;
  total: number;
  look: ShareLook;
}

/** A share in a legend that picks something: pressed while it is picked. */
export function ShareButton({ name, value, total, look, className, ...props }: ShareItem & ComponentProps<"button">) {
  return (
    <button type="button" className={cn("dt-share", className)} {...props}>
      <ShareSwatch look={look} />
      <ShareWords name={name} value={value} total={total} />
    </button>
  );
}

/** A share in a legend that only says itself. */
export function ShareText({ name, value, total, look, className, ...props }: ShareItem & ComponentProps<"span">) {
  return (
    <span className={cn("dt-share", className)} data-static="" {...props}>
      <ShareSwatch look={look} />
      <ShareWords name={name} value={value} total={total} />
    </span>
  );
}

export interface BarPart {
  key: string;
  value: number;
  look: ShareLook;
  title?: string;
  faded?: boolean;
}

/** The shares as one bar, in the order given, each as wide as its share of the whole. */
export function ShareBar({ parts, total, label }: { parts: readonly BarPart[]; total: number; label: string }) {
  return (
    <div className="dt-bar" role="img" aria-label={label}>
      {parts.map((part) => {
        const { style, ...data } = lookOf(part.look);
        return (
          <span
            key={part.key}
            className="dt-bar-part"
            title={part.title}
            data-faded={part.faded ? "" : undefined}
            {...data}
            style={{ ...style, flexGrow: part.value / Math.max(total, 1) }}
          />
        );
      })}
    </div>
  );
}
