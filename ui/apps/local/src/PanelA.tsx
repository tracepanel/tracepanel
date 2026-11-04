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
  Logo,
  RangeBand,
  type RowKind,
  type Stretch,
  type TraceRow,
  useRangeDrag,
  WaterfallContext,
  type WaterfallFacts,
  type WaterfallHost,
} from "@tracepanel/ui";
import { isTyping } from "@tracepanel/ui/lib/keys";
import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import { ListEndIcon } from "lucide-react";
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

/** The rows of the page the trace on screen is on: its page row and the requests under it. */
function pageOf(rows: readonly TraceRow[], id: string | null): TraceRow[] {
  const at = rows.findIndex((row) => row.trace.id === id);
  if (at === -1) return [];
  let head = at;
  while (head > 0 && rows[head]?.depth) head -= 1;
  let end = head + 1;
  while (end < rows.length && rows[end]?.depth) end += 1;
  return rows.slice(head, end).filter((row) => !(row.run || row.group));
}

/** How far apart (µs) the page and its first request may be on two clocks before the page is placed by its requests. */
const CLOCKS_APART = 60_000_000;

/**
 * The page's rows on one clock: its requests as the browser timed them; the page itself as its trace says, unless that
 * is on another clock far from them (an app's, set apart from the browser's): then it ends where its first request
 * starts.
 */
function onBrowserClock(page: TraceRow[]): TraceRow[] {
  const [head, ...rest] = page;
  const first = rest.length ? Math.min(...rest.map((row) => row.trace.start)) : null;
  if (!head || first === null || Math.abs(first - (head.trace.start + head.trace.duration)) < CLOCKS_APART) return page;
  return [{ ...head, trace: { ...head.trace, start: first - head.trace.duration } }, ...rest];
}

/**
 * The waterfall's top rows: the page, then its requests under it. A browser's view has its requests in its own call
 * tree (its chain), so they are not listed again.
 */
function topRows(page: readonly TraceRow[]): TraceRow[] {
  const [head, ...rest] = page;
  if (!head) return [];
  if (head.trace.kind === "page") return [head, ...rest.filter((row) => row.trace.kind === "page")];
  return [head, ...rest];
}

/** The page's time: from its first start to its last end. */
function pageAxis(rows: readonly TraceRow[]): Axis | null {
  if (rows.length === 0) return null;
  const start = Math.min(...rows.map((row) => row.trace.start));
  const end = Math.max(...rows.map((row) => row.trace.start + row.trace.duration));
  return { start, duration: Math.max(end - start, 1) };
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
function useTreeKeys(scroll: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const root = scroll.current?.querySelector<HTMLElement>(".wf-rows");
    if (!root) return;
    const rows = () => [...root.querySelectorAll<HTMLElement>(".dt-map-row")].filter((row) => row.offsetParent);
    const mark = () => {
      const all = rows();
      const current = all.find((row) => row.getAttribute("aria-current") === "true") ?? all[0];
      for (const row of all) {
        let level = 1;
        for (let at = row.parentElement; at && at !== root; at = at.parentElement) {
          if (at.firstElementChild?.classList.contains("dt-map-row") && at.firstElementChild !== row) level += 1;
        }
        const set = (name: string, value: string) => row.getAttribute(name) !== value && row.setAttribute(name, value);
        set("role", "treeitem");
        set("aria-level", String(level));
        set("aria-selected", String(row.getAttribute("aria-current") === "true"));
        set("tabindex", row === current || row === document.activeElement ? "0" : "-1");
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current"] });
    const onKey = (event: KeyboardEvent) => {
      const all = rows();
      const at = all.indexOf(event.target as HTMLElement);
      if (at === -1) return;
      const to = new Map([
        ["ArrowDown", at + 1],
        ["ArrowUp", at - 1],
        ["Home", 0],
        ["End", all.length - 1],
      ]).get(event.key);
      if (to === undefined) return;
      event.preventDefault();
      all[Math.min(Math.max(to, 0), all.length - 1)]?.focus();
      mark();
    };
    root.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      root.removeEventListener("keydown", onKey);
    };
  });
}

/** Where the axis says its times: about five ticks at a round step. */
function ticks(axis: Axis, offset = 0): { at: number; label: string }[] {
  const raw = axis.duration / 5;
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
      <button
        type="button"
        className="icon-button wf-follow"
        aria-label="Follow new requests"
        aria-pressed={follow}
        onClick={() => onFollow(!follow)}
      >
        <ListEndIcon />
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
}: {
  axis: Axis;
  ticksRef: RefObject<HTMLSpanElement | null>;
  filter: ReactNode;
  /** The page's idle start left off the axis (µs): a break mark says how long. */
  skipped: number;
}) {
  return (
    <div className="wf-head wf-grid">
      {filter}
      <span className="wf-ticks" aria-hidden="true" ref={ticksRef} title="Drag to pick a stretch of time">
        {skipped > 0 ? (
          <span className="wf-break" title={`${duration(skipped)} before the first span, left off the axis`}>
            ⫽ {duration(skipped)}
          </span>
        ) : null}
        {ticks(axis, skipped).map((tick) => (
          <span key={tick.at} style={{ left: `${tick.at * 100}%` }}>
            {tick.label}
          </span>
        ))}
      </span>
      <span>Time</span>
    </div>
  );
}

const KINDS: { id: RowKind; label: string }[] = [
  { id: "sql", label: "SQL" },
  { id: "http", label: "HTTP" },
  { id: "logs", label: "Logs" },
];

/** The kinds of spans the waterfall keeps: All, or one kind. No counts: the root row's details have the totals. */
function KindChips({ kind, onKind }: { kind: RowKind | null; onKind: (kind: RowKind | null) => void }) {
  return (
    <span className="wf-kinds" role="radiogroup" aria-label="Kind of spans">
      {[{ id: null, label: "All" } as const, ...KINDS].map((each) => (
        // biome-ignore lint/a11y/useSemanticElements: chips in a field, not a form's radio buttons.
        <button
          key={each.label}
          type="button"
          role="radio"
          aria-checked={kind === each.id}
          className="wf-kind"
          onClick={() => onKind(each.id)}
        >
          {each.label}
        </button>
      ))}
    </span>
  );
}

const SHORTCUTS: readonly [string, string][] = [
  ["Keep one kind of spans", "the head's segments"],
  ["Pick a stretch of time", "drag across the bars"],
  ["Let the stretch, the kind, the row go", "Esc"],
  ["Move between rows · open · close", "↑ ↓ → ←"],
  ["Pick a stretch from the keyboard", "not yet"],
  ["Search", "⌘K"],
  ["This list", "?"],
];

/** ? : the keys, in a small sheet over the panel. */
function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the sheet closes it; Esc does too.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it.
    <div className="wf-shortcuts-backdrop" onClick={onClose}>
      <div className="wf-shortcuts" role="dialog" aria-label="Keyboard shortcuts">
        <h3>Keyboard shortcuts</h3>
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
      aria-valuenow={value === null ? undefined : Math.round(value)}
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
      if (now.shortcuts) does.shortcuts(false);
      else if (now.range) does.clearRange();
      else if (now.kind) does.clearKind();
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

  const page = useMemo(() => onBrowserClock(pageOf(listed, selectedId)), [listed, selectedId]);
  const top = topRows(page);
  const axisKey = page.map((row) => `${row.trace.id}:${row.trace.start}:${row.trace.duration}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `axisKey` says when the page's time changed.
  const whole = useMemo(() => pageAxis(page), [axisKey]);
  const [works, setWorks] = useState<number | null>(null);
  const { axis, skipped } = useMemo(() => withoutIdleStart(whole, works), [whole, works]);
  const { host, setKind, setRange, setSelected } = useHost(axis, details);
  const firstWork = Math.min(...[...host.facts.values()].map((each) => each.work));
  useEffect(() => setWorks(Number.isFinite(firstWork) ? firstWork : null), [firstWork]);
  useTreeKeys(scrollRef);
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
  }, [top[0]?.trace.id]);
  const drag = useRangeDrag(axis?.duration ?? 1, (picked) => setRange({ from: picked[0], to: picked[1] }));
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
            <Logo className="shrink-0 gap-1.5 text-md [&>span]:hidden [&_svg]:size-5" />
          </div>
          <div className="wf-zone wf-zone-tools" />
          <div className="wf-zone wf-zone-actions">
            <SwitchUser source={source} onSwitched={() => tellWidget("tracepanel:reload")} />
            <ProfileToggle source={source} labeled={true} />
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
            <ThemeToggle compact={true} />
            <DockButton dock={dock} />
            <Hint title="Close" keys="Esc">
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
              if (ticksRef.current && target.closest(".dt-map-track, .wf-ticks")) drag.start(event, ticksRef.current);
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
                    filter={
                      <span className="wf-call-head">
                        <KindChips kind={host.kind} onKind={setKind} />
                        <FollowButton follow={follow} onFollow={onFollow} />
                        <ClearButton onClear={() => setClearing(true)} label="Clear the list" />
                      </span>
                    }
                  />
                ) : null}
              </div>
              <div className="wf-rows" role="tree" aria-label="Spans" data-filter={host.kind ? "" : undefined}>
                {selectedId && top.length === 0 ? (
                  <WaterfallTrace id={selectedId} rows={rows} stored={stored} depth={0} fold={false} />
                ) : null}
                {top.map((row, at) => (
                  <WaterfallTrace
                    key={row.key ?? row.trace.id}
                    id={row.trace.id}
                    rows={rows}
                    stored={stored}
                    anchor={row.trace.start}
                    depth={at === 0 ? 0 : 1}
                    fold={top.length > 1}
                  />
                ))}
                {history && !selectedId ? (
                  <p className="wf-hint">No requests yet: requests from this browser tab appear here.</p>
                ) : null}
              </div>
            </div>
            {shownRange && axis ? (
              <div className="wf-range-layer">
                <RangeBand range={[shownRange.from, shownRange.to]} total={axis.duration} />
              </div>
            ) : null}
            <NamesSplitter value={names} onSize={setNames} scroll={scrollRef} />
          </div>
          <aside className="wf-details" aria-label="Details" hidden={!(host.selected || host.range)}>
            <DetailsSplitter dock={dock} value={detailsSize} onSize={setDetailsSize} main={mainRef} />
            {host.range && !host.selected ? (
              <p className="wf-range-head">
                Stretch {duration(skipped + host.range.from)} – {duration(skipped + host.range.to)} ·{" "}
                {duration(host.range.to - host.range.from)}
              </p>
            ) : null}
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
