// The Overview at the top of a page's list, one look wherever it is (an entry point's page, Logs): a heading that
// folds it, its time range while open, its numbers on one line while folded. Folded or not, as this browser left it.
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

const STORAGE_KEY = "tracepanel:overview";

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "closed";
  } catch {
    return true;
  }
}

/** Whether the overviews are open, and what folds or opens them: one choice for every page's. */
export function useOverviewOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(readOpen);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(STORAGE_KEY, open ? "closed" : "open");
    } catch {
      // Private mode: the choice lasts until reload.
    }
  };
  return [open, toggle];
}

/** The time an overview covers, on the 24-hour clock the console's tables and charts use: "20/10/2026, 14:05:00 – 15:05:00". */
export function OverviewRange({ from, to }: { from: number; to: number }) {
  const start = new Date(from / 1000);
  const end = new Date(to / 1000);
  // The end's date only when it is another day's: "20/10/2026, 09:29:34 – 21/10/2026, 13:26:06".
  const sameDay = start.toDateString() === end.toDateString();
  return (
    <span className="text-sm text-muted-foreground tabular-nums">
      {start.toLocaleString([], { hour12: false })} –{" "}
      {sameDay ? end.toLocaleTimeString([], { hour12: false }) : end.toLocaleString([], { hour12: false })}
    </span>
  );
}

/** A folded overview's numbers, on one line: each a `Figure`, with a rule between them. */
export function OverviewNumbers({ children }: { children: ReactNode }) {
  return <span className="flex flex-wrap items-baseline gap-y-1 text-md">{children}</span>;
}

export const FIGURE = "flex items-baseline gap-1.5 border-border px-4 tabular-nums not-first:border-l first:pl-0";
const INK = { error: "text-error", warn: "text-warn", plain: "text-foreground" } as const;

/**
 * One number of a summary line: the value in the ink of what it counts, its label quiet after it (`1,308 runs`).
 * The Overview folded and the Tasks page's Now say their numbers this way. The space between them is in the text, so
 * the line reads "1,308 runs" aloud and when copied.
 */
export function Figure({ value, label, tone = "plain" }: { value: ReactNode; label: string; tone?: keyof typeof INK }) {
  return (
    <span className={FIGURE}>
      <b className={`font-semibold ${INK[tone]}`}>{value}</b>
      <span className="text-muted-foreground"> {label}</span>
    </span>
  );
}

/** A `Figure` whose label names it before it: `p95 134 ms`. */
export function Measure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className={FIGURE}>
      <span className="text-muted-foreground">{label} </span>
      <b className="font-semibold text-foreground">{value}</b>
    </span>
  );
}

/**
 * An overview: one bar, the same open or folded (the chevron, "Overview", its `numbers`, its `range` at the end), that
 * opens `children` under it. Only the chevron turns: nothing on the bar moves or changes size.
 */
export function OverviewSection({
  open,
  onToggle,
  range,
  numbers,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  range: ReactNode;
  numbers: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 pb-8" aria-label="Overview">
      <header>
        <OverviewHeading open={open} onToggle={onToggle} range={range}>
          {numbers}
        </OverviewHeading>
      </header>
      {open ? children : null}
    </section>
  );
}

/** The bar that folds an overview: `children` after "Overview", `range` at its end. The ring is the keyboard's only. */
function OverviewHeading({
  open,
  onToggle,
  range,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  range: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-4 py-3 text-left outline-none transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      onClick={onToggle}
      aria-expanded={open}
    >
      <span className="flex items-center gap-3">
        <ChevronRightIcon
          className={`size-5 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        <h2 className="text-md font-semibold">Overview</h2>
      </span>
      {children}
      <span className="ml-auto">{range}</span>
    </button>
  );
}
