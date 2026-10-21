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
  return (
    <span className="text-base text-muted-foreground">
      {new Date(from / 1000).toLocaleString([], { hour12: false })} –{" "}
      {new Date(to / 1000).toLocaleTimeString([], { hour12: false })}
    </span>
  );
}

/** A folded overview's numbers, on one line: each a `Figure`, with a rule between them. */
export function OverviewNumbers({ children }: { children: ReactNode }) {
  return <span className="flex flex-wrap items-baseline gap-y-1 text-md">{children}</span>;
}

const FIGURE = "flex items-baseline gap-1.5 border-border px-4 tabular-nums not-first:border-l first:pl-0";
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

/** Folded, the heading is a bar like the tiles it hides, so it reads as one thing to open. */
const FOLDED_LOOK = {
  bar: "border bg-card px-4 py-3 transition-colors hover:bg-accent",
  heading: "text-md font-semibold",
  chevron: "",
};
const OPEN_LOOK = { bar: "py-1", heading: "text-xl font-semibold", chevron: "rotate-90" };

/**
 * An overview: its heading folds it (the chevron, "Overview", then `range` open or `numbers` folded), `children` are
 * what it shows open.
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
    <section className="grid gap-5 pb-8" aria-label="Overview">
      <header>
        <OverviewHeading open={open} onToggle={onToggle}>
          {open ? range : numbers}
        </OverviewHeading>
      </header>
      {open ? children : null}
    </section>
  );
}

/** The heading that folds an overview, `children` after "Overview". The ring shows for the keyboard only. */
function OverviewHeading({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const look = open ? OPEN_LOOK : FOLDED_LOOK;
  return (
    <button
      type="button"
      className={`group/overview flex w-full items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${look.bar}`}
      onClick={onToggle}
      aria-expanded={open}
    >
      <ChevronRightIcon className={`size-5 text-muted-foreground transition-transform ${look.chevron}`} />
      <h2 className={look.heading}>Overview</h2>
      {children}
    </button>
  );
}
