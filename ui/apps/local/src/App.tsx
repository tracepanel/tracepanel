import {
  ArrowLeftIcon,
  type Chain,
  type ChainCall,
  type ChainEntry,
  ChevronDownIcon,
  ClearIcon,
  CloseIcon,
  callsCounted,
  chainApps,
  chainCalls,
  type DataSource,
  DockBottomIcon,
  DockRightIcon,
  Empty,
  ExternalIcon,
  Hint,
  httpSource,
  ISSUE_LABELS,
  type IssueKind,
  KindBadge,
  LayersIcon,
  type ListChains,
  Logo,
  memoryFromParams,
  PageName,
  parseSlice,
  type ServiceMap,
  type Slice,
  sliceParams,
  type TabId,
  TaskName,
  TraceBadge,
  type TraceLinks,
  TraceList,
  type TraceRow,
  type TraceSummary,
  type ViewMemory,
  waitingSummary,
  waitingUntil,
  withSnapshots,
} from "@tracepanel/ui";
import { TooltipProvider } from "@tracepanel/ui/components/ui/tooltip";
import { useCloseOnBlur } from "@tracepanel/ui/hooks/useCloseOnBlur";
import { type ChainCounts, chainCounts } from "@tracepanel/ui/lib/chainCounts";
import { chainCutAt } from "@tracepanel/ui/lib/live";
import { traceRuntime } from "@tracepanel/ui/lib/runtime";
import { rem } from "@tracepanel/ui/lib/utils";
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
import { ClearDialog } from "./ClearDialog";
import { Console } from "./Console";
import { exploreFor } from "./explore";
import { type EntrySummary, type TabEntry, type TabHistory, useNewIds, usePolling, useTabHistory } from "./hooks";
import { readLastTab, writeLastTab } from "./lastTab";
import { ProfileToggle } from "./ProfileToggle";
import {
  forgetUnless,
  goBackInPanel,
  openLinked,
  type PanelView,
  restoringFor,
  setCurrentView,
  useBackStep,
} from "./panelBack";
import { RefreshProvider } from "./refresh";
import { consoleLinks, go, href, type Route, useRoute } from "./routes";
import { SearchPalette } from "./SearchPalette";
import { ShareAction } from "./ShareDialog";
import { NAV, ThemeToggle } from "./Sidebar";
import { ScopeProvider } from "./scope";
import { graphqlOperation, requestPath } from "./sections";
import { sharingLoads } from "./sharedLoads";
import { tabOf } from "./TracePage";
import { ARRIVING_MS, type Running, TraceScreen } from "./TraceScreen";
import { SwitchUser } from "./UserSwitcher";

const base = location.href.split("#")[0] ?? location.href;
const api = new URL("api/", base);
const source: DataSource = sharingLoads(withSnapshots(httpSource(api), api));
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
// A narrow window gives the trace the room: its tabs keep their names where the list would take them (a quarter of
// the width, down to 15rem).
const LIST_WIDTH = () => Math.round(Math.min(rem(22.5), Math.max(rem(15), window.innerWidth * 0.26)));
const MIN_LIST_WIDTH = () => Math.round(rem(13.75));
const MIN_TRACE_WIDTH = () => Math.round(rem(22.5));

/** The width the reader dragged the list to, kept in this browser; null where they never did. */
function storedListWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(LIST_WIDTH_KEY));
    return value >= MIN_LIST_WIDTH() ? value : null;
  } catch {
    return null;
  }
}

/**
 * The list's width: the reader's, else the default for the panel's width, followed as the panel opens and resizes
 * (it may be narrow at first while it opens).
 */
function useListWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => storedListWidth() ?? LIST_WIDTH());
  const [dragged, setDragged] = useState(() => storedListWidth() !== null);
  useEffect(() => {
    if (dragged) return;
    const follow = () => setWidth(LIST_WIDTH());
    follow();
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [dragged]);
  const drag = useCallback((next: number) => {
    setDragged(true);
    setWidth(next);
  }, []);
  return [width, drag];
}

function clampListWidth(value: number): number {
  return Math.round(Math.min(Math.max(value, MIN_LIST_WIDTH()), window.innerWidth - MIN_TRACE_WIDTH()));
}

/**
 * The divider between the request list and the trace: drag it, use the arrow keys, double-click to reset.
 * While dragging the width goes straight to the CSS variable, so React does not render on every pointer move.
 */
function SplitHandle({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const [width, setWidth] = useListWidth();
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
    [container, setWidth],
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
    // Not known until the agent has the trace: the row names no app until then.
    service: "",
    kind: "http",
    name: summary.name,
    start: summary.start,
    duration: summary.duration,
    status: summary.failed || (summary.status ?? 200) >= 500 ? "error" : "ok",
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
/** A row from what the widget knows: a request, or a view or an action recorded in the browser. */
function rowFromWidget(entry: TabEntry): TraceSummary | undefined {
  return entry.summary?.kind === "page" ? pageFromWidget(entry.id, entry.summary) : fromWidget(entry);
}

/** A view or an action recorded in the browser: named by its page and what was done, not a method and a path. */
function pageFromWidget(id: string, summary: EntrySummary): TraceSummary {
  return {
    id,
    service: "",
    kind: "page",
    name: summary.name,
    start: summary.start,
    duration: summary.duration,
    status: summary.failed ? "error" : "ok",
    http_status: null,
    queries: 0,
    issues: 0,
    method: null,
    path: null,
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
    htmx: null,
  };
}
// biome-ignore-end lint/style/useNamingConvention: builds an API object; its field names are the wire format.

/** Pages newest first, each followed by its own fetch/XHR requests in the order they happened. */
function arrange(history: TabHistory, traces: readonly TraceSummary[]): TraceRow[] {
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  const stored = new Set(byId.keys());
  for (const entry of history.entries) {
    const fallback = byId.has(entry.id) ? undefined : rowFromWidget(entry);
    if (fallback) byId.set(entry.id, fallback);
  }
  for (const entry of history.entries) {
    const trace = byId.get(entry.id);
    if (trace && stored.has(entry.id)) byId.set(entry.id, waitedFor(trace, entry.summary));
  }
  const facts = new Map(history.entries.map((entry) => [entry.id, widgetFacts(entry, stored)]));
  const children = childrenOf(history, byId, facts);
  const row = (trace: TraceSummary, depth: 0 | 1): TraceRow => {
    const { htmx, ...known } = facts.get(trace.id) ?? {};
    // A boosted link loaded a page: its path names it, not the link's text.
    if (!htmx || htmx.boosted) return { trace, depth, ...known };
    return { trace, depth, trigger: htmx.trigger, target: htmx.target, ...known };
  };
  const roots = [...(children.get(null) ?? [])].reverse();
  return roots.flatMap((root) => [row(root, 0), ...(children.get(root.id) ?? []).map((trace) => row(trace, 1))]);
}

/**
 * A stored request the page made, as the page waited for it: from the call to its answer, as the browser timed it (a
 * call the browser queued behind others waited longer than its server took), never less than its trace's own time.
 * Its row says the same time in flight, once answered and once stored, as the pill does; its trace says its own.
 */
function waitedFor(trace: TraceSummary, summary: EntrySummary | undefined): TraceSummary {
  const clock = summary?.clock;
  if (!clock) return trace;
  return { ...trace, start: clock.start, duration: Math.max(clock.end - clock.start, trace.duration) };
}

/** What the widget says of a row beyond its summary. */
type WidgetFacts = Partial<
  Pick<TraceRow, "open" | "until" | "redirectedFrom" | "key" | "opens" | "host" | "loadHost" | "span" | "failed">
> & {
  htmx?: EntrySummary["htmx"];
};

/**
 * What the widget says of an entry: in flight (a request the page waits for, a view still open) until the agent has
 * it, a view's time stopped at its calls' last answer; the view the SPA was sent from at once; the id it flew under
 * (its row's identity from in flight to stored); the view a call that answered untraced opens (it has no trace of
 * its own); the host it went to (a view's calls to one host are grouped); what sent it (htmx).
 */
function widgetFacts(entry: TabEntry, stored: ReadonlySet<string>): WidgetFacts {
  const summary = entry.summary;
  if (!summary) return {};
  const open = summary.open && !stored.has(entry.id);
  return {
    ...(open ? { open: true, until: summary.until } : {}),
    ...(summary.redirectedFrom ? { redirectedFrom: summary.redirectedFrom } : {}),
    ...(summary.key ? { key: summary.key } : {}),
    ...(summary.untraced && entry.parent ? { opens: entry.parent } : {}),
    ...(open ? {} : failedFact(summary)),
    ...(summary.host ? { host: summary.host } : {}),
    ...(summary.loadHost ? { loadHost: summary.loadHost } : {}),
    ...(summary.span ? { span: summary.span } : {}),
    ...(summary.htmx ? { htmx: summary.htmx } : {}),
  };
}

/** A call that got no answer at all (a network error): "failed", as its view's trace will say it. */
function failedFact(summary: EntrySummary): Pick<WidgetFacts, "failed"> {
  return summary.untraced && summary.failed && summary.status === null ? { failed: "No answer" } : {};
}

/**
 * Each page's requests, in the order they started (made in the same millisecond, in the order they were made): a row
 * keeps its place as it lands, answers, and is stored. Under `null`, the pages.
 */
function childrenOf(
  history: TabHistory,
  byId: ReadonlyMap<string, TraceSummary>,
  facts: ReadonlyMap<string, WidgetFacts>,
): Map<string | null, TraceSummary[]> {
  const children = new Map<string | null, TraceSummary[]>();
  for (const entry of history.entries) {
    const trace = byId.get(entry.id);
    if (!trace) continue;
    const parent = entry.parent && byId.has(entry.parent) ? entry.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), trace]);
  }
  const made = (id: string) => madeAt(facts.get(id)?.key ?? id);
  for (const [parent, traces] of children) {
    if (parent !== null) traces.sort((a, b) => a.start - b.start || made(a.id) - made(b.id));
  }
  return children;
}

/** The how-manieth request of its page load a request the widget saw in flight was ("~…-7": 7); 0 for any other. */
function madeAt(key: string): number {
  const match = /^~.*-(\d+)$/.exec(key);
  return match ? Number(match[1]) : 0;
}

/** Whether the requests come from more than one app: then each row names its own. */
function manyApps(rows: readonly TraceRow[]): boolean {
  const apps = rows.filter((row) => row.trace.kind !== "page" && row.trace.service).map((row) => row.trace.service);
  return new Set(apps).size > 1;
}

/** Docked at the bottom, the tab's list reads oldest first, as in the Network tab; else newest first. */
function inOrder(split: boolean, rows: readonly TraceRow[]): TraceRow[] {
  return split ? chronological(rows) : [...rows];
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

/**
 * The rows of "this page", as the pill counts them: the page (or the SPA's view of its route), the actions done on
 * it, and their requests (lib/live: one scope everywhere).
 */
function pageScope(history: TabHistory | null, rows: readonly TraceRow[]): TraceRow[] {
  if (!history?.current) return [];
  const scope = new Set(history.scope.length > 0 ? history.scope : [history.current]);
  const parents = new Map(history.entries.map((entry) => [entry.id, entry.parent]));
  // A view's calls from its chain: under the row above them.
  let head: string | null = null;
  return rows.filter((row) => {
    if (!row.depth) head = row.trace.id;
    const parent = parents.get(row.trace.id) ?? (row.depth ? head : null);
    return scope.has(row.trace.id) || scope.has(parent ?? "");
  });
}

/**
 * How many requests a list of rows holds: every call the page made, in flight, answered and stored alike, through a
 * gateway too (a view's calls are its own HTTP calls in its chain's count), but not the views and actions, not the
 * runs under them, not the row over a view's calls to one host.
 */
function requestCount(rows: readonly TraceRow[]): number {
  return rows.filter((row) => !(row.run || row.group) && row.trace.kind !== "page").length;
}

/** The task runs each request led to, by its id. */
type Runs = Readonly<Record<string, readonly TraceSummary[]>>;

const NO_RUNS: Runs = {};

/** The tab's traces as the agent has them, and the task runs each led to. */
interface TabTraces {
  traces: TraceSummary[];
  runs: Runs;
}

const NO_TRACES: TabTraces = { traces: [], runs: NO_RUNS };

/** The tab's traces as the agent has them, and the task runs each led to (none where the source can't say). */
function loadTab(ids: readonly string[]): Promise<TabTraces> {
  if (ids.length === 0) return Promise.resolve(NO_TRACES);
  if (source.listTracesWithRuns) return source.listTracesWithRuns(ids);
  return source.listTraces({ ids, limit: ids.length }).then((traces) => ({ traces, runs: NO_RUNS }));
}

/**
 * The tab's rows, which of them the agent has stored (the others are the widget's own, still on their way), and the
 * task runs each request led to, as the workers record them.
 */
function useTabRows(history: TabHistory | null): { rows: TraceRow[]; stored: ReadonlySet<string>; runs: Runs } {
  const ids = idsOf(history);
  const key = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies the id list.
  const load = useCallback(() => loadTab(ids), [key]);
  // The last answer's: whether a row that just ended is still on its way, so the list asks sooner.
  const known = useRef<ReadonlySet<string>>(new Set());
  const soon = (history?.entries ?? []).some((entry) => justEnded(entry, known.current));
  const { traces, runs } = usePolling(load, soon ? ARRIVING_POLL_MS : TAB_POLL_MS) ?? NO_TRACES;
  const stored = useMemo(() => new Set(traces.map((trace) => trace.id)), [traces]);
  known.current = stored;
  return { rows: history ? arrange(history, traces) : [], stored, runs };
}

/** How often the tab's rows are asked for. */
const TAB_POLL_MS = 2_000;
/**
 * How often while a row that just ended isn't stored yet: an app sends its trace as its request ends, and the agent
 * stores it within a moment; the row's numbers say "…" until the list knows (the pill, asking on its own, knows sooner).
 */
const ARRIVING_POLL_MS = 400;
/** How long after its end a row not stored yet is asked for that often. */
const ARRIVING_SOON_MS = 10_000;

/** A request or an ended view of the tab the agent hasn't stored yet (`stored`), which ended a moment ago. */
function justEnded(entry: TabEntry, stored: ReadonlySet<string>): boolean {
  const summary = entry.summary;
  if (!summary || summary.open || inFlight(entry.id) || summary.untraced || stored.has(entry.id)) return false;
  return Date.now() - (summary.start + summary.duration) / 1000 < ARRIVING_SOON_MS;
}

/**
 * Whether a trace of the tab's list is on its way to the agent: listed by the widget, not stored yet, and ended a
 * moment ago (a view still open counts from its start). Undefined for a trace the list doesn't have (a linked one).
 */
function arrivingIn(rows: readonly TraceRow[], stored: ReadonlySet<string>, id: string | null): boolean | undefined {
  const row = rows.find((item) => item.trace.id === id);
  if (!row) return undefined;
  if (stored.has(row.trace.id)) return false;
  // Still running (a view open, a request the page waits for): on its way however long it takes.
  if (row.open) return true;
  const ended = (row.trace.start + row.trace.duration) / 1000;
  return Date.now() - ended < ARRIVING_MS;
}

/** The ids the agent may have: not a request still in flight, which has the widget's id until its answer names its trace. */
/** A row of the list still in flight (a view open, a request the page waits for): when it started, and what it is. */
function runningIn(rows: readonly TraceRow[], id: string | null): Running | undefined {
  const row = rows.find((item) => item.trace.id === id);
  return row?.open ? { start: row.trace.start, view: row.trace.kind === "page", until: row.until } : undefined;
}

function idsOf(history: TabHistory | null): string[] {
  return history?.entries.filter((entry) => !inFlight(entry.id)).map((entry) => entry.id) ?? [];
}

/** A request in flight, by the id the widget gives it until its answer names its trace. */
function inFlight(id: string | null): boolean {
  return id?.startsWith("~") ?? false;
}

/* ---------- The chain under a row ---------- */

/** A row's chain is loaded again while it is this new: the traces of its calls may still be on their way. */
const CHAIN_FRESH_MS = 20_000;
const CHAIN_POLL_MS = 2_000;

/** What tells a row's two loads of its chain apart: its traces and how much each holds, the chain's findings. */
function chainKey(chain: Chain): string {
  const traces = chain.traces.map((each) => `${each.id}:${each.trace?.spans.length ?? 0}`).join(",");
  return `${traces}|${chain.issues.length}|${chain.capped}`;
}

/** What a row says that its chain may have changed with: its time, queries, findings. */
function rowKey(trace: TraceSummary): string {
  return `${trace.id}:${trace.duration}:${trace.queries}:${trace.issues}`;
}

/** A row's first load of its chain shows placeholder rows once it takes this long (a quick one shows nothing). */
const CHAIN_SLOW_MS = 250;

/** The rows under the list's rows: the apps each one's trace called, and the rows whose first load is slow. */
interface RowChains {
  apps: ReadonlyMap<string, ChainEntry[]>;
  /** By a view's or an action's id: its calls, one row each (chainCalls), once its chain loaded. */
  calls: ReadonlyMap<string, ChainCall[]>;
  /** By a view's or an action's id: what some of its calls' traces did, as its chain counts it (callsCounted). */
  counters: ReadonlyMap<string, Counter>;
  loading: ReadonlySet<string>;
  /** What each row's whole chain did, as the pill and the trace's tabs count it: the row says the same. */
  counts: ReadonlyMap<string, ChainCounts>;
  /** The rows whose chain has loaded once: the others' numbers are pending. Undefined where chains don't load. */
  settled: ReadonlySet<string> | undefined;
  /** Where each row's trace was cut with a call still unanswered (lib/live). */
  cut: ReadonlyMap<string, number>;
}

/**
 * A row's chain without its calls cut short (no answer yet) while the page still waits for a request of its own: that
 * request's row, in flight under it, is the same call, said once (lib/live).
 */
function withoutFlying(
  apps: ReadonlyMap<string, ChainEntry[]>,
  history: TabHistory | null,
): ReadonlyMap<string, ChainEntry[]> {
  const waiting = new Set(
    (history?.entries ?? []).filter((entry) => entry.summary?.open && inFlight(entry.id)).map((entry) => entry.parent),
  );
  if (waiting.size === 0) return apps;
  return new Map(
    [...apps].map(([id, entries]) => [
      id,
      waiting.has(id) ? entries.filter((entry) => entry.type !== "waiting" || entry.cut === null) : entries,
    ]),
  );
}

/** A view's call, as its row: its place (when it started, µs) and the row. */
type Placed = { at: number; row: TraceRow };

/** When a call started (µs): the call's own start, not its trace's. */
function callStart(call: ChainCall): number {
  return call.type === "trace" ? call.called : call.start;
}

/** When a call ended (µs), as the view's trace has it. */
function callEnd(call: ChainCall): number {
  return call.type === "trace" ? (call.ended ?? call.called + call.summary.duration) : call.end;
}

/** When a row the widget listed ended (µs): its answer, or now for one still in flight. */
function flightEnd(flight: TraceRow): number {
  return flight.open ? Date.now() * 1000 : flight.trace.start + flight.trace.duration;
}

/** What a call is named by, to match its row in flight: its GraphQL operation, else its method. */
function callName(name: string): string {
  return name.startsWith("GraphQL ") ? name : (name.split(" ")[0] ?? "");
}

/** How far apart (µs) a call's start in the browser's trace and in the widget can be to be the same call. */
const SAME_CALL_US = 3_000_000;

/**
 * The widget's row each of a view's calls was in flight (`flights`, "~…"): the same call, by the span id its
 * traceparent carried where the widget saw it; else the same name and the nearest start and end, as the browser timed
 * both (calls made at once, the browser queueing some, start together and end apart). A call keeps that row's
 * identity (its key) as its chain's row takes over, never another call's.
 */
function matchFlights(calls: readonly ChainCall[], flights: readonly TraceRow[]): Map<string, TraceRow> {
  const matched = bySpan(calls, flights);
  const taken = new Set(matched.values());
  const free = new Set(flights.filter((flight) => !taken.has(flight)));
  for (const call of [...calls].sort((a, b) => callStart(a) - callStart(b) || callEnd(a) - callEnd(b))) {
    if (matched.has(call.key)) continue;
    const best = nearest(call, free);
    if (!best) continue;
    free.delete(best);
    matched.set(call.key, best);
  }
  return matched;
}

/** Each call whose span id a row the widget listed carries: that row, by the call's key. */
function bySpan(calls: readonly ChainCall[], flights: readonly TraceRow[]): Map<string, TraceRow> {
  const rows = new Map(flights.flatMap((flight) => (flight.span ? [[flight.span, flight] as const] : [])));
  return new Map(
    calls.flatMap((call) => {
      const flight = call.w3c ? rows.get(call.w3c) : undefined;
      return flight ? [[call.key, flight] as const] : [];
    }),
  );
}

/**
 * The free row nearest a call by when it started and ended, of its name and within SAME_CALL_US of its start; a row
 * whose span id the widget knows is another call's when the call has one too.
 */
function nearest(call: ChainCall, free: ReadonlySet<TraceRow>): TraceRow | undefined {
  const name = callName(call.type === "trace" ? call.summary.name : waitingSummary(call).name);
  const apart = (flight: TraceRow) =>
    Math.abs(flight.trace.start - callStart(call)) + Math.abs(flightEnd(flight) - callEnd(call));
  const same = [...free].filter(
    (flight) =>
      !(flight.span && call.w3c) &&
      callName(flight.trace.name) === name &&
      Math.abs(flight.trace.start - callStart(call)) <= SAME_CALL_US,
  );
  return same.reduce<TraceRow | undefined>(
    (best, flight) => (!best || apart(flight) < apart(best) ? flight : best),
    undefined,
  );
}

/** A view's call as a row of the list, one step under its view, the same row as it was in flight. */
function callRow(call: ChainCall, view: string, flight: TraceRow | undefined): TraceRow {
  const key = flight?.key ?? flight?.trace.id ?? call.key;
  // The host its row was grouped by in flight, so its group stays the same row.
  const host = flight?.host ?? call.host;
  const to = host ? { host } : {};
  // The time its row said once answered (the widget's clock): never less now, the view's trace timing it a hair apart.
  const said = flight && !flight.open ? flight.trace.duration : 0;
  if (call.type === "trace") {
    const runtime = traceRuntime(call.trace.attrs);
    const clock = { start: call.called, end: call.ended ?? call.called + call.summary.duration };
    // Its time as the view made the call, as its row said in flight: the trace that served it says its own.
    const trace = { ...call.summary, duration: Math.max(clock.end - clock.start, said) };
    return { trace, depth: 1, key, call: "trace", counted: true, folded: true, ...to, runtime, clock };
  }
  const summary = waitingSummary(call);
  // Its status as its answer said it, when the span doesn't.
  const status = summary.http_status ?? (call.cut === null ? (flight?.trace.http_status ?? null) : null);
  const duration = call.cut === null ? Math.max(summary.duration, said) : summary.duration;
  // biome-ignore lint/style/useNamingConvention: wire format.
  const trace = { ...summary, duration, http_status: status };
  const state =
    call.failed !== undefined
      ? { call: "failed" as const, failed: call.failed }
      : call.untraced
        ? { call: "untraced" as const, host: call.untraced }
        : { call: "waiting" as const };
  return { trace, depth: 1, key, opens: view, cut: call.cut, ...to, ...state };
}

/**
 * The list with each view's calls from its chain (chainCalls), once it loaded: in place of the widget's rows of them
 * (in flight "~…", or answered untraced), each in its row's place, keeping its key; a call still in flight keeps its
 * running row. The rows under each call (what its trace called) by its trace's id, in `apps`.
 */
function withViewCalls(
  rows: readonly TraceRow[],
  { calls, counters }: Pick<RowChains, "calls" | "counters">,
  apps: ReadonlyMap<string, ChainEntry[]>,
  { settled, known }: Pick<Grouping, "settled" | "known">,
): { rows: TraceRow[]; apps: ReadonlyMap<string, ChainEntry[]> } {
  const under = new Map(apps);
  const out: TraceRow[] = [];
  let at = 0;
  while (at < rows.length) {
    const head = rows[at] as TraceRow;
    let end = at + 1;
    while (end < rows.length && (rows[end] as TraceRow).depth) end += 1;
    const children = rows.slice(at + 1, end);
    const own = calls.get(head.trace.id);
    const placed = own ? placeCalls(head.trace.id, own, children, under) : children;
    const view = head.trace.id;
    const grouping = { view, settled, known, counter: counters.get(view) };
    out.push(head, ...(head.trace.kind === "page" ? byHost(placed, grouping) : placed));
    at = end;
  }
  return { rows: out, apps: under };
}

/** A view's rows under it with its calls from its chain in the widget's rows' places, in the order they started. */
function placeCalls(
  view: string,
  calls: readonly ChainCall[],
  children: readonly TraceRow[],
  under: Map<string, ChainEntry[]>,
): TraceRow[] {
  const flights = children.filter((row) => row.trace.id.startsWith("~"));
  const matched = matchFlights(calls, flights);
  const running = new Set(flights.filter((row) => row.open));
  const placed: Placed[] = children
    .filter((row) => !row.trace.id.startsWith("~") || running.has(row))
    .map((row) => ({ at: row.trace.start, row }));
  for (const call of calls) {
    const flight = matched.get(call.key);
    // Still in flight in the widget (cut short in the view's trace): its running row says it.
    if (flight && running.has(flight)) continue;
    if (call.type === "trace" && call.apps.length > 0) under.set(call.id, call.apps);
    // In the place its row had: by when the widget saw it start.
    placed.push({ at: flight?.trace.start ?? callStart(call), row: callRow(call, view, flight) });
  }
  const made = (row: TraceRow) => madeAt(row.key ?? row.trace.id);
  return placed.sort((a, b) => a.at - b.at || made(a.row) - made(b.row)).map((each) => each.row);
}

/**
 * A view's calls with those to one host (two or more) under one row (TraceRow.group), where the first of them is,
 * from in flight on: the row is named by the host until a trace of theirs names the app ("graphql-router ×5"), and
 * the calls stay its rows, in their order, as they fill in. A task run stays under the request it came from.
 */
function byHost(rows: readonly TraceRow[], grouping: Grouping): TraceRow[] {
  const units = unitsOf(rows);
  const hosts = new Map<string, TraceRow[][]>();
  for (const unit of units) {
    const host = unit[0]?.host ?? "";
    hosts.set(host, [...(hosts.get(host) ?? []), unit]);
  }
  const out: TraceRow[] = [];
  for (const unit of units) {
    const host = unit[0]?.host ?? "";
    const members = hosts.get(host) ?? [];
    if (!host || members.length < 2) out.push(...unit);
    // Where the first of them is, once.
    else if (members[0] === unit) out.push(...grouped(host, members, grouping));
  }
  return out;
}

/** Each request with the task runs it led to after it: they stay together. */
function unitsOf(rows: readonly TraceRow[]): TraceRow[][] {
  const units: TraceRow[][] = [];
  for (const row of rows) {
    const last = units.at(-1);
    if (row.run && last) last.push(row);
    else units.push([row]);
  }
  return units;
}

/** A host's calls under their row, a step deeper. */
function grouped(host: string, members: readonly TraceRow[][], grouping: Grouping): TraceRow[] {
  const calls = members.map((each) => each[0] as TraceRow);
  const group = groupRow(host, calls, grouping);
  return [group, ...members.flat().map((row) => ({ ...row, depth: 2 as const }))];
}

/** What some of a view's calls' traces did, as its chain counts it; null when one of them isn't its chain's yet. */
type Counter = (ids: readonly string[]) => ChainCounts | null;

/** The app a host's calls were served by before (useKnownApps), and what it runs on. */
type KnownApp = { app: string; runtime: string | undefined };

/**
 * What a view's calls are grouped with: the view, the rows whose numbers are known, its chain's counts, and the app
 * each host was served by before.
 */
interface Grouping {
  view: string;
  settled: ReadonlySet<string> | undefined;
  counter: Counter | undefined;
  known: ReadonlyMap<string, KnownApp>;
}

/**
 * What a group's calls did: as the view's chain counts their traces and all under them, once they are all its
 * traces (a finding of the chain's across them said once, as the tabs say it), whether its chain made them its rows
 * or they are the list's own (an app with an SDK answered them: its trace's id came with the answer); their own
 * numbers added up until then.
 */
function together(calls: readonly TraceRow[], counter: Counter | undefined) {
  const traces = calls.map((call) => call.trace);
  const traced = calls.every((call) => call.call === "trace" || !(call.call || call.open || inFlight(call.trace.id)));
  const counted = counter && traced ? counter(traces.map((trace) => trace.id)) : null;
  if (counted) {
    // biome-ignore lint/style/useNamingConvention: wire format.
    return { queries: counted.queries, issues: counted.issues, issue_kinds: counted.kinds };
  }
  return {
    queries: traces.reduce((sum, trace) => sum + trace.queries, 0),
    issues: traces.reduce((sum, trace) => sum + trace.issues, 0),
    // biome-ignore lint/style/useNamingConvention: wire format.
    issue_kinds: [...new Set(traces.flatMap((trace) => trace.issue_kinds ?? []))],
  };
}

/** The app most of a group's calls' traces name, once any does. */
function appOf(calls: readonly TraceRow[]): string | null {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const traced = call.call === "trace" || !(call.call || inFlight(call.trace.id));
    if (traced && call.trace.service) counts.set(call.trace.service, (counts.get(call.trace.service) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** The row over a view's calls to one host: their time on the clock, what they did, together. */
function groupRow(host: string, calls: readonly TraceRow[], { view, settled, counter, known }: Grouping): TraceRow {
  const traces = calls.map((call) => call.trace);
  // The calls' own times, as the browser made them: in flight, answered and stored alike.
  const clocks = calls.map(
    (call) => call.clock ?? { start: call.trace.start, end: call.trace.start + call.trace.duration },
  );
  const start = Math.min(...clocks.map((clock) => clock.start));
  const end = Math.max(...clocks.map((clock) => clock.end));
  // Their traces' app once one came (it wins); before, the app that host was served by last.
  const served = appOf(calls);
  const before = served === null ? known.get(host) : undefined;
  const app = served ?? before?.app ?? null;
  const id = `${view}/calls/${host}`;
  const summary: TraceSummary = {
    ...(traces[0] as TraceSummary),
    id,
    service: app ?? "",
    name: app ?? host,
    start,
    duration: end - start,
    status: traces.some((trace) => trace.status === "error") ? "error" : "ok",
    // biome-ignore lint/style/useNamingConvention: wire format.
    http_status: null,
    ...together(calls, counter),
  };
  const runtime = calls.find((call) => call.runtime && call.trace.service === app)?.runtime ?? before?.runtime;
  return {
    trace: summary,
    depth: 1,
    key: id,
    group: {
      view,
      host,
      app,
      count: calls.length,
      ...(runtime ? { runtime } : {}),
      ...(calls.every((call) => call.call === "untraced" || call.failed !== undefined) ? { untraced: true } : {}),
    },
    ...(calls.some((call) => call.open) ? { open: true } : {}),
    // A call no trace answered has no numbers to wait for: its group's are known without it.
    counted: calls.every(
      (call) =>
        call.counted || call.call === "untraced" || call.failed !== undefined || settled?.has(call.trace.id) === true,
    ),
  };
}

/** How often the hosts' apps may be asked for again while the list has a host none is known for. */
const KNOWN_ASK_MS = 2_000;

/**
 * The app each host was last served by, as the agent's service map links them (a call to 127.0.0.1:8043 was served by
 * graphql-router): a view's calls to a host an app served before are grouped under its name from in flight on, not
 * under the host until their traces come. Asked when the list has a host none is known for, and again as views come
 * while it still has (at most every KNOWN_ASK_MS): their traces may have named it since. Their traces' app wins.
 */
function useKnownApps(rows: readonly TraceRow[]): ReadonlyMap<string, KnownApp> {
  const [known, setKnown] = useState<ReadonlyMap<string, KnownApp>>(() => new Map());
  const asked = useRef(0);
  const unknown = [...new Set(rows.flatMap((row) => (row.host && !known.has(row.host) ? [row.host] : [])))]
    .sort()
    .join(",");
  const views = rows.filter((row) => row.trace.kind === "page").length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view asks again for the hosts still unknown.
  useEffect(() => {
    if (!unknown) return;
    let live = true;
    const ask = () => {
      asked.current = Date.now();
      source.listServices("since:7d").then(
        (map) => live && setKnown(knownApps(map)),
        () => undefined,
      );
    };
    // Asked a moment ago: once more when the moment has passed.
    const timer = window.setTimeout(ask, Math.max(0, asked.current + KNOWN_ASK_MS - Date.now()));
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [unknown, views]);
  return known;
}

/**
 * The apps known to serve each host, with the page's own load's: the host that served the page's document is its
 * trace's app's (a Next app that served /docs serves the /openapi.json its view asked for), as a service map's link
 * names the app a host's calls reached. Its runtime is the page's, as the pill says it.
 */
function withLoads(
  known: ReadonlyMap<string, KnownApp>,
  rows: readonly TraceRow[],
  runtime: string | undefined,
): ReadonlyMap<string, KnownApp> {
  const loads = rows.filter((row) => row.loadHost && row.trace.service);
  if (loads.length === 0) return known;
  const out = new Map(known);
  for (const row of loads) out.set(row.loadHost as string, { app: row.trace.service, runtime });
  return out;
}

/** Each HTTP host's app in a service map: the one seen last where several served it. */
function knownApps(map: ServiceMap): ReadonlyMap<string, KnownApp> {
  const apps = new Map(map.apps.map((app) => [app.service, app]));
  const known = new Map<string, KnownApp & { seen: number }>();
  for (const link of map.links) {
    const host = /^http:[a-z]+\/(.+)$/.exec(link.peer ?? "")?.[1]?.replace(/:(80|443)$/, "");
    const app = apps.get(link.to_service);
    const seen = app?.last_seen ?? 0;
    if (!host || (known.get(host)?.seen ?? -1) >= seen) continue;
    known.set(host, { app: link.to_service, runtime: app?.runtime ?? undefined, seen });
  }
  return known;
}

/**
 * The rows whose numbers are known: their chain loaded (or can't be), or a row the agent doesn't have and won't any
 * more (not stored, not on its way): its own numbers are all there are, never "…" for good. Undefined where chains
 * don't load.
 */
function settledIn(
  loaded: ReadonlySet<string> | undefined,
  rows: readonly TraceRow[],
  stored: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  if (!loaded) return undefined;
  const gone = rows.filter(
    (row) => !(stored.has(row.trace.id) || inFlight(row.trace.id) || arrivingIn(rows, stored, row.trace.id)),
  );
  return gone.length === 0 ? loaded : new Set([...loaded, ...gone.map((row) => row.trace.id)]);
}

/** Each chain's counts, by its row's trace id. */
function countsOf(chains: ReadonlyMap<string, Chain>): ReadonlyMap<string, ChainCounts> {
  const counts = new Map<string, ChainCounts>();
  for (const [id, chain] of chains) {
    const counted = chainCounts(chain);
    if (counted) counts.set(id, counted);
  }
  return counts;
}

/** Where each row's own trace was cut, for those that were. */
function cutsOf(chains: ReadonlyMap<string, Chain>): ReadonlyMap<string, number> {
  const cuts = new Map<string, number>();
  for (const [id, chain] of chains) {
    const at = chainCutAt(chain);
    if (at !== null) cuts.set(id, at);
  }
  return cuts;
}

/**
 * The apps each row's trace called, by its id. A view's or an action's too: its requests to an app with an SDK are
 * rows of their own (left out here), but a call through a proxy or a gateway (Apollo Router, over OTLP) answers with
 * no trace id for the widget to list, and only the chain says what served it. Read from the trace's chain, as its
 * call tree and tabs read it (`source.chain`): loaded once a row is stored, again when the row changes, and every two
 * seconds while it is new or a call of it is still waited for (a service's trace can arrive after its caller's, a cut
 * call's minutes later). One load of a row at a time: a row whose
 * last load hasn't answered isn't asked again, and an answer that comes after the rows changed is kept all the same.
 * Its calls whose traces are on their way are rows too, until they arrive or stop being waited for (lib/chainRows).
 */
function useRowChains(rows: readonly TraceRow[], stored: ReadonlySet<string>): RowChains {
  const [chains, setChains] = useState<ReadonlyMap<string, Chain>>(() => new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const has = useRef(chains);
  has.current = chains;
  const loaded = useRef(new Map<string, string>());
  // The rows whose load hasn't answered: not asked again until it has.
  const asking = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const wanted = rows.filter((row) => stored.has(row.trace.id)).map((row) => row.trace);
  const key = wanted.map(rowKey).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` says which rows and what they hold.
  useEffect(() => {
    const load = source.chain;
    if (!load) return;
    const timers = new Set<number>();
    const keep = (id: string, chain: Chain) =>
      setChains((current) => {
        const before = current.get(id);
        return before && chainKey(before) === chainKey(chain) ? current : new Map(current).set(id, chain);
      });
    const done = (id: string) =>
      setLoading((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    const tick = () => {
      const now = Date.now();
      for (const trace of wanted) {
        if (asking.current.has(trace.id)) continue;
        const fresh = now - (trace.start + trace.duration) / 1000 < CHAIN_FRESH_MS;
        // A call of it still waited for (one cut short is, for minutes): its trace may come any time.
        const chain = has.current.get(trace.id);
        const awaited = chain !== undefined && (waitingUntil(chain, now) ?? 0) > now;
        if (loaded.current.get(trace.id) === rowKey(trace) && !fresh && !awaited) continue;
        loaded.current.set(trace.id, rowKey(trace));
        // Its first load: placeholders under the row once it is slow, so the list says something is on its way.
        const first = !has.current.has(trace.id);
        const timer = first
          ? window.setTimeout(
              () => mounted.current && setLoading((current) => new Set(current).add(trace.id)),
              CHAIN_SLOW_MS,
            )
          : undefined;
        if (timer !== undefined) timers.add(timer);
        asking.current.add(trace.id);
        const settle = () => {
          asking.current.delete(trace.id);
          window.clearTimeout(timer);
          if (timer !== undefined) timers.delete(timer);
          if (mounted.current) done(trace.id);
        };
        load(trace.id).then(
          (chain) => {
            if (mounted.current) keep(trace.id, chain);
            settle();
          },
          () => {
            // No chain to say more (the trace rotated out, the agent can't): its own numbers are all there are.
            if (mounted.current)
              setFailed((current) => (current.has(trace.id) ? current : new Set(current).add(trace.id)));
            settle();
          },
        );
      }
    };
    tick();
    const timer = window.setInterval(() => document.visibilityState === "visible" && tick(), CHAIN_POLL_MS);
    return () => {
      window.clearInterval(timer);
      for (const each of timers) window.clearTimeout(each);
    };
  }, [key]);
  // The waiting calls go once they stop being waited for: the rows are built again then (`expired` counts the times).
  const [expired, setExpired] = useState(0);
  const listed = rows.map((row) => row.trace.id).join(",");
  const pages = rows
    .filter((row) => row.trace.kind === "page")
    .map((row) => row.trace.id)
    .join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `expired` moved on: the rows are built at the time now.
  const { apps, calls, counters } = useMemo(() => {
    const rowsIn = new Set(listed.split(","));
    const views = new Set(pages.split(","));
    const apps = new Map<string, ChainEntry[]>();
    const calls = new Map<string, ChainCall[]>();
    const counters = new Map<string, Counter>();
    for (const [id, chain] of chains) {
      if (!rowsIn.has(id)) continue;
      // A view's or an action's calls are its rows, one each, as they were in flight (chainCalls).
      if (views.has(id)) {
        calls.set(id, chainCalls(chain, id, rowsIn));
        const known = new Set(chain.traces.map((each) => each.id));
        // Null while one of them isn't the chain's yet: their own numbers then.
        counters.set(id, (ids) => (ids.every((each) => known.has(each)) ? callsCounted(chain, id, rowsIn, ids) : null));
        continue;
      }
      const under = chainApps(chain, id, rowsIn);
      if (under.length > 0) apps.set(id, under);
    }
    return { apps, calls, counters };
  }, [chains, listed, pages, expired]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `expired` moved on: the next waiting call's end is asked.
  useEffect(() => {
    const ends = [...chains.values()].map((chain) => waitingUntil(chain)).filter((end) => end !== null);
    if (ends.length === 0) return;
    const wait = Math.max(0, Math.min(...ends) - Date.now()) + 50;
    const timer = window.setTimeout(() => setExpired((count) => count + 1), wait);
    return () => window.clearTimeout(timer);
  }, [chains, expired]);
  const counts = useMemo(() => countsOf(chains), [chains]);
  const cut = useMemo(() => cutsOf(chains), [chains]);
  const settled = useMemo(() => (source.chain ? new Set([...chains.keys(), ...failed]) : undefined), [chains, failed]);
  return { apps, calls, counters, loading, counts, settled, cut };
}

// The rows the user folded or opened, each a change from where it starts (an app's row open, a run open while its
// app has few traces); a new key, as the old one held the rows opened when an app's row started folded.
const CHAIN_OPEN_KEY = "tracepanel:chain-toggled";

/** The chain rows open in the list: kept for the browser tab's session, as the panel reloads with each page. */
function useChainOpen(): [ReadonlySet<string>, (key: string) => void] {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(CHAIN_OPEN_KEY) ?? "[]");
      return new Set(Array.isArray(saved) ? saved.filter((each) => typeof each === "string") : []);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((key: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      try {
        sessionStorage.setItem(CHAIN_OPEN_KEY, JSON.stringify([...next]));
      } catch {
        // Storage can be blocked: the rows then stay open for this panel only.
      }
      return next;
    });
  }, []);
  return [open, toggle];
}

/**
 * Each row followed by the task runs it led to, one step deeper, as they are recorded, each with its own findings: the
 * request's row doesn't count them again. A run is listed once.
 */
function withRuns(rows: readonly TraceRow[], runs: Runs): TraceRow[] {
  const listed = new Set(rows.map((row) => row.trace.id));
  return rows.flatMap((row) => {
    const own = unlisted(runs[row.trace.id], listed);
    if (own.length === 0) return [row];
    const depth = row.depth ? 2 : 1;
    return [row, ...own.map((trace) => ({ trace, depth, run: true }) as const)];
  });
}

/** The runs not listed yet, now listed. */
function unlisted(runs: readonly TraceSummary[] = [], listed: Set<string>): TraceSummary[] {
  const fresh = runs.filter((run) => !listed.has(run.id));
  for (const run of fresh) listed.add(run.id);
  return fresh;
}

/**
 * What Follow new opens for the newest row: the row itself, or, for a request a view or an action in the browser
 * made, that view or action, stored yet or not (on its way, it says so until it is). Its call tree has all of its
 * requests, so the selection stays on it as they come and as it ends: never the request, then the view again.
 */
function followTarget(rows: readonly TraceRow[]): string | undefined {
  const latest = rows.at(-1);
  if (latest?.depth !== 1) return latest?.trace.id;
  return groupOrRequest(rows, latest.trace.id);
}

/** The view or action heading the newest rows; else the request itself. */
function groupOrRequest(rows: readonly TraceRow[], request: string): string {
  const head = [...rows].reverse().find((row) => row.depth === 0);
  return head?.trace.kind === "page" ? head.trace.id : request;
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
      {/* In a narrow list's toolbar row, the switch alone: its name stays for screen readers and in the title. */}
      <span className="@max-[21rem]/brand:sr-only">Follow new</span>
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
        <ListToggles follow={follow} onFollow={onFollow} onClear={onClear} />
      </span>
    </>
  );
}

/** Follow new, Profile and Clear: one tight group wherever the list's controls sit. */
function ListToggles({
  follow,
  onFollow,
  onClear,
  clearLabel,
}: {
  follow: boolean;
  onFollow: (value: boolean) => void;
  onClear: () => void;
  clearLabel?: string | undefined;
}) {
  return (
    <>
      <FollowToggle follow={follow} onFollow={onFollow} />
      <ProfileToggle source={source} />
      <ClearButton onClear={onClear} label={clearLabel} />
    </>
  );
}

/** Clear, where the requests are listed, as in the browser's Network tab. */
function ClearButton({ onClear, label = "Clear requests" }: { onClear: () => void; label?: string | undefined }) {
  return (
    <Hint title={label} detail="Empties this tab's list. The requests stay in the console.">
      <button type="button" className="icon-button" aria-label={label} onClick={onClear}>
        <ClearIcon />
      </button>
    </Hint>
  );
}

/** As on the pill: a stack and the number of this page's requests. */
function RequestCount({ count }: { count: number }) {
  return (
    <span className="switcher-count" title={`${count} ${count === 1 ? "request" : "requests"} on this page`}>
      <LayersIcon />
      {count}
    </span>
  );
}

/** A trace as the panel names it in one line: a request by its method and path, a task or a job by its kind and name. */
function TraceName({ trace }: { trace: TraceSummary }) {
  // A view or an action as the list names it ("VIEW /authors"), not by the request line its trace may carry.
  if (trace.kind === "page") return <PageName name={trace.name} />;
  if (trace.kind === "http") return <RequestName trace={trace} />;
  return <KindAndName trace={trace} />;
}

/** A request by its method (GQL for a GraphQL operation) and its path. */
function RequestName({ trace }: { trace: TraceSummary }) {
  const operation = graphqlOperation(trace);
  return (
    <>
      <TraceBadge word={operation ? "GQL" : trace.method} htmx={trace.htmx} />
      <span className="switcher-path">{operation ?? requestPath(trace)}</span>
    </>
  );
}

/** A task, a job, a WebSocket event: its kind's badge and its name, a task's cut at its start. */
function KindAndName({ trace }: { trace: TraceSummary }) {
  return (
    <>
      <KindBadge kind={trace.kind} />
      {trace.kind === "task" ? (
        <TaskName name={trace.name} className="switcher-path" />
      ) : (
        <span className="switcher-path">{trace.name}</span>
      )}
    </>
  );
}

/** A trace's summary: from the list's rows when it is one of them, else as the agent lists it. */
function useNamed(id: string, rows: readonly TraceRow[]): TraceSummary | undefined {
  const known = rows.find((row) => row.trace.id === id)?.trace;
  const loaded = useSummary(known ? null : id);
  return known ?? loaded;
}

/** A trace's summary, as the agent lists it: the panel names the trace a linked one was opened from. */
function useSummary(id: string | null): TraceSummary | undefined {
  const [found, setFound] = useState<TraceSummary>();
  useEffect(() => {
    if (id === null) return;
    let current = true;
    source.listTraces({ ids: [id], limit: 1 }).then(
      ([trace]) => current && setFound(trace),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [id]);
  return found?.id === id ? found : undefined;
}

/** A tab as the Back button names it: where it goes. */
const TAB_NAMES: Record<TabId, string> = {
  request: "Request",
  app: "App",
  tree: "Call tree",
  issues: "Issues",
  sql: "DB",
  cache: "Cache",
  http: "HTTP calls",
  logs: "Logs",
  error: "Error",
  profile: "Profile",
};

// The first tab is named after the trace's kind, as its tab bar names it.
const KIND_TABS: Record<string, string> = { task: "Task", command: "Job", websocket: "WebSocket", page: "View" };

function tabName(tab: TabId | undefined, trace: TraceSummary | undefined): string {
  if (tab === "request") return KIND_TABS[trace?.kind ?? ""] ?? TAB_NAMES.request;
  return tab ? TAB_NAMES[tab] : "Trace";
}

/** What a trace's row says it opens on, in its tooltip: the tab last picked (NAVIGATION.md, rule 3). */
type OpensOn = ((trace: TraceSummary) => string | undefined) | undefined;

/** The tab last picked, said on the rows a click opens fresh; nothing to say for the call tree, where they open anyway. */
function opensOnTab(tab: TabId | undefined): OpensOn {
  if (!tab || tab === "tree") return undefined;
  return (trace) => `Opens on ${tabName(tab, trace)}, the tab you used last (the call tree where it has none)`;
}

/**
 * The way back to the view a linked trace was opened from, named for where it goes: that trace's tab and the trace,
 * as the list names it ("← Call tree · GQL query Books"). Esc goes there too. `bare` (docked right, the tabs need the
 * room): the arrow alone, its name in its label and tooltip.
 */
function BackTo({ view, rows, bare }: { view: PanelView | null; rows: readonly TraceRow[]; bare: boolean }) {
  return view ? <BackButton view={view} rows={rows} bare={bare} /> : null;
}

function BackButton({ view, rows, bare }: { view: PanelView; rows: readonly TraceRow[]; bare: boolean }) {
  const trace = useNamed(view.route.id, rows);
  const tab = tabName(view.tab, trace);
  const name = trace ? (graphqlOperation(trace) ?? trace.name) : "the trace";
  return (
    <Hint title={`Back to ${tab} · ${name}`} detail="Where you opened this trace from, as you left it." keys="Esc">
      <button
        type="button"
        className="panel-back"
        data-bare={bare || undefined}
        aria-label={`Back to ${tab} · ${name}`}
        onClick={() => goBackInPanel(currentTrace())}
      >
        <ArrowLeftIcon />
        {bare ? null : (
          <>
            <span className="panel-back-tab">{tab}</span>
            {trace ? (
              <>
                <span aria-hidden="true" className="panel-back-dot">
                  ·
                </span>
                <TraceName trace={trace} />
              </>
            ) : null}
          </>
        )}
      </button>
    </Hint>
  );
}

/** The trace on screen in the panel, as its address says. */
function currentTrace(): string | null {
  const match = /^#\/t\/([^?]+)/.exec(location.hash);
  return match?.[1] ?? null;
}

/**
 * Where a trace's parts lead from the panel: to the console in a new tab, but a linked trace (a task it enqueued, the
 * trace a call reached) opens here, with the way back to the view on screen.
 */
const PANEL_LINKS: TraceLinks = {
  ...consoleLinks(base, true),
  openTrace: openLinked,
};

function RequestSwitcher({
  rows,
  pageCount,
  selectedId,
  currentId,
  opensOn,
  onClear,
}: {
  rows: readonly TraceRow[];
  /** This page's requests, as the pill counts them. */
  pageCount: number;
  selectedId: string | null;
  currentId: string | null;
  opensOn: OpensOn;
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
  const closeList = useCallback(() => setOpen(false), []);
  useCloseOnBlur(open, closeList);

  return (
    <div className="switcher" ref={root}>
      <button
        type="button"
        className="switcher-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {selected ? <TraceName trace={selected} /> : <span className="switcher-path">Requests</span>}
        <RequestCount count={pageCount} />
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
            services={manyApps(rows)}
            selectedId={selectedId}
            currentId={currentId}
            opensOn={opensOn}
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

/** The console list a request of this kind belongs to: the way back from its trace page there. */
function sectionFor(kind: string | undefined): string | undefined {
  const section = {
    http: "endpoints",
    task: "tasks",
    command: "jobs",
    websocket: "websockets",
    rpc: "rpc",
    page: "pages",
  }[kind ?? ""];
  return section ? `#/${section}` : undefined;
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

/** The list of this page's requests, or the browser tab's: its class, its accessible name, its head's name. */
const LIST_SCOPES = {
  page: { className: "page-requests", label: "Requests made by this page", name: "This page" },
  tab: { className: "page-requests panel-list", label: "Pages and requests in this browser tab", name: "This tab" },
} as const;

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
  chains,
  opensOn,
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
  /** Under the rows that called other apps: those apps' traces. */
  chains?: ListChains | undefined;
  opensOn: OpensOn;
}) {
  const fresh = useNewIds(rows.map((row) => row.key ?? row.trace.id));
  const list = useRef<HTMLElement>(null);
  const { unseen, jump } = useStickToBottom(list, rows.length, follow);
  // Requests only, as the pill counts them: not the runs under them, not the browser's views and actions.
  const requests = requestCount(rows);
  const count = `· ${requests} ${requests === 1 ? "request" : "requests"}`;
  const look = LIST_SCOPES[scope];
  return (
    <section ref={list} className={look.className} aria-label={look.label}>
      {head ? (
        <div className="page-requests-head">
          <ListControls
            count={
              <>
                {look.name} <span className="page-requests-count">{count}</span>
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
        services={manyApps(rows)}
        rows={rows}
        selectedId={selectedId}
        currentId={currentId}
        newIds={fresh}
        chains={chains}
        opensOn={opensOn}
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

/** Moves the panel to the other side: the bottom or the right. */
function DockButton({ dock }: { dock: string }) {
  const label = dock === "right" ? "Dock to bottom" : "Dock to right";
  return (
    <Hint title={label} detail="The panel remembers where you put it.">
      <button type="button" className="icon-button" aria-label={label} onClick={() => tellWidget("tracepanel:dock")}>
        {dock === "right" ? <DockBottomIcon /> : <DockRightIcon />}
      </button>
    </Hint>
  );
}

/** Its children, when `when` holds. */
function Shown({ when, children }: { when: boolean; children: ReactNode }) {
  return when ? children : null;
}

/** The trace on screen in the console, as the panel shows it (its tab, the part of its time picked), or its home. */
function consoleHref(id: string | null, shown: Omit<Extract<Route, { name: "trace" }>, "name" | "id">): string {
  return id ? href({ name: "trace", id, ...shown }) : "#/";
}

/**
 * The part of the time picked in the trace on screen: kept while the trace is, for its screen to open with again,
 * and the Console button opens the trace with it.
 */
function usePanelSlice(id: string | null, route: Route) {
  const [sliced, setSliced] = useState<{ id: string | null; slice: Slice } | null>(null);
  // Else the one its address says: Back to a view with a part picked picks it again.
  const asked = route.name === "trace" && route.id === id && (route.part || route.range || route.logs);
  const slice =
    sliced?.id === id
      ? sliced.slice
      : asked && route.name === "trace"
        ? parseSlice(route.part, route.range, route.logs)
        : undefined;
  return {
    slice,
    params: slice ? sliceParams(slice) : {},
    onChange: (next: Slice) => setSliced({ id, slice: next }),
  };
}

/** The panel's scrolling pane: the trace's. */
function traceScroller(): HTMLElement | null {
  return document.querySelector(".panel-body");
}

/** How long Back waits for the trace it returns to to be drawn tall enough to scroll back into. */
const RESTORE_MS = 1500;

/** Puts the panel's scroll back where it was once the trace `id` is drawn, as Back returns to it. */
function restoreScroll(id: string, scroll: number): () => void {
  const until = Date.now() + RESTORE_MS;
  let timer = 0;
  const attempt = () => {
    const pane = traceScroller();
    const drawn = pane?.querySelector(`.dt-trace[data-trace="${id}"]`);
    if (pane && drawn && pane.scrollHeight - pane.clientHeight >= scroll) {
      pane.scrollTop = scroll;
      return;
    }
    if (Date.now() < until) timer = window.setTimeout(attempt, 50);
  };
  attempt();
  return () => window.clearTimeout(timer);
}

/**
 * The view on screen as the panel keeps it for Back: the tab shown, what the view's parts remember, the part of its
 * time picked; read when a linked trace opens from it. Returning to a view (Back), it opens with what it had and its
 * scroll comes back.
 */
function usePanelView(route: Route, id: string | null, slice: Readonly<Record<string, string>>) {
  const restoring = restoringFor(id);
  const initialMemory: ViewMemory =
    restoring?.memory ?? (route.name === "trace" && route.id === id ? memoryFromParams(route) : {});
  const shown = useRef<{ id: string | null; tab: TabId | undefined; memory: ViewMemory }>({
    id,
    tab: undefined,
    memory: initialMemory,
  });
  if (shown.current.id !== id) shown.current = { id, tab: undefined, memory: initialMemory };
  const latest = useRef({ route, id, slice });
  latest.current = { route, id, slice };
  useEffect(() => {
    setCurrentView(() => {
      const { route: now, id: on, slice: picked } = latest.current;
      if (now.name !== "trace" || on === null || shown.current.id !== on) return null;
      return {
        route: now,
        tab: shown.current.tab,
        memory: shown.current.memory,
        slice: picked,
        scroll: traceScroller()?.scrollTop ?? 0,
      };
    });
  }, []);
  // The way back is gone once the trace on screen came another way (the list, Follow new).
  useEffect(() => {
    forgetUnless(route.name === "trace" ? route.id : null);
  }, [route]);
  const scroll = restoring?.scroll;
  useEffect(() => {
    if (id === null || scroll === undefined) return;
    return restoreScroll(id, scroll);
  }, [id, scroll]);
  return {
    initialMemory,
    onTabShown: (tab: TabId) => {
      shown.current = { ...shown.current, tab };
    },
    onMemoryChange: (memory: ViewMemory) => {
      shown.current = { ...shown.current, memory };
    },
    /** The view on screen as an address of the console's: its Console button opens the same. */
    address: () => {
      const { tab, memory } = shown.current;
      return { tab, span: memory["span"], profile: memory["profile"], frames: memory["frames"], at: memory["at"] };
    },
  };
}

function PanelApp({ route }: { route: Route }) {
  const history = useTabHistory();
  const { rows, stored, runs } = useTabRows(history);
  const listed = withRuns(rows, runs);
  const rowChains = useRowChains(listed, stored);
  // Each view's calls from its chain in the rows they were in flight (withViewCalls): the list shows these.
  const settled = settledIn(rowChains.settled, rows, stored);
  const known = withLoads(useKnownApps(listed), listed, history?.runtime ?? undefined);
  const shown = withViewCalls(listed, rowChains, withoutFlying(rowChains.apps, history), { settled, known });
  const [chainOpen, toggleChain] = useChainOpen();
  const currentId = history?.current ?? null;
  const pageRows = pageScope(history, rows);
  const pageShown = pageScope(history, shown.rows);
  const selectedId =
    route.name === "trace" ? route.id : (currentId ?? rows.find((row) => row.depth === 0)?.trace.id ?? null);
  // A linked trace opened from another view: the way back to it, as it was.
  const back = useBackStep(selectedId);

  const dock = useDock();
  const splitRef = useRef<HTMLDivElement>(null);
  const split = useSplit(dock);
  const [follow, setFollow] = useState(readFollow);
  const [tab, setTab] = useState(readLastTab);
  const sliced = usePanelSlice(selectedId, route);
  const view = usePanelView(route, selectedId, sliced.params);
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
  const chains: ListChains = {
    apps: shown.apps,
    loading: rowChains.loading,
    counts: rowChains.counts,
    settled,
    cut: rowChains.cut,
    open: chainOpen,
    onToggle: toggleChain,
    // An app's row is that app's part of the chain: the call tree, at the row where its part starts (NAVIGATION.md).
    onApp: (id, app) => go({ name: "trace", id, under: app, tab: "tree" }),
  };
  const opensOn = opensOnTab(tab);
  const tabRows = inOrder(split, rows);
  const followRows = split ? tabRows : pageRows;
  const latestChild = followTarget(followRows);
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

  // Esc anywhere in the panel closes it, as on the page; a menu or list open in it takes the Esc first, and a linked
  // trace goes back to the view it was opened from, as the Back button does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!goBackInPanel(currentTrace())) tellWidget("tracepanel:close");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectedKind = listed.find((row) => row.trace.id === selectedId)?.trace.kind;
  const consoleAt = () =>
    `${base}${consoleHref(selectedId, { ...view.address(), from: sectionFor(selectedKind), ...sliced.params })}`;
  const toolbarInTrace = split && selectedId !== null;
  const switchUser = <SwitchUser source={source} onSwitched={() => tellWidget("tracepanel:reload")} />;
  // One row of quiet icons: what is done to this trace or this panel; who you are sits with the list. Explore, when
  // the trace's toolbar holds the row, is the first of the icons after Console.
  const panelActions = (explore?: ReactNode) => (
    <>
      <Shown when={!toolbarInTrace}>{switchUser}</Shown>
      <Hint
        title="Open in the console"
        detail="This request in the full console, in a new tab: every request, issue and query."
      >
        <a
          // Filled in both themes: the panel's one way out to the console, the same button dark or light. The solid
          // primary (the brand's strong violet, 5:1 with white: AA), not the light accent (2.2:1, which read as
          // blurred), as tall as the icons beside it; no filter or glow, which soften its text.
          className="mr-1 inline-flex h-7.5 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover [&_svg]:size-3.5"
          href={consoleAt()}
          // The view on screen as it is at the click: a tab or a row picked since the panel last drew.
          onClick={(event) => {
            event.currentTarget.href = consoleAt();
          }}
          onMouseDown={(event) => {
            event.currentTarget.href = consoleAt();
          }}
          target="_blank"
          rel="noreferrer"
        >
          Console
          <ExternalIcon />
        </a>
      </Hint>
      {explore}
      <ShareAction traceId={selectedId} source={source} compact={true} />
      <ThemeToggle compact={true} />
      <DockButton dock={dock} />
      <Hint title="Close" keys="Esc">
        <button type="button" className="icon-button" aria-label="Close" onClick={() => tellWidget("tracepanel:close")}>
          <CloseIcon />
        </button>
      </Hint>
    </>
  );
  const tabCount = `${tabRows.length} ${tabRows.length === 1 ? "request" : "requests"}`;
  // Docked at the bottom with a request open, the panel has no bar of its own: the logo over the list and the trace's
  // toolbar make one row across it (as in browser devtools).

  return (
    <div className="panel">
      <SearchPalette
        open={searching}
        onOpenChange={setSearching}
        source={source}
        items={NAV}
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
              rows={shown.rows}
              pageCount={requestCount(pageRows)}
              selectedId={selectedId}
              currentId={history?.current ?? null}
              opensOn={opensOn}
              onClear={() => setClearing(true)}
            />
          )}
          <div className="bar-actions">{panelActions()}</div>
        </header>
      )}
      {!split && (pageShown.length > 1 || pageShown.some((row) => row.open)) ? (
        <PageRequests
          rows={pageShown}
          selectedId={selectedId}
          chains={chains}
          opensOn={opensOn}
          follow={follow}
          onFollow={onFollow}
          onClear={() => setClearing(true)}
        />
      ) : null}
      <div className={split ? "panel-split" : "panel-main"} data-brand={toolbarInTrace ? "" : undefined} ref={splitRef}>
        {/* Over the list, level with the trace's tabs: one toolbar row across the dock, as in browser devtools. */}
        {toolbarInTrace ? (
          // A container (`brand`): as the list narrows, the wordmark goes first, then Follow new's name, then the user's.
          <div className="panel-brand @container/brand">
            <Logo className="shrink-0 gap-1.5 text-md @max-[26rem]/brand:[&>span]:hidden [&_svg]:size-5" />
            {switchUser}
            {/* No count here: the rows are right below; Clear's tooltip says how many. */}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <ListToggles
                follow={follow}
                onFollow={onFollow}
                onClear={() => setClearing(true)}
                clearLabel={`Clear ${tabCount}`}
              />
            </span>
          </div>
        ) : null}
        {split ? (
          <PageRequests
            scope="tab"
            head={!toolbarInTrace}
            rows={inOrder(split, shown.rows)}
            selectedId={selectedId}
            currentId={currentId}
            chains={chains}
            opensOn={opensOn}
            follow={follow}
            onFollow={onFollow}
            onClear={() => setClearing(true)}
          />
        ) : null}
        {split ? <SplitHandle container={splitRef} /> : null}
        <main className="panel-body">
          {selectedId ? (
            <TraceScreen
              // A link to another tab of the trace on screen opens that tab: a new screen, not a kept state. A new
              // request keeps the screen: the trace on it stays until the next one is loaded, with no blank between.
              // An app's row in the list opens the trace under that app: a new screen too.
              key={route.name === "trace" ? `${route.tab ?? ""}|${route.under ?? ""}` : ""}
              id={selectedId}
              source={source}
              arriving={arrivingIn(rows, stored, selectedId)}
              running={runningIn(rows, selectedId)}
              variant={split ? "strip" : "compact"}
              // A link to a tab (the pill's card opens a finding on Issues) wins over the last tab used.
              initialTab={route.name === "trace" ? tabOf(route.tab) : undefined}
              initialUnder={route.name === "trace" ? route.under : undefined}
              preferredTab={tab}
              onTabChange={(next) => {
                // Only the tabs worth opening every trace on are kept (not Profile or App): see lastTab.ts.
                writeLastTab(next);
                setTab(readLastTab());
              }}
              initialSlice={sliced.slice}
              onSliceChange={sliced.onChange}
              onTabShown={view.onTabShown}
              initialMemory={view.initialMemory}
              onMemoryChange={view.onMemoryChange}
              actions={split ? panelActions : undefined}
              lead={<BackTo view={back} rows={listed} bare={!split} />}
              links={PANEL_LINKS}
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
          <ScopeProvider source={source}>
            <Console route={route} source={source} />
          </ScopeProvider>
        )}
      </RefreshProvider>
    </TooltipProvider>
  );
}
