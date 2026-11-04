// The panel, redesign A (a prototype): a toolbar (Profile, Share, Console, theme, dock, close), one sticky
// head over the rows (the kinds of spans to keep, Follow and Clear; the axis), and one
// waterfall whose rows open into the call tree: the page, its requests, their calls, their records. A drag across
// the bars picks a stretch of time. The selected row's, or the stretch's, details are in one pane: right of the rows
// docked at the bottom, a sheet under them docked right.
import {
  type Axis,
  CloseIcon,
  duration,
  ExternalIcon,
  Hint,
  IssueChip,
  KindBadge,
  Logo,
  RangeBand,
  type RowKind,
  Running,
  StatusBadge,
  type Stretch,
  TraceBadge,
  type TraceRow,
  useNow,
  useRangeDrag,
  WaterfallContext,
  type WaterfallFacts,
  type WaterfallHost,
} from "@tracepanel/ui";
import { isTyping } from "@tracepanel/ui/lib/keys";
import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import { ChevronRightIcon, FlameIcon, KeyboardIcon, ListEndIcon, TriangleAlertIcon } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFollowNew } from "./App";
import { ClearDialog } from "./ClearDialog";
import { useTabHistory } from "./hooks";
import { ProfileToggle } from "./ProfileToggle";
import { useTabRows } from "./panelChains";
import { tellWidget, useDock } from "./panelLayout";
import { ClearButton, DockButton, PANEL_LINKS, readFollow, writeFollow } from "./panelList";
import { arrivingIn, followTarget, inOrder, runningIn, withRuns } from "./panelRows";
import { base, source } from "./panelSource";
import { go, href, type Route } from "./routes";
import { ShareAction } from "./ShareDialog";
import { ThemeToggle } from "./Sidebar";
import { TraceScreen } from "./TraceScreen";
import { SwitchUser } from "./UserSwitcher";

export const PANEL_A_KEY = "tracepanel:panel-a";

/**
 * The waterfall's top level: every page and request of the tab, oldest first, a request under its page. A browser's
 * view has its requests in its own spans: open, they are not listed again under it.
 */
function entriesOf(rows: readonly TraceRow[], open: string | null): { row: TraceRow; depth: number }[] {
  const out: { row: TraceRow; depth: number }[] = [];
  for (const group of pagesOf(uniqueTraces(rows))) {
    const [head, ...rest] = group;
    if (!head) continue;
    out.push({ row: head, depth: 0 });
    if (head.trace.kind === "page" && head.trace.id === open) continue;
    for (const row of rest) out.push({ row, depth: 1 });
  }
  return out;
}

/**
 * Each trace once: fetches that carry the page's trace (or a gateway's retries) list the same trace again; its spans
 * are the one entry's.
 */
function uniqueTraces(rows: readonly TraceRow[]): TraceRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.trace.id)) return false;
    seen.add(row.trace.id);
    return true;
  });
}

/** The page's time: from its first start to its last end. */
function pageAxis(rows: readonly TraceRow[]): Axis | null {
  if (rows.length === 0) return null;
  const start = Math.min(...rows.map((row) => row.trace.start));
  const end = Math.max(...rows.map((row) => row.trace.start + row.trace.duration));
  return { start, duration: Math.max(end - start, 1) };
}

/**
 * Each row's time is said on the timeline, after its bar's end (before its start near the right edge): the row's
 * bars' extent goes to its style for the time to be placed by (there is no time column).
 */
function useBarLabels(scroll: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const root = scroll.current?.querySelector<HTMLElement>(".wf-rows");
    if (!root) return;
    const place = () => {
      for (const row of root.querySelectorAll<HTMLElement>(".dt-map-row")) {
        let start = 100;
        let end = 0;
        for (const bar of row.querySelectorAll<HTMLElement>(":scope > .dt-map-track .dt-map-bar")) {
          const left = Number.parseFloat(bar.style.left) || 0;
          const width = Number.parseFloat(bar.style.width) || 0;
          start = Math.min(start, left);
          end = Math.max(end, left + width);
        }
        if (start > end) start = end;
        // Near the right edge the time goes before the bar; a bar across most of the axis carries it inside.
        // One rule: after the bar's end, in the track's gutter at the right edge if it must.
        const flip = false;
        const inside = false;
        const want = `${end.toFixed(2)}|${start.toFixed(2)}|${flip}|${inside}`;
        if (row.dataset["bars"] === want) continue;
        row.dataset["bars"] = want;
        row.style.setProperty("--bar-end", end.toFixed(2));
        row.style.setProperty("--bar-start", start.toFixed(2));
        row.toggleAttribute("data-flip", flip);
        row.toggleAttribute("data-inside", inside);
      }
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  });
}

/** The room the break mark takes at the axis's start (px): no tick label under it. */
const BREAK_ROOM = 72;

/** An element's width, followed as it resizes. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  // Each render: the element may mount after the first (a band hidden until there are two entries).
  const element = ref.current;
  useEffect(() => {
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/** A leading idle stretch longer than this share of the page is left off the axis, behind a break mark. */
const IDLE_SHARE = 0.2;

/** The page's axis from where its work starts, when the start before it is long and idle; and how long that was. */
function withoutIdleStart(whole: Axis | null, work: number | null): { axis: Axis | null; skipped: number } {
  if (!whole || work === null) return { axis: whole, skipped: 0 };
  const idle = work - whole.start;
  if (idle <= whole.duration * IDLE_SHARE) return { axis: whole, skipped: 0 };
  const end = whole.start + whole.duration;
  // A little room before the first bar.
  const start = Math.max(whole.start, work - (end - work) * 0.02);
  return { axis: { start, duration: Math.max(end - start, 1) }, skipped: start - whole.start };
}

/**
 * The rows as a tree for the keyboard and assistive tech: each row a treeitem with its level and state, one of them
 * in the Tab order (the selected one, else the first); ↑ ↓ move, Home and End go to the ends; → and ← open and close
 * (the rows' own), Enter selects.
 */
function useTreeKeys(
  scroll: RefObject<HTMLDivElement | null>,
  pick: (stretch: { from: number; to: number } | null) => void,
  axis: Axis | null,
  select: (trace: string, key: string | null) => void,
): void {
  // The row the Shift keys started on: kept across renders (each stretch picked renders).
  const anchorRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = scroll.current?.querySelector<HTMLElement>(".wf-rows");
    if (!root) return;
    const rows = () => [...root.querySelectorAll<HTMLElement>(".dt-map-row")].filter((row) => row.offsetParent);
    const mark = () => {
      const all = rows();
      // One row in the Tab order: the focused one while focus is in the tree, else the selected one, else the first.
      const focused = all.find((row) => row === document.activeElement);
      const current =
        focused ??
        all.find((row) => row.getAttribute("aria-current") === "true") ??
        all.find((row) => row.closest("[data-trace]")) ??
        all[0];
      for (const row of all) {
        // Its level as drawn: the depth its name is indented by, else its nesting.
        const depth = row.querySelector<HTMLElement>(".dt-map-name")?.style.getPropertyValue("--dt-depth");
        let level = 1;
        for (let at = row.parentElement; at && at !== root; at = at.parentElement) {
          if (at.firstElementChild?.classList.contains("dt-map-row") && at.firstElementChild !== row) level += 1;
        }
        if (depth) level = Number(depth) + 1;
        const set = (name: string, value: string) => row.getAttribute(name) !== value && row.setAttribute(name, value);
        set("role", "treeitem");
        set("aria-level", row.dataset["treeLevel"] ?? String(level));
        set("aria-selected", String(row.getAttribute("aria-current") === "true"));
        set("tabindex", row === current ? "0" : "-1");
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current"] });
    let follow = 0;
    // The selection follows the focus, a moment after it settles: the details track the keys.
    const followTo = (row: HTMLElement | undefined) => {
      window.clearTimeout(follow);
      follow = window.setTimeout(() => {
        const key = row?.dataset["key"];
        const trace = row?.closest<HTMLElement>("[data-trace]")?.dataset["trace"];
        if (key && trace) select(trace, key);
      }, 120);
    };
    // A code row clicked stays marked while its span's details show; any other row clicked lets it go.
    // A click on the selected row (the sticky root, most often) keeps it selected and open: folding is the caret's.
    const onCapture = (event: MouseEvent) => {
      const target = event.target as Element;
      const row = target.closest<HTMLElement>(".dt-map-row");
      if (row?.getAttribute("aria-current") === "true" && !target.closest(".dt-map-caret")) event.stopPropagation();
    };
    root.addEventListener("click", onCapture, true);
    const onClick = (event: MouseEvent) => {
      const row = (event.target as Element).closest<HTMLElement>(".dt-map-row");
      if (!row) return;
      for (const each of root.querySelectorAll("[data-picked]")) each.removeAttribute("data-picked");
      if (row.dataset["kind"] === "code") {
        row.setAttribute("data-picked", "");
        // Its span's details: their profile in view, the code's stretch in it.
        window.setTimeout(
          () => document.querySelector(".dt-wf-profile")?.scrollIntoView({ block: "start", behavior: "smooth" }),
          150,
        );
      }
    };
    root.addEventListener("click", onClick);
    const onKey = (event: KeyboardEvent) => {
      const all = rows();
      const at = all.indexOf(event.target as HTMLElement);
      if (at === -1) return;
      // Shift + ↑ ↓: a stretch from the row the keys started on to the one reached, their bars' extent.
      if (event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowUp") && axis) {
        event.preventDefault();
        anchorRef.current ??= all[at] ?? null;
        const anchor = anchorRef.current;
        const next = all[Math.min(Math.max(at + (event.key === "ArrowDown" ? 1 : -1), 0), all.length - 1)];
        next?.focus();
        const from = anchor ? all.indexOf(anchor) : at;
        const to = next ? all.indexOf(next) : at;
        const span = all.slice(Math.min(from, to), Math.max(from, to) + 1);
        const starts = span.map((row) => Number.parseFloat(row.style.getPropertyValue("--bar-start")) || 0);
        const ends = span.map((row) => Number.parseFloat(row.style.getPropertyValue("--bar-end")) || 0);
        const lo = Math.min(...starts);
        const hi = Math.max(...ends);
        if (hi > lo) {
          // A stretch takes the details, as a drag's does: the row selected lets go.
          const trace = next?.closest<HTMLElement>("[data-trace]")?.dataset["trace"];
          if (trace) select(trace, null);
          pick({ from: (lo / 100) * axis.duration, to: (hi / 100) * axis.duration });
        }
        mark();
        return;
      }
      if (!event.shiftKey) anchorRef.current = null;
      const row = all[at];
      if (event.key === "ArrowRight" && row?.getAttribute("aria-expanded") === "true") {
        event.preventDefault();
        const child = all[at + 1];
        child?.focus();
        mark();
        followTo(child);
        return;
      }
      // ← on a row that isn't open: to its parent, the nearest row above at a lower level.
      if (event.key === "ArrowLeft" && row?.getAttribute("aria-expanded") !== "true") {
        const level = Number(row?.getAttribute("aria-level") ?? 1);
        const parent = all
          .slice(0, at)
          .reverse()
          .find((each) => Number(each.getAttribute("aria-level") ?? 1) < level);
        if (parent) {
          event.preventDefault();
          parent.focus();
          mark();
          followTo(parent);
        }
        return;
      }
      const to = new Map([
        ["ArrowDown", at + 1],
        ["ArrowUp", at - 1],
        ["Home", 0],
        ["End", all.length - 1],
      ]).get(event.key);
      if (to === undefined) return;
      event.preventDefault();
      const next = all[Math.min(Math.max(to, 0), all.length - 1)];
      next?.focus();
      mark();
      followTo(next);
    };
    root.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("click", onClick);
      root.removeEventListener("click", onCapture, true);
    };
  });
}

/** Where the axis says its times: about five ticks at a round step. */
function ticks(axis: Axis, offset = 0, count = 5): { at: number; label: string }[] {
  const raw = axis.duration / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((each) => each * power).find((each) => each >= raw) ?? raw;
  const out: { at: number; label: string }[] = [];
  // A label too near the end would run past the column: its line stays, its text goes.
  for (let at = 0; at <= axis.duration; at += step) {
    const near = at / axis.duration > 0.9;
    out.push({ at: at / axis.duration, label: near ? "" : at + offset === 0 ? "0" : duration(at + offset) });
  }
  return out;
}

/** Follow new requests: each new row is selected as it arrives. An icon toggle, beside the rows it acts on. */
function FollowButton({ follow, onFollow }: { follow: boolean; onFollow: (value: boolean) => void }) {
  return (
    <Hint title="Follow new requests" detail="Select each new request as it arrives.">
      <button type="button" className="wf-follow" aria-pressed={follow} onClick={() => onFollow(!follow)}>
        <ListEndIcon aria-hidden="true" />
        Follow
      </button>
    </Hint>
  );
}

/**
 * Where the waterfall's time column starts, across the panel: the toolbar's tools start there, so the facets sit
 * over the bars and the crumbs over the names.
 */
function useTimeColumn(panel: RefObject<HTMLDivElement | null>, ticks: RefObject<HTMLSpanElement | null>): void {
  useLayoutEffect(() => {
    const root = panel.current;
    if (!root) return;
    const measure = () => {
      const column = ticks.current?.getBoundingClientRect();
      if (!column) return;
      const x = `${Math.round(column.left - root.getBoundingClientRect().left)}px`;
      root.style.setProperty("--wf-time-w", `${Math.round(column.width)}px`);
      const sticky = root.querySelector<HTMLElement>(".wf-sticky");
      if (sticky) root.style.setProperty("--wf-sticky-h", `${Math.round(sticky.offsetHeight)}px`);
      // The divider follows the column always; the toolbar only with the details closed, so a row picked (which
      // opens them) never moves the toolbar.
      root.style.setProperty("--wf-split-x", x);
      if (!root.querySelector(".wf-main[data-details]")) root.style.setProperty("--wf-time-x", x);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    const scroll = root.querySelector(".wf-scroll");
    if (scroll) observer.observe(scroll);
    if (ticks.current) observer.observe(ticks.current);
    measure();
    return () => observer.disconnect();
  });
}

function AxisHead({
  axis,
  ticksRef,
  filter,
  skipped,
  overview,
}: {
  axis: Axis;
  ticksRef: RefObject<HTMLSpanElement | null>;
  filter: ReactNode;
  /** The tab's entries, a thin track under the ticks: one line for both times. */
  overview: ReactNode;
  /** The page's idle start left off the axis (µs): a break mark says how long. */
  skipped: number;
}) {
  const width = useWidth(ticksRef);
  return (
    <div className="wf-head wf-grid">
      {filter}
      <span className="wf-time-cell">
        <span className="wf-ticks" aria-hidden="true" ref={ticksRef} title="Drag to pick a stretch of time">
          {skipped > 0 ? (
            <span className="wf-break" title={`${duration(skipped)} before the first span, left off the axis`}>
              <svg viewBox="0 0 10 12" width="10" height="12" aria-hidden="true">
                <path d="M2 11 6 1M5 11 9 1" stroke="currentColor" strokeWidth="1.4" fill="none" />
              </svg>
              {duration(skipped)}
            </span>
          ) : null}
          {ticks(axis, skipped, width < 200 ? 2 : width < 360 ? 3 : 5).map((tick) => (
            // The break mark takes the axis's start: no label under it.
            <span key={tick.at} style={{ left: `${tick.at * 100}%` }}>
              {skipped > 0 && tick.at * width < BREAK_ROOM ? "" : tick.label}
            </span>
          ))}
        </span>
        {overview}
      </span>
    </div>
  );
}

/** The short words of the kind badges, said in full. */
const BADGES: readonly [string, string][] = [
  ["req", "a request the app served"],
  ["view", "a page view in the browser"],
  ["GET", "an HTTP call, by its method (POST, PUT…)"],
  ["hdl", "the handler (view) that answered"],
  ["fn", "a function"],
  ["gql", "a GraphQL operation or step"],
  ["sql", "a query"],
  ["tx", "a database transaction"],
  ["tpl", "a template rendered"],
  ["redis", "a Redis command"],
  ["enq", "a task enqueued"],
  ["task", "a task run in a worker"],
  ["code", "your code between spans (untraced)"],
  ["wait", "time waiting (I/O, a lock, sleep)"],
  ["fw", "the framework's own work (middleware, routing)"],
  ["info", "a log record, by its level (debug, warn, error)"],
  ["dump", "a value dumped from the code"],
];

const SHORTCUTS: readonly [string, string][] = [
  ["Select the focused row", "Enter"],
  ["Pick a stretch of time", "drag across the bars"],
  ["Clear the stretch, then the kind, then the selection", "Esc"],
  ["Move between rows · open · close · to the parent", "↑ ↓ → ←"],
  ["Pick a stretch from the selected row", "Shift + ↑ ↓"],
  ["This list", "?"],
];

/** ? : the keys, in a small sheet over the panel. */
function Shortcuts({ onClose }: { onClose: () => void }) {
  // Back where it was opened from, when it closes: taken as it opens, before it takes the focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => opener?.focus(), [opener]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the sheet closes it; Esc does too.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it.
    <div className="wf-shortcuts-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="wf-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keys and badges"
        tabIndex={-1}
        ref={(element) => element?.querySelector<HTMLElement>(".wf-shortcuts-close")?.focus()}
        // Tab stays in the sheet: its one control is Close.
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          event.currentTarget.querySelector<HTMLElement>(".wf-shortcuts-close")?.focus();
        }}
      >
        <button type="button" className="icon-button wf-shortcuts-close" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
        <h3>Keys</h3>
        <dl>
          {SHORTCUTS.map(([what, key]) => (
            <div key={what}>
              <dt>{what}</dt>
              <dd>
                <kbd>{key}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <h3>Badges</h3>
        <dl>
          {BADGES.map(([word, what]) => (
            <div key={word}>
              <dt>
                <KindBadge kind={word} muted={true} className="dt-map-kind" />
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
          <div>
            <dt>
              <IssueChip kind="n+1" />
            </dt>
            <dd>an issue in the span: N+1, slow query, slow HTTP call…</dd>
          </div>
          <div>
            <dt>
              <StatusBadge status={500} />
            </dt>
            <dd>how a request or call was answered</dd>
          </div>
          <div>
            <dt>
              <span className="wf-legend-mark">×24</span>
            </dt>
            <dd>the same call repeated, folded into one row (its starts as ticks)</dd>
          </div>
          <div>
            <dt>
              <span className="wf-legend-hatch" aria-hidden="true" />
            </dt>
            <dd>hatched: untraced code or waiting, between spans</dd>
          </div>
          <div>
            <dt>
              <FlameIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </dt>
            <dd>a profile: select the row, its details have it</dd>
          </div>
          <div>
            <dt>
              <span className="wf-legend-mark">{"// 10.2 s"}</span>
            </dt>
            <dd>idle time before the first span, left off the axis</dd>
          </div>
          <div>
            <dt>
              <span className="wf-legend-mark">● library</span>
            </dt>
            <dd>the app that served a call, or a query's database</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

/* ---------- the dividers: the names' column, the details pane ---------- */

const NAMES_KEY = "tracepanel:wf-names";
const DETAILS_KEY = "tracepanel:wf-details";

function rem(value: number): number {
  return value * Number.parseFloat(getComputedStyle(document.documentElement).fontSize || "16");
}

function storedSize(key: string, dock: string): number | null {
  const value = Number(readItem(`${key}:${dock}`));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** A size the reader dragged, per dock, kept in this browser; null: the default. */
function useSize(key: string, dock: string): [number | null, (value: number | null, save: boolean) => void] {
  const [size, setSize] = useState<{ dock: string; value: number | null }>(() => ({
    dock,
    value: storedSize(key, dock),
  }));
  const value = size.dock === dock ? size.value : storedSize(key, dock);
  const set = useCallback(
    (next: number | null, save: boolean) => {
      setSize({ dock, value: next });
      if (save) writeItem(`${key}:${dock}`, next === null ? null : String(Math.round(next)));
    },
    [key, dock],
  );
  return [value, set];
}

/**
 * A divider to drag, or to move with the arrow keys; a double click puts it back. `at` turns a pointer's position into
 * the size, `clamp` keeps the size where nothing collapses.
 */
function Splitter({
  orientation,
  label,
  className,
  value,
  fallback,
  at,
  clamp,
  onSize,
  grows = 1,
}: {
  orientation: "vertical" | "horizontal";
  label: string;
  className: string;
  value: number | null;
  /** The size it has while none was dragged, read from the page. */
  fallback: () => number;
  at: (event: PointerEvent) => number;
  clamp: (value: number) => number;
  onSize: (value: number | null, save: boolean) => void;
  /** 1: right or down grows it; -1: left or up does. */
  grows?: 1 | -1;
}) {
  const current = () => value ?? fallback();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable separator has no native element.
    <div
      className={`wf-splitter ${className}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value ?? 0) || undefined}
      aria-valuemin={0}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(event) => {
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        handle.dataset["dragging"] = "";
        const onMove = (move: PointerEvent) => onSize(clamp(at(move)), false);
        const onUp = (up: PointerEvent) => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          delete handle.dataset["dragging"];
          onSize(clamp(at(up)), true);
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      }}
      onDoubleClick={() => onSize(null, true)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 80 : 20;
        const back = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        const forth = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        if (event.key === back) onSize(clamp(current() - step * grows), true);
        else if (event.key === forth) onSize(clamp(current() + step * grows), true);
        else if (event.key === "Home" || event.key === "Enter") onSize(null, true);
        else return;
        event.preventDefault();
      }}
    />
  );
}

/** The names' column's width (px) as dragged, and the divider over the waterfall that drags it. */
function NamesSplitter({
  value,
  onSize,
  scroll,
}: {
  value: number | null;
  onSize: (value: number | null, save: boolean) => void;
  scroll: RefObject<HTMLDivElement | null>;
}) {
  const width = () => scroll.current?.clientWidth ?? window.innerWidth;
  const left = () => scroll.current?.getBoundingClientRect().left ?? 0;
  return (
    <Splitter
      orientation="vertical"
      label="Resize the span column"
      className="wf-splitter-names"
      value={value}
      fallback={() => (width() - rem(1) - rem(4.5) - 2 * rem(0.625)) * 0.4}
      at={(event) => event.clientX - left() - rem(0.3125)}
      clamp={(next) => Math.min(Math.max(next, rem(12)), width() - rem(4.5) - rem(10))}
      onSize={onSize}
    />
  );
}

/** The details pane's width (bottom dock) or the sheet's height (right dock), and the divider at its edge. */
function DetailsSplitter({
  dock,
  value,
  onSize,
  main,
}: {
  dock: string;
  value: number | null;
  onSize: (value: number | null, save: boolean) => void;
  main: RefObject<HTMLDivElement | null>;
}) {
  const box = () => main.current?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  if (dock === "right") {
    return (
      <Splitter
        orientation="horizontal"
        label="Resize the details"
        className="wf-splitter-sheet"
        value={value}
        fallback={() => box().height * 0.55}
        at={(event) => box().bottom - event.clientY}
        clamp={(next) => Math.min(Math.max(next, rem(8)), box().height - rem(6))}
        onSize={onSize}
        grows={-1}
      />
    );
  }
  return (
    <Splitter
      orientation="vertical"
      label="Resize the details"
      className="wf-splitter-side"
      value={value}
      fallback={() => Math.max(rem(22), box().width * 0.3)}
      at={(event) => box().right - event.clientX}
      clamp={(next) => Math.min(Math.max(next, rem(18)), box().width - rem(28))}
      onSize={onSize}
      grows={-1}
    />
  );
}

/** The waterfall's state: the selection, the kind of spans kept, the stretch, and what each trace reports. */
function useHost(axis: Axis | null, details: HTMLElement | null) {
  const [selected, setSelected] = useState<{ trace: string; key: string } | null>(null);
  const [kind, setKind] = useState<RowKind | null>(null);
  const [range, setRange] = useState<Stretch | null>(null);
  const [facts, setFacts] = useState<ReadonlyMap<string, WaterfallFacts>>(() => new Map());
  const report = useCallback((trace: string, each: WaterfallFacts | null) => {
    setFacts((current) => {
      const next = new Map(current);
      if (each) next.set(trace, each);
      else next.delete(trace);
      return next;
    });
  }, []);
  const select = useCallback((trace: string, key: string | null) => setSelected(key ? { trace, key } : null), []);
  const host: WaterfallHost = useMemo(
    () => ({ axis, selected, select, details, kind, range, facts, report }),
    [axis, selected, select, details, kind, range, facts, report],
  );
  return { host, setKind, setRange, setSelected };
}

/**
 * ? lists the keys; Esc lets the stretch go, then the kind kept, then the row; it never closes the panel.
 */
function usePanelKeys(
  state: { range: Stretch | null; kind: unknown; selected: unknown; shortcuts: boolean },
  act: { clearRange: () => void; clearKind: () => void; deselect: () => void; shortcuts: (open: boolean) => void },
) {
  const latest = useRef({ state, act });
  latest.current = { state, act };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { state: now, act: does } = latest.current;
      if (!isTyping(event)) {
        const keys: Record<string, () => void> = {
          "?": () => does.shortcuts(!now.shortcuts),
        };
        const run = keys[event.key];
        if (run) {
          event.preventDefault();
          run();
          return;
        }
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const wide = document.querySelector(".wf-main[data-wide]");
      if (now.shortcuts) does.shortcuts(false);
      else if (wide) {
        wide.removeAttribute("data-wide");
        const button = wide.querySelector<HTMLElement>('.dt-wf-profile [aria-pressed="true"]');
        button?.setAttribute("aria-pressed", "false");
        if (button) button.textContent = "Full width";
      } else if (now.range) does.clearRange();
      else if (now.selected) does.deselect();
      // Never the panel itself: its close button and the pill close it.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function PanelA({ route }: { route: Route }) {
  const history = useTabHistory();
  const { rows, stored, runs } = useTabRows(history);
  const listed = withRuns(rows, runs);
  const currentId = history?.current ?? null;
  const selectedId =
    route.name === "trace" ? route.id : (currentId ?? rows.find((row) => row.depth === 0)?.trace.id ?? null);
  const dock = useDock();
  const [names, setNames] = useSize(NAMES_KEY, dock);
  const [detailsSize, setDetailsSize] = useSize(DETAILS_KEY, dock);
  const [follow, setFollow] = useState(readFollow);
  const [clearing, setClearing] = useState(false);
  const [details, setDetails] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const ticksRef = useRef<HTMLSpanElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  useTimeColumn(panelRef, ticksRef);

  const entries = entriesOf(listed, selectedId);
  // The entry picked (several can share a trace: fetches that carry the page's trace), else the first of the trace on
  // screen, else the newest.
  const [picked, setPicked] = useState<string | null>(null);
  // The entry under the pointer, in the band or the list: the other shows it too.
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const opened =
    entries.find((entry) => entryKey(entry.row) === picked && entry.row.trace.id === selectedId) ??
    entries.find((entry) => entry.row.trace.id === selectedId) ??
    entries.at(-1);
  const openKey = opened ? entryKey(opened.row) : null;
  const openId = opened?.row.trace.id ?? selectedId;
  const openEntry = useCallback((row: TraceRow) => {
    setPicked(entryKey(row));
    go({ name: "trace", id: row.trace.id });
  }, []);
  // The axis is the open entry's own time: its spans fill the width.
  const axisKey = opened ? `${opened.row.trace.id}:${opened.row.trace.start}:${opened.row.trace.duration}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `axisKey` says when the open entry's time changed.
  const whole = useMemo(() => (opened ? pageAxis([opened.row]) : null), [axisKey]);
  const [works, setWorks] = useState<number | null>(null);
  const { axis, skipped } = useMemo(() => withoutIdleStart(whole, works), [whole, works]);
  const { host, setKind, setRange, setSelected } = useHost(axis, details);
  const firstWork = Math.min(...[...host.facts.values()].map((each) => each.work));
  useEffect(() => setWorks(Number.isFinite(firstWork) ? firstWork : null), [firstWork]);
  useTreeKeys(scrollRef, setRange, axis, host.select);
  // A kind picked: its first row into view.
  useEffect(() => {
    if (!host.kind) return;
    const timer = window.setTimeout(() => {
      scrollRef.current
        ?.querySelector(".wf-rows .dt-map-row:not([data-dim]):not(.wf-other)")
        ?.scrollIntoView({ block: "nearest" });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [host.kind]);
  useBarLabels(scrollRef);
  const [shortcuts, setShortcuts] = useState(false);
  usePanelKeys(
    { range: host.range, kind: host.kind, selected: host.selected, shortcuts },
    {
      clearRange: () => setRange(null),
      clearKind: () => setKind(null),
      deselect: () => setSelected(null),
      shortcuts: setShortcuts,
    },
  );
  // A new page on screen: no stretch or selection of the last one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new page only.
  useEffect(() => {
    setRange(null);
    setSelected(null);
  }, [openId]);
  // A stretch picked takes the details: the row selected lets go.
  const drag = useRangeDrag(axis?.duration ?? 1, (picked) => {
    setSelected(null);
    setRange({ from: picked[0], to: picked[1] });
  });
  const shownRange = drag.draft ? { from: drag.draft[0], to: drag.draft[1] } : host.range;

  const latest = followTarget(inOrder(true, rows));
  useFollowNew(follow, latest, history !== null);
  const onFollow = (value: boolean) => {
    setFollow(value);
    writeFollow(value);
  };
  const consoleAt = () => `${base}${selectedId ? href({ name: "trace", id: selectedId }) : "#/"}`;

  return (
    <WaterfallContext.Provider value={host}>
      <div
        className="panel wf-panel"
        data-dock={dock}
        ref={panelRef}
        style={
          {
            ...(names === null ? {} : { "--wf-names": `${Math.round(names)}px` }),
            ...(detailsSize === null ? {} : { "--wf-details": `${Math.round(detailsSize)}px` }),
          } as React.CSSProperties
        }
      >
        <header className="wf-bar">
          <div className="wf-zone wf-zone-identity">
            {/* As the old panel's: the mark and the wordmark; the wordmark goes only where the dock is narrow. */}
            <Logo className="wf-logo shrink-0 gap-1.5 text-md [&_svg]:size-5" />
          </div>
          <div className="wf-zone wf-zone-actions">
            <SwitchUser source={source} onSwitched={() => tellWidget("tracepanel:reload")} />
            <ProfileToggle source={source} />
            <Hint title="Open in the console" detail="This request in the full console, in a new tab.">
              <a
                className="wf-console inline-flex h-7.5 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary-hover [&_svg]:size-3.5"
                href={consoleAt()}
                target="_blank"
                rel="noreferrer"
              >
                Console
                <ExternalIcon />
              </a>
            </Hint>
            <ShareAction traceId={selectedId} source={source} compact={true} />
            <Hint title="Keys and badges" keys="?">
              <button
                type="button"
                className="icon-button"
                aria-label="Keys and badges"
                onClick={() => setShortcuts(true)}
              >
                <KeyboardIcon />
              </button>
            </Hint>
            <ThemeToggle compact={true} />
            <DockButton dock={dock} />
            <Hint title="Close">
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => tellWidget("tracepanel:close")}
              >
                <CloseIcon />
              </button>
            </Hint>
          </div>
        </header>
        <div className="wf-main" data-details={host.selected || host.range ? "" : undefined} ref={mainRef}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag across the bars picks a stretch; the rows are buttons. */}
          <div
            className="wf-waterfall"
            onPointerDown={(event) => {
              const target = event.target as Element;
              if (ticksRef.current && target.closest(".dt-map-track, .wf-ticks") && !target.closest(".wf-band")) {
                drag.start(event, ticksRef.current);
                // The drag keeps the pointer's default (focus) from happening: the row is focused, the keys stay here.
                // Focused for the keys, without the keyboard's ring: a pointer put it there.
                target
                  .closest<HTMLElement>(".dt-map-row")
                  ?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
              }
            }}
          >
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc lets the stretch go from the keyboard. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: a click beside the rows lets the stretch go. */}
            <div
              className="wf-scroll"
              ref={scrollRef}
              onClick={(event) => {
                if (!(event.target as Element).closest(".dt-map-row, .wf-head, .wf-details")) setRange(null);
              }}
            >
              <div className="wf-sticky">
                {host.axis ? (
                  <AxisHead
                    skipped={skipped}
                    axis={host.axis}
                    ticksRef={ticksRef}
                    overview={
                      <TabTimeline
                        rows={listed}
                        openKey={openKey}
                        onOpen={openEntry}
                        hoveredKey={hoveredKey}
                        onHover={setHoveredKey}
                      />
                    }
                    filter={
                      <span className="wf-call-head">
                        <FollowButton follow={follow} onFollow={onFollow} />
                        <ClearButton onClear={() => setClearing(true)} label="Clear the list" />
                      </span>
                    }
                  />
                ) : null}
              </div>
              <div className="wf-rows" role="tree" aria-label="Spans" data-filter={host.kind ? "" : undefined}>
                {selectedId && !opened ? (
                  <WaterfallTrace id={selectedId} rows={rows} stored={stored} depth={0} fold={false} />
                ) : null}
                {entries.map(({ row, depth }) =>
                  entryKey(row) !== openKey ? (
                    <EntryRow
                      key={entryKey(row)}
                      row={row}
                      depth={depth}
                      onOpen={openEntry}
                      hovered={hoveredKey === entryKey(row)}
                      onHover={setHoveredKey}
                    />
                  ) : row.open || row.trace.id.startsWith("~") ? (
                    <InFlightRow key={entryKey(row)} row={row} axis={host.axis} depth={depth} />
                  ) : (
                    <WaterfallTrace
                      key={entryKey(row)}
                      id={row.trace.id}
                      rows={rows}
                      stored={stored}
                      anchor={row.trace.start}
                      depth={depth}
                      fold={false}
                    />
                  ),
                )}
                {history && !selectedId ? (
                  <p className="wf-hint">No requests yet: requests from this browser tab appear here.</p>
                ) : null}
              </div>
            </div>
            {shownRange && axis ? (
              <div className="wf-range-layer">
                <RangeBand range={[shownRange.from, shownRange.to]} total={axis.duration} />
                <span
                  className="wf-range-label"
                  style={{ left: `${(shownRange.from / axis.duration) * 100}%` }}
                  aria-live="polite"
                >
                  {duration(skipped + shownRange.from)} – {duration(skipped + shownRange.to)} ·{" "}
                  {duration(shownRange.to - shownRange.from)}
                </span>
              </div>
            ) : null}
            <NamesSplitter value={names} onSize={setNames} scroll={scrollRef} />
          </div>
          <aside className="wf-details" aria-label="Details" hidden={!(host.selected || host.range)}>
            <DetailsSplitter dock={dock} value={detailsSize} onSize={setDetailsSize} main={mainRef} />
            <div className="wf-details-body" ref={setDetails} />
          </aside>
        </div>
        {shortcuts ? <Shortcuts onClose={() => setShortcuts(false)} /> : null}
        <ClearDialog
          mode="panel"
          open={clearing}
          onOpenChange={setClearing}
          source={source}
          onCleared={(permanent) => {
            tellWidget("tracepanel:clear", { all: permanent });
            go({ name: "home" });
          }}
        />
      </div>
    </WaterfallContext.Provider>
  );
}

/** The tab's pages, oldest first, each with its requests: the waterfall's top level. */
function pagesOf(rows: readonly TraceRow[]): TraceRow[][] {
  const pages: TraceRow[][] = [];
  for (const row of inOrder(true, rows)) {
    if (row.run || row.group) continue;
    if (!row.depth || pages.length === 0) pages.push([row]);
    else pages.at(-1)?.push(row);
  }
  return pages;
}

/** A folded entry's badge word, as its root row's: a view, a task, a request. */
function rootWord(row: TraceRow): string {
  if (row.trace.kind === "page") return "view";
  if (row.trace.kind === "task") return "task";
  return "req";
}

function badgeWord(row: TraceRow): string {
  return row.trace.kind === "page" ? "VIEW" : (row.trace.method ?? row.trace.kind.toUpperCase());
}

/** How far apart (µs) a page and its first request may be before the page is placed by its requests (two clocks). */
const CLOCKS_APART = 60_000_000;

/** Every page and request of the tab on one clock: a page far from its requests (an app's clock) ends where they start. */
function onOneClock(rows: readonly TraceRow[]): TraceRow[] {
  return pagesOf(rows).flatMap(([head, ...rest]) => {
    if (!head) return [];
    const first = rest.length ? Math.min(...rest.map((row) => row.trace.start)) : null;
    const end = head.trace.start + head.trace.duration;
    if (first === null || Math.abs(first - end) < CLOCKS_APART) return [head, ...rest];
    return [{ ...head, trace: { ...head.trace, start: first - head.trace.duration } }, ...rest];
  });
}

/**
 * The tab's timeline: every page and request as a labelled block on one axis whose idle gaps are folded into narrow
 * breaks (a tab's entries are seconds or minutes apart: on a plain axis they would be specks). Hover says what it is;
 * a click opens it below on its own axis; the open one is outlined.
 */
function TabTimeline({
  rows,
  openKey,
  onOpen,
  hoveredKey,
  onHover,
}: {
  rows: readonly TraceRow[];
  openKey: string | null;
  onOpen: (row: TraceRow) => void;
  hoveredKey: string | null;
  onHover: (key: string | null) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const width = useWidth(track) || 600;
  const all = onOneClock(uniqueTraces(rows));
  if (all.length < 2) return null;
  const now = Date.now() * 1000;
  const running = (row: TraceRow) => row.open || row.trace.id.startsWith("~");
  const lasted = (row: TraceRow) =>
    running(row) ? Math.max(now - row.trace.start, row.trace.duration) : row.trace.duration;
  const spans = all.map((row) => ({ row, from: row.trace.start, to: row.trace.start + Math.max(lasted(row), 1) }));
  const scale = foldedScale(spans, width);
  const placed = spans.map(({ row, from, to }) => {
    const label = `${row.trace.name} · ${duration(lasted(row))}`;
    const x = scale.x(from);
    const drawn = Math.max(scale.x(to) - x, 2);
    // Too narrow for its name: a chip as wide as its label, at its place.
    const chip = drawn < 40;
    const w = chip ? labelWidth(label) + (row.trace.issues ? 14 : 0) : drawn;
    return { row, x, w, label, chip };
  });
  const lane = bandLanes(placed);
  const twoDeep = [...lane.values()].some((each) => each > 0);
  return (
    <div className="wf-band" data-lanes={twoDeep ? "2" : "1"}>
      <div className="wf-band-track" ref={track}>
        {scale.breaks.map((each) => (
          <span
            key={each.at}
            className="wf-band-break"
            style={{ left: `${each.at}px` }}
            title={`${duration(each.us)} with nothing running`}
          />
        ))}
        {placed.map(({ row, x, w, label, chip }) => {
          const open = entryKey(row) === openKey;
          const status = row.trace.http_status ? ` · ${row.trace.http_status}` : "";
          const issues = row.trace.issues
            ? ` · ${row.trace.issues} ${row.trace.issues === 1 ? "issue" : "issues"}`
            : "";
          return (
            <button
              type="button"
              key={entryKey(row)}
              className="wf-band-block"
              data-depth={row.depth ?? 0}
              data-chip={chip ? "" : undefined}
              data-tone={bandTone(row)}
              aria-current={open ? "true" : undefined}
              data-hovered={hoveredKey === entryKey(row) ? "" : undefined}
              aria-label={`Open ${row.trace.name}${status} · ${duration(lasted(row))}${issues}`}
              title={`${row.trace.name}${status} · ${duration(lasted(row))}${issues}`}
              style={{ left: `${x}px`, width: `${Math.min(w, width - x)}px`, top: `${(lane.get(row) ?? 0) * 5}px` }}
              tabIndex={open ? 0 : -1}
              onMouseEnter={() => onHover(entryKey(row))}
              onMouseLeave={() => onHover(null)}
              onKeyDown={(event) => {
                const by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!by) return;
                event.preventDefault();
                const blocks = [
                  ...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".wf-band-block") ?? []),
                ];
                const at = blocks.indexOf(event.currentTarget);
                const next = blocks[Math.min(Math.max(at + by, 0), blocks.length - 1)];
                // The Tab stop moves with the focus.
                for (const block of blocks) block.tabIndex = block === next ? 0 : -1;
                next?.focus();
              }}
              onClick={() => onOpen(row)}
            >
              {row.trace.issues ? <TriangleAlertIcon className="wf-band-issue" aria-hidden="true" /> : null}
              <span className="wf-band-text">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** How an entry went, for its block's edge: failed, answered 4xx, or fine. */
function bandTone(row: TraceRow): string {
  if (row.trace.status === "error" || (row.trace.http_status ?? 0) >= 500) return "error";
  if ((row.trace.http_status ?? 0) >= 400) return "warn";
  return "ok";
}

const BREAK_PX = 18;

/**
 * A time scale for the band with its idle gaps folded: a gap longer than the longest entry (or than a fifth of the
 * whole) is a narrow break; the active stretches share the rest of the width by their time.
 */
function foldedScale(spans: readonly { from: number; to: number }[], width: number) {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const longest = Math.max(...sorted.map((each) => each.to - each.from));
  const start = sorted[0]?.from ?? 0;
  const end = Math.max(...sorted.map((each) => each.to));
  const limit = Math.min(longest, (end - start) / 5);
  // The active stretches: entries merged where they meet or the gap between them is short.
  const pieces: { from: number; to: number }[] = [];
  for (const each of sorted) {
    const last = pieces.at(-1);
    if (last && each.from - last.to <= limit) last.to = Math.max(last.to, each.to);
    else pieces.push({ from: each.from, to: each.to });
  }
  const active = pieces.reduce((all, piece) => all + (piece.to - piece.from), 0) || 1;
  const room = Math.max(width - (pieces.length - 1) * BREAK_PX, 40);
  const lefts: number[] = [];
  let at = 0;
  for (const [index, piece] of pieces.entries()) {
    if (index > 0) at += BREAK_PX;
    lefts.push(at);
    at += ((piece.to - piece.from) / active) * room;
  }
  const breaks = pieces.slice(1).map((piece, index) => ({
    at: (lefts[index + 1] ?? 0) - BREAK_PX / 2 - 3,
    us: piece.from - (pieces[index]?.to ?? piece.from),
  }));
  const x = (t: number): number => {
    let index = 0;
    for (const [at, each] of pieces.entries()) if (each.from <= t) index = at;
    const piece = pieces[index];
    if (!piece) return 0;
    const left = lefts[index] ?? 0;
    return left + ((Math.min(t, piece.to) - piece.from) / active) * room;
  };
  return { x, breaks };
}

/** Two lanes: a block that overlaps one in the first (its label included) goes to the second. */
function bandLanes(placed: readonly { row: TraceRow; x: number; w: number }[]): Map<TraceRow, number> {
  const lanes = new Map<TraceRow, number>();
  let first = Number.NEGATIVE_INFINITY;
  for (const each of [...placed].sort((a, b) => a.x - b.x)) {
    const lane = first <= each.x ? 0 : 1;
    lanes.set(each.row, lane);
    if (lane === 0) first = each.x + each.w + 2;
  }
  return lanes;
}

/** An entry's identity in the list: several entries may share a trace (fetches carrying the page's trace). */
function entryKey(row: TraceRow): string {
  return row.key ?? `${row.trace.id}:${row.trace.start}`;
}

/** About how wide a label is in the band's 10.5px type (px). */
function labelWidth(label: string): number {
  return label.length * 6 + 12;
}

/** A page or request of the tab, folded to one line (name, status, time): a click opens it here, on its own time. */
function EntryRow({
  row,
  depth,
  onOpen,
  hovered,
  onHover,
}: {
  row: TraceRow;
  depth: number;
  onOpen: (row: TraceRow) => void;
  hovered: boolean;
  onHover: (key: string | null) => void;
}) {
  // Named and badged as its open root row is: one entity, one look.
  const name = row.trace.name;
  const running = row.open || row.trace.id.startsWith("~");
  return (
    <div className="dt-map" data-waterfall="">
      <button
        type="button"
        className="dt-map-row wf-other"
        data-kind={row.trace.kind === "page" ? "page" : "http"}
        data-tree-level={depth + 1}
        data-hovered={hovered ? "" : undefined}
        title={`Open ${row.trace.name}`}
        onClick={() => onOpen(row)}
        onMouseEnter={() => onHover(entryKey(row))}
        onMouseLeave={() => onHover(null)}
      >
        <span className="dt-map-name" style={{ paddingLeft: `${0.75 + depth * 1.125}rem` }}>
          <ChevronRightIcon className="wf-other-caret" aria-hidden="true" />
          <KindBadge kind={rootWord(row)} muted={true} className="dt-map-kind" />
          <span className="dt-map-text" title={row.trace.name}>
            {name}
          </span>
          {/* Folded, it still says what is wrong in it: its issues' kinds, as an open row's chips. */}
          {row.trace.issue_kinds
            .filter((kind) => kind !== "error")
            .map((kind) => (
              <IssueChip key={kind} kind={kind} />
            ))}
          <StatusBadge status={row.trace.http_status} />
          {/* Its own time, by its name: the time area is the open entry's axis, not this one's. */}
          {running ? (
            <Running start={row.trace.start} until={row.until} className="wf-other-time" />
          ) : (
            <span className="wf-other-time">{duration(row.trace.duration)}</span>
          )}
        </span>
        <span className="dt-map-track">
          {/* Still running: a pale bar across, its time ticking by its name. */}
          {running ? <span className="dt-map-bar wf-inflight-bar" style={{ left: "0%", width: "100%" }} /> : null}
        </span>
      </button>
    </div>
  );
}

/** A request the page still waits for: its name, a bar growing to now, its time ticking. */
function InFlightRow({ row, axis, depth }: { row: TraceRow; axis: Axis | null; depth: number }) {
  const now = useNow(true) * 1000;
  const start = row.trace.start;
  const end = Math.max(start, row.until ?? now);
  const place = axis
    ? {
        left: `${Math.min(Math.max(((start - axis.start) / axis.duration) * 100, 0), 100)}%`,
        width: `${Math.max(Math.min(((end - start) / axis.duration) * 100, 100), 0.4)}%`,
      }
    : undefined;
  return (
    <div className="dt-map" data-waterfall="">
      <div className="dt-map-row wf-inflight" data-kind="http.client">
        <span className="dt-map-name" style={{ paddingLeft: `${0.75 + depth * 1.125}rem` }}>
          <span className="dt-map-caret" />
          <TraceBadge word={badgeWord(row)} />
          <span className="dt-map-text" title={row.trace.name}>
            {row.trace.path ?? row.trace.name}
          </span>
        </span>
        <span className="dt-map-track" title={`${row.trace.name}\nstill in flight`}>
          <span className="dt-map-bar wf-inflight-bar" style={place} />
        </span>
        <Running start={start} until={row.until} className="dt-map-time" />
      </div>
    </div>
  );
}

/** One trace of the page in the waterfall: its rows, from its root, loaded as the panel loads a trace. */
function WaterfallTrace({
  id,
  rows,
  stored,
  depth,
  fold,
  anchor,
}: {
  id: string;
  rows: readonly TraceRow[];
  stored: ReadonlySet<string>;
  depth: number;
  fold: boolean;
  anchor?: number | undefined;
}) {
  return (
    <TraceScreen
      id={id}
      source={source}
      arriving={arrivingIn(rows, stored, id)}
      running={runningIn(rows, id)}
      variant="waterfall"
      waterfall={{ depth, foldRoot: fold, anchor }}
      links={PANEL_LINKS}
    />
  );
}
