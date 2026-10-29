import {
  ArrowLeftIcon,
  type Chain,
  type ChainApp,
  type ChainEntry,
  ChevronDownIcon,
  ClearIcon,
  CloseIcon,
  chainApps,
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
  type Slice,
  sliceParams,
  type TabId,
  TaskName,
  TraceBadge,
  type TraceLinks,
  TraceList,
  type TraceRow,
  type TraceSummary,
  waitingUntil,
  withSnapshots,
} from "@tracepanel/ui";
import { TooltipProvider } from "@tracepanel/ui/components/ui/tooltip";
import { useCloseOnBlur } from "@tracepanel/ui/hooks/useCloseOnBlur";
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
import { ProfileToggle } from "./ProfileToggle";
import { RefreshProvider } from "./refresh";
import { consoleLinks, go, href, parse, type Route, useRoute } from "./routes";
import { SearchPalette } from "./SearchPalette";
import { ShareAction } from "./ShareDialog";
import { NAV, ThemeToggle } from "./Sidebar";
import { ScopeProvider } from "./scope";
import { graphqlOperation, requestPath } from "./sections";
import { tabOf } from "./TracePage";
import { ARRIVING_MS, TraceScreen } from "./TraceScreen";
import { SwitchUser } from "./UserSwitcher";

const base = location.href.split("#")[0] ?? location.href;
const api = new URL("api/", base);
const source: DataSource = withSnapshots(httpSource(api), api);
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
  for (const entry of history.entries) {
    const fallback = byId.has(entry.id) ? undefined : rowFromWidget(entry);
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

function isChildOf(history: TabHistory | null, row: TraceRow, pageId: string): boolean {
  return history?.entries.some((entry) => entry.id === row.trace.id && entry.parent === pageId) ?? false;
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
  const { traces, runs } = usePolling(load) ?? NO_TRACES;
  const stored = useMemo(() => new Set(traces.map((trace) => trace.id)), [traces]);
  return { rows: history ? arrange(history, traces) : [], stored, runs };
}

/**
 * Whether a trace of the tab's list is on its way to the agent: listed by the widget, not stored yet, and ended a
 * moment ago (a view still open counts from its start). Undefined for a trace the list doesn't have (a linked one).
 */
function arrivingIn(rows: readonly TraceRow[], stored: ReadonlySet<string>, id: string | null): boolean | undefined {
  const row = rows.find((item) => item.trace.id === id);
  if (!row) return undefined;
  if (stored.has(row.trace.id)) return false;
  const ended = (row.trace.start + row.trace.duration) / 1000;
  return Date.now() - ended < ARRIVING_MS;
}

function idsOf(history: TabHistory | null): string[] {
  return history?.entries.map((entry) => entry.id) ?? [];
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
  loading: ReadonlySet<string>;
}

/**
 * The apps each row's trace called, by its id (none for a view or an action: its requests are rows of their own).
 * Read from the trace's chain, as its call tree and tabs read it (`source.chain`): loaded once a row is stored, again
 * when the row changes, and every two seconds while it is new (a service's trace can arrive after its caller's). Its
 * calls whose traces are on their way are rows too, until they arrive or stop being waited for (lib/chainRows).
 */
function useRowChains(rows: readonly TraceRow[], stored: ReadonlySet<string>): RowChains {
  const [chains, setChains] = useState<ReadonlyMap<string, Chain>>(() => new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const has = useRef(chains);
  has.current = chains;
  const loaded = useRef(new Map<string, string>());
  const wanted = rows.filter((row) => row.trace.kind !== "page" && stored.has(row.trace.id)).map((row) => row.trace);
  const key = wanted.map(rowKey).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` says which rows and what they hold.
  useEffect(() => {
    const load = source.chain;
    if (!load) return;
    let live = true;
    const timers = new Set<number>();
    // The loads not answered yet: a load this effect ends before it answers is dropped, so it isn't loaded either.
    const asked = new Set<string>();
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
        const fresh = now - (trace.start + trace.duration) / 1000 < CHAIN_FRESH_MS;
        if (loaded.current.get(trace.id) === rowKey(trace) && !fresh) continue;
        loaded.current.set(trace.id, rowKey(trace));
        // Its first load: placeholders under the row once it is slow, so the list says something is on its way.
        const first = !has.current.has(trace.id);
        const timer = first
          ? window.setTimeout(() => live && setLoading((current) => new Set(current).add(trace.id)), CHAIN_SLOW_MS)
          : undefined;
        if (timer !== undefined) timers.add(timer);
        asked.add(trace.id);
        const settle = () => {
          asked.delete(trace.id);
          window.clearTimeout(timer);
          if (timer !== undefined) timers.delete(timer);
          done(trace.id);
        };
        load(trace.id).then((chain) => {
          if (live) keep(trace.id, chain);
          settle();
        }, settle);
      }
    };
    tick();
    const timer = window.setInterval(() => document.visibilityState === "visible" && tick(), CHAIN_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
      for (const each of timers) window.clearTimeout(each);
      // The rows changed while these loaded (another request came): their answers are dropped, the next effect asks again.
      for (const id of asked) loaded.current.delete(id);
    };
  }, [key]);
  // The waiting calls go once they stop being waited for: the rows are built again then (`expired` counts the times).
  const [expired, setExpired] = useState(0);
  const listed = rows.map((row) => row.trace.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `expired` moved on: the rows are built at the time now.
  const apps = useMemo(() => {
    const rowsIn = new Set(listed.split(","));
    const apps = new Map<string, ChainEntry[]>();
    for (const [id, chain] of chains) {
      if (!rowsIn.has(id)) continue;
      const under = chainApps(chain, id, rowsIn);
      if (under.length > 0) apps.set(id, under);
    }
    return apps;
  }, [chains, listed, expired]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `expired` moved on: the next waiting call's end is asked.
  useEffect(() => {
    const ends = [...chains.values()].map((chain) => waitingUntil(chain)).filter((end) => end !== null);
    if (ends.length === 0) return;
    const wait = Math.max(0, Math.min(...ends) - Date.now()) + 50;
    const timer = window.setTimeout(() => setExpired((count) => count + 1), wait);
    return () => window.clearTimeout(timer);
  }, [chains, expired]);
  return { apps, loading };
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

/** The tabs that list a chain under an app: the one the panel last used when it is one of them. */
const SCOPED_TABS = new Set<TabId>(["sql", "http", "issues", "logs", "profile"]);

/** The tab an app's row opens its trace on: the last one used if it lists a chain, else DB, else Logs. */
function underTab(app: ChainApp, last: TabId | undefined): TabId {
  if (last && SCOPED_TABS.has(last)) return last;
  return app.summary.queries > 0 ? "sql" : "logs";
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

/** The tab's requests, not the runs nested under them. */
function requestsOf(rows: readonly TraceRow[]): TraceRow[] {
  return rows.filter((row) => !row.run);
}

/**
 * What Follow new opens for the newest row: the row itself, or, for a request a view or an action in the browser
 * made, that view or action once it is stored. Its call tree has all of its requests, and its group's next ones
 * leave it open.
 */
function followTarget(rows: readonly TraceRow[], stored: ReadonlySet<string>): string | undefined {
  const latest = rows.at(-1);
  if (latest?.depth !== 1) return latest?.trace.id;
  return groupOrRequest(rows, stored, latest.trace.id);
}

/** The view or action heading the newest rows, when the agent has it; else the request itself. */
function groupOrRequest(rows: readonly TraceRow[], stored: ReadonlySet<string>, request: string): string {
  const head = [...rows].reverse().find((row) => row.depth === 0);
  return head?.trace.kind === "page" && stored.has(head.trace.id) ? head.trace.id : request;
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

/** As on the pill: a stack and the number of this tab's requests. */
function RequestCount({ count }: { count: number }) {
  return (
    <span className="switcher-count" title={`${count} ${count === 1 ? "request" : "requests"} in this tab`}>
      <LayersIcon />
      {count}
    </span>
  );
}

/** A trace as the panel names it in one line: a request by its method and path, a task or a job by its kind and name. */
function TraceName({ trace }: { trace: TraceSummary }) {
  if (trace.kind === "http" || trace.kind === "page") return <RequestName trace={trace} />;
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

/**
 * The way back to the trace a linked one (a task it enqueued) was opened from, named as the list names it, before
 * the trace's tabs. Esc goes there too. `bare` (docked right, the tabs need the room): the arrow alone, the switcher
 * beside the logo names the trace on screen.
 */
function BackTo({ route, rows, bare }: { route: TraceRoute | null; rows: readonly TraceRow[]; bare: boolean }) {
  return route ? <BackButton route={route} rows={rows} bare={bare} /> : null;
}

function BackButton({ route, rows, bare }: { route: TraceRoute; rows: readonly TraceRow[]; bare: boolean }) {
  const trace = useNamed(route.id, rows);
  return (
    <Hint title="Back" detail="To the trace this one was opened from." keys="Esc">
      <button
        type="button"
        className="panel-back"
        data-bare={bare || undefined}
        aria-label="Back"
        onClick={() => go(route)}
      >
        <ArrowLeftIcon />
        {trace && !bare ? <TraceName trace={trace} /> : null}
      </button>
    </Hint>
  );
}

type TraceRoute = Extract<Route, { name: "trace" }>;

/** The trace a linked one was opened from in the panel, when it was. */
function backOf(route: Route): TraceRoute | null {
  if (route.name !== "trace" || !route.from) return null;
  const from = parse(route.from);
  return from.name === "trace" ? from : null;
}

/**
 * Where a trace's parts lead from the panel: to the console in a new tab, but a linked trace (a task it enqueued)
 * opens here, with the way back to this one.
 */
const PANEL_LINKS: TraceLinks = {
  ...consoleLinks(base, true),
  openTrace: (id, tab) => go({ name: "trace", id, from: location.hash, tab }),
};

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
        <RequestCount count={requestsOf(rows).length} />
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
const PANEL_TABS = new Set<TabId>(["request", "tree", "issues", "sql", "cache", "http", "logs", "error"]);

/** The tab the panel opens: the last one picked, kept across requests and page loads. */
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
  chains,
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
}) {
  const fresh = useNewIds(rows.map((row) => row.trace.id));
  const list = useRef<HTMLElement>(null);
  const { unseen, jump } = useStickToBottom(list, rows.length, follow);
  // Requests only: the runs under them are rows too, and the browser's views and actions, with their requests.
  const ajax = requestsOf(rows).length - 1;
  const requests = requestsOf(rows).filter((row) => row.trace.kind !== "page").length;
  const count =
    scope === "tab"
      ? `· ${requests} ${requests === 1 ? "request" : "requests"}`
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
        services={manyApps(rows)}
        rows={rows}
        selectedId={selectedId}
        currentId={currentId}
        newIds={fresh}
        chains={chains}
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
function usePanelSlice(id: string | null) {
  const [sliced, setSliced] = useState<{ id: string | null; slice: Slice } | null>(null);
  const slice = sliced?.id === id ? sliced.slice : undefined;
  return {
    slice,
    params: slice ? sliceParams(slice) : {},
    onChange: (next: Slice) => setSliced({ id, slice: next }),
  };
}

function PanelApp({ route }: { route: Route }) {
  const history = useTabHistory();
  const { rows, stored, runs } = useTabRows(history);
  const listed = withRuns(rows, runs);
  const rowChains = useRowChains(listed, stored);
  const [chainOpen, toggleChain] = useChainOpen();
  const currentId = history?.current ?? null;
  const pageRows = currentId
    ? rows.filter((row) => row.trace.id === currentId || isChildOf(history, row, currentId))
    : [];
  const selectedId =
    route.name === "trace" ? route.id : (currentId ?? rows.find((row) => row.depth === 0)?.trace.id ?? null);
  // A linked trace opened from another one: the way back to it.
  const back = backOf(route);
  const backRef = useRef(back);
  backRef.current = back;

  const dock = useDock();
  const splitRef = useRef<HTMLDivElement>(null);
  const split = useSplit(dock);
  const [follow, setFollow] = useState(readFollow);
  const [tab, setTab] = useState(readTab);
  const sliced = usePanelSlice(selectedId);
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
    apps: rowChains.apps,
    loading: rowChains.loading,
    open: chainOpen,
    onToggle: toggleChain,
    onApp: (id, app) => go({ name: "trace", id, under: app.app, tab: underTab(app, tab) }),
  };
  const tabRows = inOrder(split, rows);
  const followRows = split ? tabRows : pageRows;
  const latestChild = followRows.length > 1 ? followTarget(followRows, stored) : undefined;
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
  // trace goes back to the one it was opened from.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (backRef.current) go(backRef.current);
      else tellWidget("tracepanel:close");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectedKind = listed.find((row) => row.trace.id === selectedId)?.trace.kind;
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
          href={`${base}${consoleHref(selectedId, { tab, from: sectionFor(selectedKind), ...sliced.params })}`}
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
  const requestCount = `${tabRows.length} ${tabRows.length === 1 ? "request" : "requests"}`;
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
              rows={listed}
              selectedId={selectedId}
              currentId={history?.current ?? null}
              onClear={() => setClearing(true)}
            />
          )}
          <div className="bar-actions">{panelActions()}</div>
        </header>
      )}
      {!split && pageRows.length > 1 ? (
        <PageRequests
          rows={withRuns(pageRows, runs)}
          selectedId={selectedId}
          chains={chains}
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
                clearLabel={`Clear ${requestCount}`}
              />
            </span>
          </div>
        ) : null}
        {split ? (
          <PageRequests
            scope="tab"
            head={!toolbarInTrace}
            rows={inOrder(split, listed)}
            selectedId={selectedId}
            currentId={currentId}
            chains={chains}
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
              variant={split ? "strip" : "compact"}
              // A link to a tab (the pill's card opens a finding on Issues) wins over the last tab used.
              initialTab={route.name === "trace" ? tabOf(route.tab) : undefined}
              initialUnder={route.name === "trace" ? route.under : undefined}
              preferredTab={tab}
              onTabChange={(next) => {
                setTab(next);
                writeTab(next);
              }}
              initialSlice={sliced.slice}
              onSliceChange={sliced.onChange}
              actions={split ? panelActions : undefined}
              lead={<BackTo route={back} rows={listed} bare={!split} />}
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
