import { EllipsisIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { useMenuOpen } from "./hooks/useCloseOnBlur";

export interface Tab<T extends string> {
  id: T;
  label: string;
  count?: number | undefined;
  tone?: "warn" | "error" | undefined;
  /** A muted note after the count: the time the SQL tab's queries took. */
  detail?: string | undefined;
  /** The detail's tooltip: what the calls' times add up to, where the detail is their time on the clock. */
  detailTitle?: string | undefined;
  /** Shown after the label instead of a count: the request's status, a task's outcome. */
  badge?: ReactNode;
  /** A small icon before the label. */
  icon?: ReactNode;
}

export interface TabsProps<T extends string> {
  tabs: readonly Tab<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}

/**
 * The tabs, in one row that never clips one of them: those that don't fit go into a More menu at its end. When that
 * would leave less than half of them in the row, the tabs but the open one show their icon and count only (the name
 * is the tooltip), and More takes what still doesn't fit. The open tab always stays in the row.
 */
export function Tabs<T extends string>({ tabs, active, onChange, label }: TabsProps<T>) {
  const { row, full, compact, fit } = useFittingTabs(tabs.map((tab) => tab.id).indexOf(active));
  const overflow = tabs.filter((_, index) => fit.hidden.has(index));
  const copies = tabs.map((tab) => <TabButton key={tab.id} tab={tab} selected={tab.id === active} />);
  return (
    <div ref={row} className="dt-tabs">
      <div className="dt-tabs-list" role="tablist" aria-label={label} data-compact={fit.compact || undefined}>
        {tabs.map((tab, index) =>
          fit.hidden.has(index) ? null : (
            <TabButton key={tab.id} tab={tab} selected={tab.id === active} onClick={() => onChange(tab.id)} />
          ),
        )}
      </div>
      {overflow.length > 0 ? <MoreTabs tabs={overflow} onChange={onChange} /> : null}
      {/* Every tab and the More button as they would show, with their names and without, unseen: the widths the row
          is fitted from. */}
      <div className="dt-tabs-measure" aria-hidden="true" inert>
        <div ref={full}>
          {copies}
          <MoreButton tabs={[]} />
        </div>
        <div ref={compact} data-compact>
          {copies}
          <MoreButton tabs={[]} />
        </div>
      </div>
    </div>
  );
}

function TabButton<T extends string>({
  tab,
  selected,
  onClick,
}: {
  tab: Tab<T>;
  selected: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className="dt-tab"
      // Narrow, the other tabs show their icon and count only: the name is in the tooltip.
      title={tab.label}
      tabIndex={onClick ? undefined : -1}
      onClick={onClick}
    >
      <TabBody tab={tab} />
    </button>
  );
}

function TabBody<T extends string>({ tab }: { tab: Tab<T> }) {
  return (
    <>
      {tab.icon ?? null}
      <span className="dt-tab-label">{tab.label}</span>
      <TabCount tab={tab} />
      {tab.badge ?? null}
      {tab.detail ? (
        <span className="dt-tab-detail" title={tab.detailTitle}>
          {tab.detail}
        </span>
      ) : null}
    </>
  );
}

function TabCount<T extends string>({ tab }: { tab: Tab<T> }) {
  if (tab.count === undefined) return null;
  return (
    <span className="dt-tab-count" data-tone={tab.tone}>
      {tab.count}
    </span>
  );
}

/** The tabs that didn't fit, in a menu: as they show on their tabs. */
function MoreTabs<T extends string>({ tabs, onChange }: { tabs: readonly Tab<T>[]; onChange: (id: T) => void }) {
  // In the panel a click on the page doesn't reach the menu: it closes when the frame loses focus.
  const [open, setOpen] = useMenuOpen();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <MoreButton tabs={tabs} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="dt-tabs-more">
        {tabs.map((tab) => (
          <DropdownMenuItem key={tab.id} onSelect={() => onChange(tab.id)}>
            <TabBody tab={tab} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** More, and the worst tone of the tabs in it: an issue behind it still shows. */
function MoreButton<T extends string>({ tabs, ...props }: { tabs: readonly Tab<T>[] } & ComponentProps<"button">) {
  const tone = (["error", "warn"] as const).find((each) => tabs.some((tab) => tab.tone === each));
  return (
    <button
      type="button"
      className="dt-tab"
      title="More tabs"
      aria-label={["More tabs", ...tabs.map((tab) => tab.label)].join(", ").replace(", ", ": ")}
      {...props}
    >
      <EllipsisIcon />
      <span>More</span>
      {tone ? <span className="dt-tab-dot" data-tone={tone} /> : null}
    </button>
  );
}

/** How the row shows its tabs: without the names of all but the open one, and which go into More. */
interface TabsFit {
  compact: boolean;
  hidden: ReadonlySet<number>;
}

/** The width of a row of these, `gap` apart. */
function rowWidth(widths: readonly number[], gap: number): number {
  return widths.reduce((sum, each) => sum + each, 0) + gap * Math.max(widths.length - 1, 0);
}

/** The tabs a row of `room` pixels has no room for: none when all fit, else those after the last that fits with More. */
function overflowing(widths: readonly number[], active: number, room: number, gap: number): Set<number> {
  // The tabs' widths, then More's.
  const tabs = widths.slice(0, -1);
  if (rowWidth(tabs, gap) <= room) return new Set();
  // The open tab and More first, then the others in their order while they fit.
  const others = tabs.flatMap((width, index) => (index === active ? [] : [{ index, width }]));
  let used = rowWidth([...tabs.slice(active, active + 1), ...widths.slice(-1)], gap);
  const ends = others.map(({ width }) => {
    used += gap + width;
    return used;
  });
  const first = ends.findIndex((end) => end > room);
  return new Set(others.slice(first < 0 ? others.length : first).map(({ index }) => index));
}

/**
 * How a row of `room` pixels shows its tabs, from their widths with their names and without (each list ending with
 * More's): with their names while that keeps at least half of them in the row, else without, the rest in More.
 */
function fitTabs(
  full: readonly number[],
  compact: readonly number[],
  active: number,
  room: number,
  gap: number,
): TabsFit {
  const named = overflowing(full, active, room, gap);
  const count = full.length - 1;
  if (count - named.size >= Math.ceil(count / 2)) return { compact: false, hidden: named };
  return { compact: true, hidden: overflowing(compact, active, room, gap) };
}

/** How the row fits its tabs, measured again as it or its tabs change size. */
function useFittingTabs(active: number): {
  row: RefObject<HTMLDivElement | null>;
  full: RefObject<HTMLDivElement | null>;
  compact: RefObject<HTMLDivElement | null>;
  fit: TabsFit;
} {
  const row = useRef<HTMLDivElement>(null);
  const full = useRef<HTMLDivElement>(null);
  const compact = useRef<HTMLDivElement>(null);
  // As a string, so an unchanged answer doesn't render again: "c" when compact, then the hidden tabs.
  const [key, setKey] = useState("");
  useLayoutEffect(() => {
    const [box, named, short] = [row.current, full.current, compact.current];
    if (!(box && named && short)) return;
    return watchFit(box, [named, short], (room, gap) => {
      const fit = fitTabs(widthsOf(named), widthsOf(short), active, room, gap);
      setKey(`${fit.compact ? "c" : ""}|${[...fit.hidden].join(",")}`);
    });
  }, [active]);
  const [mode = "", hidden = ""] = key.split("|");
  return {
    row,
    full,
    compact,
    fit: { compact: mode === "c", hidden: new Set(hidden.split(",").filter(Boolean).map(Number)) },
  };
}

/**
 * Calls `fit` with the row's room for its tabs and the gap between them, now and whenever the row or its copies of
 * the tabs change size. Returns the stop.
 */
function watchFit(row: HTMLElement, copies: readonly HTMLElement[], fit: (room: number, gap: number) => void) {
  const measure = () => {
    const style = getComputedStyle(row);
    const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    // A pixel spare: the widths are fractional, and a tab cut by one is still cut.
    fit(row.clientWidth - padding - 1, Number.parseFloat(style.columnGap) || 0);
  };
  measure();
  const observer = new ResizeObserver(measure);
  for (const element of [row, ...copies]) observer.observe(element);
  return () => observer.disconnect();
}

/** The widths of a row's copies of its tabs, as they would show. */
function widthsOf(copies: HTMLElement): number[] {
  return [...copies.children].map((child) => child.getBoundingClientRect().width);
}
