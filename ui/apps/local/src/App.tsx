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
  LogoMark,
  MethodBadge,
  RuntimeIcon,
  runtimeKind,
  runtimeName,
  type TabId,
  TraceList,
  type TraceRow,
  type TraceSummary,
} from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import { TooltipProvider } from "@tracepanel/ui/components/ui/tooltip";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ClearDialog } from "./ClearDialog";
import { Console } from "./Console";
import { exploreFor } from "./explore";
import { type TabEntry, type TabHistory, usePolling, useTabHistory } from "./hooks";
import { RefreshProvider } from "./refresh";
import { go, href, type Route, useRoute } from "./routes";
import { ThemeToggle } from "./Sidebar";
import { graphqlOperation } from "./sections";
import { TraceScreen } from "./TraceScreen";
import { UserSwitcher } from "./UserSwitcher";

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
const LIST_WIDTH = 360;
const MIN_LIST_WIDTH = 220;
const MIN_TRACE_WIDTH = 360;

function readListWidth(): number {
  try {
    const value = Number(localStorage.getItem(LIST_WIDTH_KEY));
    return value >= MIN_LIST_WIDTH ? value : LIST_WIDTH;
  } catch {
    return LIST_WIDTH;
  }
}

function clampListWidth(value: number): number {
  return Math.round(Math.min(Math.max(value, MIN_LIST_WIDTH), window.innerWidth - MIN_TRACE_WIDTH));
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
      onDoubleClick={() => apply(LIST_WIDTH, true)}
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
    issue_kinds: [],
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
function RuntimeChip({ label }: { label: string }) {
  const kind = runtimeKind(label);
  return (
    <span className="runtime-chip" title={`Served by ${label}`}>
      {kind ? <RuntimeIcon kind={kind} /> : null}
      {kind ? runtimeName(kind) : label.split(" · ")[0]}
    </span>
  );
}

/** Clear, where the requests are listed, as in the browser's Network tab. */
function ClearButton({ onClear }: { onClear: () => void }) {
  return (
    <button type="button" className="icon-button" title="Clear requests" aria-label="Clear requests" onClick={onClear}>
      <ClearIcon />
    </button>
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
      if (event.key === "Escape") setOpen(false);
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
        <span className="switcher-count">{rows.length}</span>
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
  lead,
  rows,
  selectedId,
  currentId = null,
  follow,
  onFollow,
  onClear,
}: {
  scope?: "page" | "tab";
  /** Shown first in the head row (the logo, when the head is part of the panel's toolbar). */
  lead?: ReactNode;
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
      <div className="page-requests-head">
        <span className="flex min-w-0 items-center gap-2">
          {lead}
          <span className="truncate">
            {scope === "tab" ? "This tab" : "This page"} <span className="page-requests-count">{count}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <label className="toggle">
            <input type="checkbox" checked={follow} onChange={(event) => onFollow(event.target.checked)} />
            <span className="toggle-track" aria-hidden="true" />
            Follow new
          </label>
          <ClearButton onClear={onClear} />
        </span>
      </div>
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
  const onFollow = (value: boolean) => {
    setFollow(value);
    writeFollow(value);
  };
  const tabRows = split ? chronological(rows) : rows;
  const followRows = split ? tabRows : pageRows;
  const latestChild = followRows.length > 1 ? followRows.at(-1)?.trace.id : undefined;
  const followed = useRef(latestChild);
  useEffect(() => {
    if (follow && latestChild && latestChild !== followed.current) go({ name: "trace", id: latestChild });
    followed.current = latestChild;
  }, [follow, latestChild]);

  const panelActions = (
    <>
      <UserSwitcher source={source} onSwitched={() => tellWidget("tracepanel:reload")} />
      <Button variant="outline" size="sm" className="mr-1 h-7 gap-1.5 px-2.5 text-[13px] shadow-none" asChild>
        <a
          href={`${base}${selectedId ? href({ name: "trace", id: selectedId }) : "#/"}`}
          target="_blank"
          rel="noreferrer"
          title="Open this request in the full console, in a new tab"
        >
          Console
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
  const runtime = history?.runtime ? <RuntimeChip label={history.runtime} /> : null;
  const logo = (
    <span className="flex shrink-0 items-center gap-2" title="Tracepanel">
      <LogoMark className="size-6" />
      <span className="sr-only">Tracepanel</span>
      {runtime}
    </span>
  );
  // Docked at the bottom with a request open, the panel is two rows: the list's head and the trace's toolbar share
  // the first one (as in browser devtools), so no bar of its own.
  const toolbarInTrace = split && selectedId !== null;

  return (
    <div className="panel">
      {toolbarInTrace ? null : (
        <header className="bar">
          <span className="flex shrink-0 items-center gap-2" title="Tracepanel">
            <LogoMark className="size-7" />
            <span className="sr-only">Tracepanel</span>
            {runtime}
          </span>
          {split ? (
            <span className="bar-title">Tracepanel</span>
          ) : (
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
      <div className={split ? "panel-split" : "panel-main"} ref={splitRef}>
        {split ? (
          <PageRequests
            scope="tab"
            lead={toolbarInTrace ? logo : undefined}
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
              id={selectedId}
              source={source}
              variant={split ? "strip" : "compact"}
              preferredTab={tab}
              onTabChange={(next) => {
                setTab(next);
                writeTab(next);
              }}
              actions={split ? panelActions : undefined}
              onOpenTrace={(id) => window.open(`${base}${href({ name: "trace", id })}`, "_blank")}
              explore={(trace) => exploreFor(trace, (route) => window.open(`${base}${href(route)}`, "_blank"))}
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
        {embedded ? <PanelApp route={route} /> : <Console route={route} source={source} />}
      </RefreshProvider>
    </TooltipProvider>
  );
}
