import {
  ChevronDownIcon,
  ClearIcon,
  CloseIcon,
  type DataSource,
  DockBottomIcon,
  DockRightIcon,
  Empty,
  ExternalIcon,
  httpSource,
  ISSUE_LABELS,
  type IssueKind,
  LayersIcon,
  Logo,
  MethodBadge,
  type TabId,
  TraceList,
  type TraceRow,
  type TraceSummary,
} from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import { TooltipProvider } from "@tracepanel/ui/components/ui/tooltip";
import { cn, rem } from "@tracepanel/ui/lib/utils";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ClearDialog } from "./ClearDialog";
import { Console } from "./Console";
import { exploreFor } from "./explore";
import { type TabEntry, type TabHistory, usePolling, useTabHistory } from "./hooks";
import { RefreshProvider } from "./refresh";
import { consoleLinks, go, href, type Route, SECTIONS, useRoute } from "./routes";
import { SearchPalette } from "./SearchPalette";
import { ThemeToggle } from "./Sidebar";
import { ScopeProvider } from "./scope";
import { graphqlOperation } from "./sections";
import { tabOf } from "./TracePage";
import { TraceScreen } from "./TraceScreen";
import { NARROW_ICON, UserSwitcher } from "./UserSwitcher";

const base = location.href.split("#")[0] ?? location.href;
const source: DataSource = httpSource(new URL("api/", base));
const embedded = window.parent !== window;

function tellWidget(
  type: "tracepanel:close" | "tracepanel:reload" | "tracepanel:dock" | "tracepanel:clear",
  detail: Record<string, unknown> = {},
): void {
  window.parent.postMessage({ type, ...detail }, "*");
}

type Dock = "right" | "bottom";

/** Where the widget docks the panel; it says so when the panel loads and whenever it changes. */
function useDock(): Dock {
  const [dock, setDock] = useState<Dock>("right");
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (event.source !== window.parent || typeof data !== "object" || data === null) return;
      if ("type" in data && data.type === "tracepanel:dock" && "dock" in data) {
        setDock(data.dock === "bottom" ? "bottom" : "right");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return dock;
}

const LIST_WIDTH_KEY = "tracepanel:list-width";
// In rem, so the defaults follow the density; a dragged width is the reader's, in pixels.
const LIST_WIDTH = () => Math.round(rem(22.5));
const MIN_LIST_WIDTH = () => Math.round(rem(13.75));
const MIN_TRACE_WIDTH = () => Math.round(rem(22.5));

function readListWidth(): number {
  try {
    const value = Number(localStorage.getItem(LIST_WIDTH_KEY));
    return value >= MIN_LIST_WIDTH() ? value : LIST_WIDTH();
  } catch {
    return LIST_WIDTH();
  }
}

function clampListWidth(value: number): number {
  return Math.round(Math.min(Math.max(value, MIN_LIST_WIDTH()), window.innerWidth - MIN_TRACE_WIDTH()));
}

/**
 * The divider between the request list and the trace: drag it, use the arrow keys, double-click to reset.
 * While dragging the width goes straight to the CSS variable, so React does not render on every pointer move.
 */
function SplitHandle({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const [width, setWidth] = useState(readListWidth);
  const apply = useCallback(
    (value: number, save: boolean) => {
      const next = clampListWidth(value);
      container.current?.style.setProperty("--list-width", `${next}px`);
      if (!save) return;
      setWidth(next);
      try {
        localStorage.setItem(LIST_WIDTH_KEY, String(next));
      } catch {
        // Storage can be blocked: the width then lasts for this panel only.
      }
    },
    [container],
  );
  useEffect(() => apply(width, false), [apply, width]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable separator has no native element.
    <div
      className="split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the request list"
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(event) => {
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        handle.dataset["dragging"] = "";
        const left = container.current?.getBoundingClientRect().left ?? 0;
        const onMove = (move: PointerEvent) => apply(move.clientX - left, false);
        const onUp = (up: PointerEvent) => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          delete handle.dataset["dragging"];
          apply(up.clientX - left, true);
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      }}
      onDoubleClick={() => apply(LIST_WIDTH(), true)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 80 : 20;
        if (event.key === "ArrowLeft") apply(width - step, true);
        else if (event.key === "ArrowRight") apply(width + step, true);
        else return;
        event.preventDefault();
      }}
    />
  );
}

/** Wide enough for the request list beside the trace, as in the devtools Network tab. */
const SPLIT_WIDTH = 900;

function useSplit(dock: Dock): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= SPLIT_WIDTH);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= SPLIT_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return dock === "bottom" ? wide : false;
}

/* ---------- Tab history (panel) ---------- */

/** A row built from what the widget saw in the response headers, until the stored trace arrives. */
// biome-ignore-start lint/style/useNamingConvention: builds an API object; its field names are the wire format.
function fromWidget(entry: TabEntry): TraceSummary | undefined {
  const summary = entry.summary;
  if (!summary) return undefined;
  const [method, ...path] = summary.name.split(" ");
  return {
    id: entry.id,
    kind: "http",
    name: summary.name,
    start: summary.start,
    duration: summary.duration,
    status: (summary.status ?? 200) >= 500 ? "error" : "ok",
    http_status: summary.status,
    queries: summary.queries,
    issues: summary.issues,
    method: method ?? "GET",
    path: path.join(" "),
    // The widget only knows what Server-Timing told it; the rest fills in once the trace loads.
    route: null,
    view: null,
    user_id: null,
    db_time: 0,
    errors: 0,
    logs: 0,
    mails: 0,
    // Named as soon as the widget knows them, so the row's chip doesn't change when the trace loads.
    issue_kinds: (summary.kinds ?? []).filter((kind): kind is IssueKind => kind in ISSUE_LABELS),
    db_aliases: [],
    cache_aliases: [],
    task_state: null,
    htmx: summary.htmx ? (summary.htmx.boosted ? "boosted" : "request") : null,
  };
}
// biome-ignore-end lint/style/useNamingConvention: builds an API object; its field names are the wire format.

/** Pages newest first, each followed by its own fetch/XHR requests in the order they happened. */
function arrange(history: TabHistory, traces: readonly TraceSummary[]): TraceRow[] {
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  for (const entry of history.entries) {
    const fallback = byId.has(entry.id) ? undefined : fromWidget(entry);
    if (fallback) byId.set(entry.id, fallback);
  }
  const children = new Map<string | null, TraceSummary[]>();
  for (const entry of history.entries) {
    const trace = byId.get(entry.id);
    if (!trace) continue;
    const parent = entry.parent && byId.has(entry.parent) ? entry.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), trace]);
  }
  // What sent each request, as the widget saw it (htmx's trigger element and target).
  const sent = new Map(history.entries.map((entry) => [entry.id, entry.summary?.htmx]));
  const row = (trace: TraceSummary, depth: 0 | 1): TraceRow => {
    const htmx = sent.get(trace.id);
    // A boosted link loaded a page: its path names it, not the link's text.
    if (!htmx || htmx.boosted) return { trace, depth };
    return { trace, depth, trigger: htmx.trigger, target: htmx.target };
  };
  const roots = [...(children.get(null) ?? [])].reverse();
  return roots.flatMap((root) => [row(root, 0), ...(children.get(root.id) ?? []).map((trace) => row(trace, 1))]);
}

/** Oldest page first, each followed by its requests: new requests land at the bottom, as in the Network tab. */
function chronological(rows: readonly TraceRow[]): TraceRow[] {
  const pages: TraceRow[][] = [];
  for (const row of rows) {
    if (row.depth === 0 || pages.length === 0) pages.push([row]);
    else pages.at(-1)?.push(row);
  }
  return pages.reverse().flat();
}

function isChildOf(history: TabHistory | null, row: TraceRow, pageId: string): boolean {
  return history?.entries.some((entry) => entry.id === row.trace.id && entry.parent === pageId) ?? false;
}

function useTabRows(history: TabHistory | null): TraceRow[] {
  const ids = history?.entries.map((entry) => entry.id) ?? [];
  const key = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies the id list.
  const load = useCallback(
    () => (ids.length ? source.listTraces({ ids, limit: ids.length }) : Promise.resolve([])),
    [key],
  );
  const traces = usePolling(load);
  return history ? arrange(history, traces ?? []) : [];
}

/** What served the page, as its mark and name; the versions in the tooltip ("Python 3.12 · Django 6.0"). */

/** Follow new: open each request as it arrives. */
function FollowToggle({ follow, onFollow }: { follow: boolean; onFollow: (value: boolean) => void }) {
  const byPointer = useRef(false);
  return (
    <label
      className="toggle"
      title="Open each new request as it arrives"
      onPointerDown={() => (byPointer.current = true)}
    >
      <input
        type="checkbox"
        checked={follow}
        onChange={(event) => {
          onFollow(event.target.checked);
          // A click on the label focuses the hidden box, and Chrome then rings it: a mouse doesn't need the ring.
          if (byPointer.current) event.target.blur();
          byPointer.current = false;
        }}
      />
      <span className="toggle-track" aria-hidden="true" />
      Follow new
    </label>
  );
}

/** The list's count and its two controls: in the list's head, or in the dock's toolbar row over the list. */
function ListControls({
  count,
  follow,
  onFollow,
  onClear,
}: {
  count: ReactNode;
  follow: boolean;
  onFollow: (value: boolean) => void;
  onClear: () => void;
}) {
  return (
    <>
      <span className="list-count">{count}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <FollowToggle follow={follow} onFollow={onFollow} />
        <ClearButton onClear={onClear} />
      </span>
    </>
  );
}

/** Clear, where the requests are listed, as in the browser's Network tab. */
function ClearButton({ onClear, label = "Clear requests" }: { onClear: () => void; label?: string }) {
  return (
    <button type="button" className="icon-button" title={label} aria-label={label} onClick={onClear}>
      <ClearIcon />
    </button>
  );
}

/** As on the pill: a stack and the number of this tab's requests. */
function RequestCount({ count }: { count: number }) {
  return (
    <span className="switcher-count" title={`${count} ${count === 1 ? "request" : "requests"} in this tab`}>
      <LayersIcon />
      {count}
    </span>
  );
}

function RequestSwitcher({
  rows,
  selectedId,
  currentId,
  onClear,
}: {
  rows: readonly TraceRow[];
  selectedId: string | null;
  currentId: string | null;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = rows.find((row) => row.trace.id === selectedId)?.trace;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // This Esc closes the list, not the panel.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="switcher" ref={root}>
      <button
        type="button"
        className="switcher-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {selected ? (
          <>
            <MethodBadge method={graphqlOperation(selected) ? "GQL" : selected.method} htmx={selected.htmx} />
            <span className="switcher-path">{graphqlOperation(selected) ?? selected.path ?? selected.name}</span>
          </>
        ) : (
          <span className="switcher-path">Requests</span>
        )}
        <RequestCount count={rows.length} />
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="switcher-popover">
          <div className="switcher-caption">
            Pages and requests in this browser tab
            <ClearButton
              onClear={() => {
                setOpen(false);
                onClear();
              }}
            />
          </div>
          <TraceList
            rows={rows}
            selectedId={selectedId}
            currentId={currentId}
            onSelect={(id) => {
              setOpen(false);
              go({ name: "trace", id });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

const TAB_KEY = "tracepanel:panel-tab";
const PANEL_TABS = new Set<TabId>(["request", "tree", "issues", "sql", "logs", "mail", "error"]);

/** The tab the panel opens: the last one picked, kept across requests and page loads. */
/** The console list a request of this kind belongs to: the way back from its trace page there. */
function sectionFor(kind: string | undefined): string | undefined {
  const section = { http: "endpoints", task: "tasks", command: "jobs", websocket: "websockets" }[kind ?? ""];
  return section ? `#/${section}` : undefined;
}

function readTab(): TabId | undefined {
  try {
    const value = localStorage.getItem(TAB_KEY);
    return value && PANEL_TABS.has(value as TabId) ? (value as TabId) : undefined;
  } catch {
    return undefined;
  }
}

function writeTab(tab: TabId): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage can be blocked; the choice then lasts for this panel only.
  }
}

const FOLLOW_KEY = "tracepanel:follow";

/** On unless turned off: the newest request is usually the one to look at, as in the browser's Network tab. */
function readFollow(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeFollow(value: boolean): void {
  try {
    localStorage.setItem(FOLLOW_KEY, value ? "1" : "0");
  } catch {
    // Storage can be blocked; the toggle then lasts for this panel only.
  }
}

/** Ids that appeared since the previous render, kept for a moment to highlight them. */
function useNewIds(ids: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const key = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies the id list.
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const known = seen.current;
    const added = ids.filter((id) => !known.has(id));
    for (const id of added) known.add(id);
    if (added.length === 0) return;
    setFresh(new Set(added));
    const timer = window.setTimeout(() => setFresh(new Set()), 1600);
    return () => window.clearTimeout(timer);
  }, [key]);
  return fresh;
}

/** Close enough to the end to count as reading the newest requests. */
const BOTTOM_SLACK = 24;

/**
 * New requests arrive at the bottom, as in a terminal: a list scrolled to its end stays there (and Follow always
 * scrolls), while a list scrolled up to read something stays put and counts what arrived below, for "↓ N new".
 */
function useStickToBottom(
  list: RefObject<HTMLElement | null>,
  count: number,
  follow: boolean,
): { unseen: number; jump: () => void } {
  const seen = useRef(count);
  // The list's height before the latest rows: was it scrolled to the end then? Measured, not tracked through
  // scroll events, which a hidden tab delivers late.
  const height = useRef(0);
  const [unseen, setUnseen] = useState(0);

  const jump = useCallback(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
    setUnseen(0);
  }, [list]);

  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const onScroll = () => {
      if (element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK) setUnseen(0);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [list]);

  // Before paint: the list never shows a frame scrolled away from its end.
  useLayoutEffect(() => {
    const element = list.current;
    const added = count - seen.current;
    seen.current = count;
    const wasAtEnd =
      !element || height.current === 0 || height.current - element.scrollTop - element.clientHeight <= BOTTOM_SLACK;
    if (wasAtEnd || follow) jump();
    else if (added > 0) setUnseen((value) => value + added);
    height.current = element?.scrollHeight ?? 0;
  }, [count, follow, jump, list]);

  return { unseen, jump };
}

/**
 * The current page and every fetch/XHR it made, above the trace; docked at the bottom, every page and request of the
 * browser tab, beside the trace (`scope="tab"`).
 */
function PageRequests({
  scope = "page",
  head = true,
  rows,
  selectedId,
  currentId = null,
  follow,
  onFollow,
  onClear,
}: {
  scope?: "page" | "tab";
  /** false where the dock's toolbar row carries the count and the controls. */
  head?: boolean;
  rows: readonly TraceRow[];
  selectedId: string | null;
  currentId?: string | null;
  follow: boolean;
  onFollow: (value: boolean) => void;
  onClear: () => void;
}) {
  const fresh = useNewIds(rows.map((row) => row.trace.id));
  const list = useRef<HTMLElement>(null);
  const { unseen, jump } = useStickToBottom(list, rows.length, follow);
  const ajax = rows.length - 1;
  const count =
    scope === "tab"
      ? `· ${rows.length} ${rows.length === 1 ? "request" : "requests"}`
      : ajax > 0
        ? `+ ${ajax} ${ajax === 1 ? "request" : "requests"}`
        : "· no AJAX requests yet";
  return (
    <section
      ref={list}
      className={scope === "tab" ? "page-requests panel-list" : "page-requests"}
      aria-label={scope === "tab" ? "Pages and requests in this browser tab" : "Requests made by this page"}
    >
      {head ? (
        <div className="page-requests-head">
          <ListControls
            count={
              <>
                {scope === "tab" ? "This tab" : "This page"} <span className="page-requests-count">{count}</span>
              </>
            }
            follow={follow}
            onFollow={onFollow}
            onClear={onClear}
          />
        </div>
      ) : null}
      <TraceList
        compact={true}
        rows={rows}
        selectedId={selectedId}
        currentId={currentId}
        newIds={fresh}
        onSelect={(id) => go({ name: "trace", id })}
      />
      {unseen > 0 ? (
        <button type="button" className="new-requests" onClick={jump}>
          ↓ {unseen} new
        </button>
      ) : null}
    </section>
  );
}

function PanelApp({ route }: { route: Route }) {
  const history = useTabHistory();
  const rows = useTabRows(history);
  const currentId = history?.current ?? null;
  const pageRows = currentId
    ? rows.filter((row) => row.trace.id === currentId || isChildOf(history, row, currentId))
    : [];
  const selectedId =
    route.name === "trace" ? route.id : (currentId ?? rows.find((row) => row.depth === 0)?.trace.id ?? null);

  const dock = useDock();
  const splitRef = useRef<HTMLDivElement>(null);
  const split = useSplit(dock);
  const [follow, setFollow] = useState(readFollow);
  const [tab, setTab] = useState(readTab);
  const [clearing, setClearing] = useState(false);
  const [searching, setSearching] = useState(false);
  // ⌘K, as in the console: a trace opens here, anything else in the console, in a new tab.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setSearching((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const onFollow = (value: boolean) => {
    setFollow(value);
    writeFollow(value);
  };
  const tabRows = split ? chronological(rows) : rows;
  const followRows = split ? tabRows : pageRows;
  const latestChild = followRows.length > 1 ? followRows.at(-1)?.trace.id : undefined;
  const followed = useRef(latestChild);
  // The history the panel opens with is what was already there, not a new request: the request a link asked for
  // (the pill's card) stays on screen. Only requests that arrive after it are followed.
  const seeded = useRef(history !== null);
  useEffect(() => {
    if (!seeded.current) {
      if (history === null) return;
      seeded.current = true;
      followed.current = latestChild;
      return;
    }
    if (follow && latestChild && latestChild !== followed.current) go({ name: "trace", id: latestChild });
    followed.current = latestChild;
  }, [follow, latestChild, history]);

  // Esc anywhere in the panel closes it, as on the page; a menu or list open in it takes the Esc first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) tellWidget("tracepanel:close");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectedKind = rows.find((row) => row.trace.id === selectedId)?.trace.kind;
  const panelActions = (
    <>
      <UserSwitcher source={source} onSwitched={() => tellWidget("tracepanel:reload")} />
      <Button
        variant="outline"
        size="sm"
        className={cn("mr-1 h-7 gap-1.5 px-2.5 text-sm shadow-none", NARROW_ICON)}
        asChild
      >
        <a
          href={`${base}${selectedId ? href({ name: "trace", id: selectedId, tab, from: sectionFor(selectedKind) }) : "#/"}`}
          target="_blank"
          rel="noreferrer"
          title="Open this request in the full console, in a new tab"
          aria-label="Open in the console"
        >
          <span className="bar-label">Console</span>
          <ExternalIcon />
        </a>
      </Button>
      <ThemeToggle compact={true} />
      <button
        type="button"
        className="icon-button"
        title={dock === "right" ? "Dock to bottom" : "Dock to right"}
        onClick={() => tellWidget("tracepanel:dock")}
      >
        {dock === "right" ? <DockBottomIcon /> : <DockRightIcon />}
      </button>
      <button type="button" className="icon-button" title="Close (Esc)" onClick={() => tellWidget("tracepanel:close")}>
        <CloseIcon />
      </button>
    </>
  );
  const requestCount = `${tabRows.length} ${tabRows.length === 1 ? "request" : "requests"}`;
  // Docked at the bottom with a request open, the panel has no bar of its own: the logo over the list and the trace's
  // toolbar make one row across it (as in browser devtools).
  const toolbarInTrace = split && selectedId !== null;

  return (
    <div className="panel">
      <SearchPalette
        open={searching}
        onOpenChange={setSearching}
        source={source}
        sections={new Set(SECTIONS)}
        openRoute={(target) =>
          target.name === "trace" ? go(target) : window.open(`${base}${href(target)}`, "_blank", "noopener")
        }
      />
      {toolbarInTrace ? null : (
        <header className="bar">
          {/* The runtime is on the pill: the panel shows whose it is, not what served the page again. */}
          <Logo className="shrink-0 gap-1.5 text-md [&_svg]:size-6" />
          {split ? null : (
            <RequestSwitcher
              rows={rows}
              selectedId={selectedId}
              currentId={history?.current ?? null}
              onClear={() => setClearing(true)}
            />
          )}
          <div className="bar-actions">{panelActions}</div>
        </header>
      )}
      {!split && pageRows.length > 1 ? (
        <PageRequests
          rows={pageRows}
          selectedId={selectedId}
          follow={follow}
          onFollow={onFollow}
          onClear={() => setClearing(true)}
        />
      ) : null}
      <div className={split ? "panel-split" : "panel-main"} data-brand={toolbarInTrace ? "" : undefined} ref={splitRef}>
        {/* Over the list, level with the trace's tabs: one toolbar row across the dock, as in browser devtools. */}
        {toolbarInTrace ? (
          <div className="panel-brand">
            <Logo className="shrink-0 gap-1.5 text-md [&_svg]:size-5" />
            {/* No count here: the rows are right below; Clear's tooltip says how many. */}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <FollowToggle follow={follow} onFollow={onFollow} />
              <ClearButton onClear={() => setClearing(true)} label={`Clear ${requestCount}`} />
            </span>
          </div>
        ) : null}
        {split ? (
          <PageRequests
            scope="tab"
            head={!toolbarInTrace}
            rows={tabRows}
            selectedId={selectedId}
            currentId={currentId}
            follow={follow}
            onFollow={onFollow}
            onClear={() => setClearing(true)}
          />
        ) : null}
        {split ? <SplitHandle container={splitRef} /> : null}
        <main className="panel-body">
          {selectedId ? (
            <TraceScreen
              // A link to another tab of the trace on screen opens that tab: a new screen, not a kept state.
              key={route.name === "trace" && route.tab ? `${selectedId} ${route.tab}` : selectedId}
              id={selectedId}
              source={source}
              variant={split ? "strip" : "compact"}
              // A link to a tab (the pill's card opens a finding on Issues) wins over the last tab used.
              initialTab={route.name === "trace" ? tabOf(route.tab) : undefined}
              preferredTab={tab}
              onTabChange={(next) => {
                setTab(next);
                writeTab(next);
              }}
              actions={split ? panelActions : undefined}
              links={consoleLinks(base, true)}
              explore={(trace) => exploreFor(trace, (route) => `${base}${href(route)}`)}
            />
          ) : history ? (
            <Empty title="No requests yet">Requests from this browser tab will appear here.</Empty>
          ) : (
            <div className="app-loading" role="status">
              <span className="sr-only">Loading</span>
            </div>
          )}
        </main>
      </div>
      <ClearDialog
        mode="panel"
        open={clearing}
        onOpenChange={setClearing}
        source={source}
        onCleared={(permanent) => {
          // Deleted for good, the current page's trace is gone too: the list starts empty.
          tellWidget("tracepanel:clear", { all: permanent });
          go({ name: "home" });
        }}
      />
    </div>
  );
}

export function App() {
  const route = useRoute();
  return (
    <TooltipProvider delayDuration={300}>
      <RefreshProvider>
        {embedded ? (
          <PanelApp route={route} />
        ) : (
          <ScopeProvider>
            <Console route={route} source={source} />
          </ScopeProvider>
        )}
      </RefreshProvider>
    </TooltipProvider>
  );
}
