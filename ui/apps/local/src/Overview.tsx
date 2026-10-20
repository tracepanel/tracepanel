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

/** A folded overview's numbers, on one line: each a child. */
export function OverviewNumbers({ children }: { children: ReactNode }) {
  return <span className="flex flex-wrap gap-x-4 text-md text-text-2 tabular-nums">{children}</span>;
}

/**
 * An overview: its heading folds it (the chevron, "Overview", then `range` open or `numbers` folded), `children` are
 * what it shows open. The ring shows for the keyboard only: a click lets go of it.
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
        <button
          type="button"
          className="group/overview flex w-full items-center gap-3 rounded-md py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={onToggle}
          aria-expanded={open}
        >
          <ChevronRightIcon
            className={`size-5 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
          />
          <h2 className="text-xl font-semibold">Overview</h2>
          {open ? range : numbers}
        </button>
      </header>
      {open ? children : null}
    </section>
  );
}
