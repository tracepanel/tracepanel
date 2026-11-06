import {
  CloseIcon,
  Empty,
  ExternalIcon,
  FILTERS,
  Hint,
  isGone,
  type ListChains,
  LogoMark,
  memoryFromParams,
  parseSlice,
  RecordMarks,
  RecordRow,
  RowFilter,
  RowKinds,
  recordPending,
  type Slice,
  sliceParams,
  type TabId,
  TraceList,
  type TraceRow,
  type ViewMemory,
  withChain,
} from "@tracepanel/ui";
import { TooltipProvider } from "@tracepanel/ui/components/ui/tooltip";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ClearDialog } from "./ClearDialog";
import { Console } from "./Console";
import { exploreFor } from "./explore";
import { useTabHistory } from "./hooks";
import { forgetUnless, restoringFor, setCurrentView, useBackStep } from "./panelBack";
import { useChainOpen, useKnownApps, useRowChains, useTabRows } from "./panelChains";
import { type Dock, tellWidget, useDock, useSplit } from "./panelLayout";
import {
  BackTo,
  DockButton,
  KindsMenu,
  ListTools,
  offeredKinds,
  PANEL_LINKS,
  PanelProfile,
  readFollow,
  sectionFor,
  showsKinds,
  useShownKinds,
  writeFollow,
} from "./panelList";
import { arrivingIn, followTarget, inOrder, pageScope, runningIn, withRuns } from "./panelRows";
import { base, source } from "./panelSource";
import {
  DetailsSplitter,
  DetailsToggle,
  MAP,
  MAP_WIDE,
  MapSplitter,
  PanelFilter,
  useDetailsShown,
  useDetailsSplit,
  useMapWidth,
} from "./panelSplit";
import { RefreshProvider } from "./refresh";
import { go, href, type Route, useRoute } from "./routes";
import { ShareAction } from "./ShareDialog";
import { ThemeToggle } from "./Sidebar";
import { ScopeProvider } from "./scope";
import { tabOf } from "./TracePage";
import { TraceLoading, TraceScreen } from "./TraceScreen";
import { SwitchUser } from "./UserSwitcher";
import { settledIn, withLoads, withoutFlying, withViewCalls } from "./viewCalls";

const embedded = window.parent !== window;

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
    const drawn = pane?.querySelector(`.tp-trace[data-trace="${id}"]`);
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

/**
 * Follow new: opens each request that arrives. The history the panel opens with is what was already there, not a new
 * request: the request a link asked for (the pill's card) stays on screen. Only requests that arrive after it are
 * followed.
 */
function useFollowNew(follow: boolean, latest: string | undefined, loaded: boolean): void {
  const followed = useRef(latest);
  const seeded = useRef(loaded);
  useEffect(() => {
    if (!seeded.current) {
      if (!loaded) return;
      seeded.current = true;
      followed.current = latest;
      return;
    }
    if (follow && latest && latest !== followed.current) go({ name: "trace", id: latest });
    followed.current = latest;
  }, [follow, latest, loaded]);
}

/**
 * Esc anywhere in the panel closes it, as on the page; a menu or list open in it takes the Esc first, and a linked
 * trace goes back to the view it was opened from, as the Back button does.
 */
function useEscapeCloses(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      tellWidget("tracepanel:close");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * One row of quiet icons: what is done to this trace or this panel; who you are sits with the list. Explore, when the
 * trace's toolbar holds the row, is the first of the icons after Console.
 */
function PanelActions({
  user,
  consoleAt,
  explore,
  traceId,
  dock,
}: {
  user: ReactNode;
  consoleAt: () => string;
  explore: ReactNode;
  traceId: string | null;
  dock: Dock;
}) {
  return (
    <>
      {user}
      <Hint title="Open in the console" detail="Opens this request in the console, in a new tab.">
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
          <span className="panel-console-label">Console</span>
          <ExternalIcon />
        </a>
      </Hint>
      {explore}
      <ShareAction traceId={traceId} source={source} compact={true} />
      <ThemeToggle compact={true} />
      <DockButton dock={dock} />
      <Hint title="Close" keys="Esc">
        <button type="button" className="icon-button" aria-label="Close" onClick={() => tellWidget("tracepanel:close")}>
          <CloseIcon />
        </button>
      </Hint>
    </>
  );
}

/** What a record still open has called so far, its rows right after it: they show before it ends. */
function callsUnder(rows: readonly TraceRow[], record: TraceRow): readonly TraceRow[] {
  const ordered = inOrder(true, rows);
  const at = ordered.findIndex((row) => row.trace.id === record.trace.id);
  if (at < 0) return [];
  const level = record.depth ?? 0;
  const next = ordered.findIndex((row, index) => index > at && (row.depth ?? 0) <= level);
  return ordered.slice(at + 1, next < 0 ? undefined : next);
}

/**
 * Whether a record's calls have traces still on their way: its numbers now would be a part of what they will be,
 * so it says none yet. A call its view's chain waits for, or one whose answer named a trace not stored yet; never a
 * call no trace answers ("~…", the id it flew under), nor one that got no answer.
 */
function callsArriving(rows: readonly TraceRow[], record: TraceRow, stored: ReadonlySet<string>): boolean {
  return callsUnder(rows, record).some(
    (call) =>
      // The page's own load is a record's row, not one of its calls: its numbers are its own.
      call.loadHost === undefined &&
      (call.call === "waiting" ||
        (call.call === undefined &&
          call.failed === undefined &&
          !call.trace.id.startsWith("~") &&
          !stored.has(call.trace.id) &&
          arrivingIn(rows, stored, call.trace.id) === true)),
  );
}

/** The records a filter finds by their names; the one open stays, its rows are filtered in place. */
function filteredRecords(rows: readonly TraceRow[], filter: string, selectedId: string | null): readonly TraceRow[] {
  const wanted = filter.trim().toLowerCase();
  if (!wanted) return rows;
  return rows.filter((row) => row.trace.id === selectedId || row.trace.name.toLowerCase().includes(wanted));
}

/** The tab's records, the caller puts the newest first: a view's calls are in its tree, so only the one a link opened stays a row of its own. */
function recordsOf(rows: readonly TraceRow[], selectedId: string | null): TraceRow[] {
  let view = -1;
  return rows.filter((row) => {
    const depth = row.depth ?? 0;
    if (view >= 0 && depth > view) return row.trace.id === selectedId;
    view = row.trace.kind === "page" ? depth : -1;
    return true;
  });
}

/** The panel: the tab's records over their bars, the open one as its call tree, the picked row's details beside. */
/** The tab's rows as the panel lists them: every row, the records, which are stored, their chains' numbers. */
interface PanelTab {
  rows: readonly TraceRow[];
  listRows: readonly TraceRow[];
  stored: ReadonlySet<string>;
  chains: ListChains;
  /** Shows older rows of the tab's history, where there are more. */
  onMore: (() => void) | undefined;
}

/** Where the panel is and what it shows: its route, the trace picked, its dock, and what it remembers of the view. */
interface PanelPlace {
  route: Route;
  selectedId: string | null;
  dock: Dock;
  empty: boolean;
  sliced: ReturnType<typeof usePanelSlice>;
  view: ReturnType<typeof usePanelView>;
}

/** The bar's parts from the panel's app: Follow and Clear, the way back, the actions with Explore's slot. */
interface PanelBar {
  /** Follow and Clear, right after the filter: they act on the list it filters. */
  listTools: ReactNode;
  toolbar: ReactNode;
  actions: (explore: ReactNode) => ReactNode;
}

function PanelWaterfall({
  tab,
  place,
  bar,
  clear,
}: {
  tab: PanelTab;
  place: PanelPlace;
  bar: PanelBar;
  clear: { open: boolean; onOpenChange: (open: boolean) => void };
}) {
  const { rows, stored, chains, onMore } = tab;
  const { route, dock, empty, sliced, view } = place;
  const { list, anchor, hosts, setHosts, layout, filter, setFilter, kinds, setKinds, open, shown } = usePanelState(
    tab,
    place,
  );
  return (
    <div className="panel" data-v2="" style={layout.style}>
      <PanelTop
        dock={dock}
        layout={layout}
        filter={<PanelFilter value={filter} onChange={setFilter} />}
        kinds={<KindsMenu kinds={kinds} offered={shown.offered} onKinds={setKinds} />}
        listTools={bar.listTools}
        toolbar={open.focusTrace ? null : bar.toolbar}
        actions={bar.actions(<span ref={setHosts.actions} className="panel-explore-slot" />)}
      />
      <div className="panel-wf" data-dock={dock} data-no-details={layout.noDetails}>
        <div className="panel-wf-tree">
          {empty ? null : <MapSplitter {...layout.map.handle} />}
          <section
            className="panel-wf-rows"
            aria-label="Pages and requests in this browser tab"
            ref={list}
            // Closed details open again with a row picked (not with a fold opened or closed).
            onClickCapture={(event) => layout.onRowClick(event.target as Element)}
            onKeyDown={onRowsKey}
          >
            {empty ? (
              <Empty title="No requests yet">Requests from this browser tab will appear here.</Empty>
            ) : (
              <RowFilter.Provider value={filter}>
                <RowKinds.Provider value={kinds}>
                  <TraceList
                    compact={true}
                    rows={shown.records}
                    onMore={shown.letGo ? undefined : onMore}
                    selectedId={open.rootId}
                    chains={chains}
                    onSelect={(id) => {
                      anchor(id);
                      go({ name: "trace", id });
                    }}
                    openContent={
                      <OpenRecord
                        route={route}
                        open={open}
                        shown={shown}
                        rows={rows}
                        stored={stored}
                        chains={chains}
                        hosts={hosts}
                        sliced={sliced}
                        view={view}
                      />
                    }
                  />
                  <ListNotes
                    letGo={shown.letGo}
                    narrowedTo={shown.nothingElse ? filter.trim() : null}
                    onShowAll={() => {
                      setFilter("");
                      setKinds([]);
                    }}
                  />
                </RowKinds.Provider>
              </RowFilter.Provider>
            )}
          </section>
        </div>
        <DetailsSplitter {...layout.details.handle} />
        <aside ref={setHosts.details} className="panel-wf-details" aria-label="Details" />
      </div>
      <ClearDialog
        mode="panel"
        open={clear.open}
        onOpenChange={clear.onOpenChange}
        source={source}
        onCleared={(permanent) => {
          tellWidget("tracepanel:clear", { all: permanent });
          go({ name: "home" });
        }}
      />
    </div>
  );
}

/**
 * The panel's state: its list and where a click anchors it, its hosts, its split, its filter and kinds, the record
 * open and the records shown.
 */
function usePanelState(tab: PanelTab, place: PanelPlace) {
  const [hosts, setHosts] = useHosts();
  const list = useRef<HTMLElement>(null);
  const anchor = useClickAnchor(list, place.selectedId);
  const layout = usePanelLayout(place.dock, place.empty);
  const [filter, setFilter] = useState("");
  const [kinds, setKinds] = useShownKinds();
  const open = useOpenRecord(tab.listRows, place.selectedId);
  const shown = useShownRecords({ ...tab, rootId: open.rootId, filter, kinds });
  return { list, anchor, hosts, setHosts, layout, filter, setFilter, kinds, setKinds, open, shown };
}

/** Where the keys move among the list's rows: the next or previous one, the first or the last. */
const ROW_STEPS = new Map<string, (at: number, count: number) => number>([
  ["ArrowDown", (at, count) => Math.min(at + 1, count - 1)],
  ["ArrowUp", (at) => Math.max(at - 1, 0)],
  ["Home", () => 0],
  ["End", (_at, count) => count - 1],
]);

/**
 * The keys over the list, as a tree in devtools: up and down to the next row, Home and End to the ends. A row of the
 * open record's tree is picked as it is reached, its details beside it; a closed record only takes the focus, Enter
 * opens it (no record opens on its own as the keys pass it).
 */
function onRowsKey(event: ReactKeyboardEvent<HTMLElement>): void {
  const step = ROW_STEPS.get(event.key);
  const from = (event.target as Element).closest(".tp-map-row");
  if (!step || !from || event.altKey || event.metaKey || event.ctrlKey) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(".tp-map-row")];
  const to = rows[step(rows.indexOf(from as HTMLElement), rows.length)];
  if (!to || to === from) return;
  event.preventDefault();
  to.focus();
  to.scrollIntoView({ block: "nearest" });
  if (!to.classList.contains("tp-record")) to.click();
}

/** Where the open record's details and its Explore go: the panel's details pane, and a slot among its buttons. */
function useHosts(): [
  { details: HTMLElement | null; actions: HTMLElement | null },
  { details: (host: HTMLElement | null) => void; actions: (host: HTMLElement | null) => void },
] {
  const [details, setDetails] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  return [
    { details, actions },
    { details: setDetails, actions: setActions },
  ];
}

/**
 * The record opened stays under the click: the one closed above it would move it up, the list scrolls it back.
 * Opened another way (Follow, a link), the list scrolls only to bring it into view. Returns what a click calls first.
 */
function useClickAnchor(list: RefObject<HTMLElement | null>, selectedId: string | null): (id: string) => void {
  const clicked = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the record opened, not each thing it draws.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const row = list.current?.querySelector(".tp-requests-open .tp-map-row");
      const before = clicked.current;
      clicked.current = null;
      if (row && before !== null && list.current) list.current.scrollTop += row.getBoundingClientRect().top - before;
      else row?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId]);
  return (id) => {
    const row = list.current?.querySelector(`[data-record="${CSS.escape(id)}"]`);
    clicked.current = row ? row.getBoundingClientRect().top : null;
  };
}

/**
 * The panel's split: the details shown or folded away (docked right they are under the rows, never folded), the
 * details' and the bars' widths (the bars wider with the details hidden: the rows have the panel).
 */
function usePanelLayout(dock: Dock, empty: boolean) {
  const details = useDetailsSplit(dock);
  const [detailsShown, showDetails] = useDetailsShown();
  const narrowMap = useMapWidth(MAP);
  const wideMap = useMapWidth(MAP_WIDE);
  const map = detailsShown || dock === "right" ? narrowMap : wideMap;
  const folded = !detailsShown && dock !== "right";
  return {
    details,
    map,
    detailsShown,
    showDetails,
    style: { ...details.style, ...map.style },
    noDetails: empty || folded ? "" : undefined,
    // Docked right, the details are under the rows: nothing to fold away.
    toggle: empty || dock === "right" ? null : <DetailsToggle shown={detailsShown} onShown={showDetails} />,
    onRowClick: (target: Element) => {
      if (!detailsShown && target.closest(".tp-map-row") && !target.closest("[data-toggle]")) showDetails(true);
    },
  };
}

/**
 * The record open, and the trace picked in its tree: the waterfall stays put, so a link to a trace in the open
 * record's chain picks its row there; only a trace outside the chain opens on its own.
 */
function useOpenRecord(listRows: readonly TraceRow[], selectedId: string | null) {
  const shownRecord = useRef<string | null>(null);
  const [outside, setOutside] = useState<string | null>(null);
  const isRecord = listRows.some((row) => row.trace.id === selectedId);
  if (isRecord) shownRecord.current = selectedId;
  const rootId = isRecord || outside === selectedId ? selectedId : (shownRecord.current ?? selectedId);
  const focusTrace = rootId !== selectedId ? (selectedId ?? undefined) : undefined;
  return { rootId, focusTrace, setOutside };
}

/**
 * The records the list shows: those the store keeps (the ones it let go say so in one line, nothing older asked
 * for), the filter's and the kinds' (an agent that doesn't say what ran, an older one, keeps every record and offers
 * every kind); the open one always, and how the list says it holds nothing else.
 */
function useShownRecords({
  listRows,
  rows,
  chains,
  rootId,
  filter,
  kinds,
}: {
  listRows: readonly TraceRow[];
  rows: readonly TraceRow[];
  chains: ListChains;
  rootId: string | null;
  filter: string;
  kinds: readonly string[];
}) {
  const ranKinds = [...(chains.counts?.values() ?? [])].map((each) => each.span_kinds);
  const knowsKinds = ranKinds.some((each) => each !== undefined);
  const kept = listRows.filter((row) => row.trace.id === rootId || !isGone(row, chains.counts));
  const records = filteredRecords(kept, filter, rootId).filter(
    (row) => !knowsKinds || showsKinds(chains.counts?.get(row.trace.id)?.span_kinds, kinds),
  );
  const opened = rows.find((row) => row.trace.id === rootId);
  const narrowed = filter.trim() !== "" || kinds.length > 0;
  return {
    records,
    letGo: kept.length < listRows.length,
    offered: knowsKinds ? offeredKinds(ranKinds, kinds) : FILTERS,
    opened,
    // As the list has it: whether its calls' numbers are still on their way.
    record: listRows.find((row) => row.trace.id === rootId) ?? opened,
    // Narrowed to nothing but the open record: said so, with the way back, not a list that silently shrank.
    nothingElse: narrowed && records.every((row) => row.trace.id === rootId),
  };
}

/** The panel's bar: its logo, the filter and the kinds shown, the list's tools, its own controls, the actions. */
function PanelTop({
  dock,
  layout,
  filter,
  kinds,
  listTools,
  toolbar,
  actions,
}: {
  dock: Dock;
  layout: ReturnType<typeof usePanelLayout>;
  filter: ReactNode;
  kinds: ReactNode;
  listTools: ReactNode;
  toolbar: ReactNode;
  actions: ReactNode;
}) {
  return (
    <header className="panel-top" data-dock={dock} data-no-details={layout.noDetails}>
      {/* Its own item: a narrow bar puts it on the actions' line, the filter's under it. */}
      <span className="panel-top-logo">
        <LogoMark className="size-5" />
      </span>
      <div className="panel-top-rows">
        {filter}
        {kinds}
        {listTools}
        {/* At the rows' end, by the details' line: what the panel records, and the details shown or not. */}
        <div className="panel-top-controls">
          {toolbar}
          <PanelProfile />
          {layout.toggle}
        </div>
      </div>
      <div className="bar-actions">{actions}</div>
    </header>
  );
}

/** The open record, in its place in the list: its trace's waterfall, its own row and calls until that loads. */
function OpenRecord({
  route,
  open,
  shown,
  rows,
  stored,
  chains,
  hosts,
  sliced,
  view,
}: {
  route: Route;
  open: ReturnType<typeof useOpenRecord>;
  shown: ReturnType<typeof useShownRecords>;
  rows: readonly TraceRow[];
  stored: ReadonlySet<string>;
  chains: ListChains;
  hosts: { details: HTMLElement | null; actions: HTMLElement | null };
  sliced: ReturnType<typeof usePanelSlice>;
  view: ReturnType<typeof usePanelView>;
}) {
  const { rootId } = open;
  if (!rootId) return null;
  const trace = route.name === "trace" ? route : null;
  return (
    <TraceScreen
      key={trace ? `${trace.tab ?? ""}|${trace.under ?? ""}` : ""}
      id={rootId}
      source={source}
      arriving={arrivingIn(rows, stored, rootId)}
      running={runningIn(rows, rootId)}
      variant="waterfall"
      waiting={shown.opened ? <Waiting opened={shown.opened} rows={rows} host={hosts.details} /> : undefined}
      beside={{
        focusTrace: open.focusTrace,
        onOutsideChain: open.setOutside,
        detailsHost: hosts.details,
        actionsHost: hosts.actions,
        recordTime: shown.opened?.trace.duration,
        recordMarks: recordMarksOf(shown.record, chains),
      }}
      initialTab={trace ? tabOf(trace.tab) : undefined}
      initialUnder={trace?.under}
      initialSlice={sliced.slice}
      onSliceChange={sliced.onChange}
      onTabShown={view.onTabShown}
      initialMemory={view.initialMemory}
      onMemoryChange={view.onMemoryChange}
      links={PANEL_LINKS}
      explore={(loaded) => exploreFor(loaded, (to) => `${base}${href(to)}`)}
    />
  );
}

/** The open record's marks as its closed row says them, from what the list counted of its chain. */
function recordMarksOf(record: TraceRow | undefined, chains: ListChains): ReactNode {
  if (!record) return undefined;
  return (
    <RecordMarks trace={withChain(record.trace, chains.counts?.get(record.trace.id))} pending={recordPending(record)} />
  );
}

/** Before its trace loads: the record's own row and its calls', its details loading beside them. */
function Waiting({ opened, rows, host }: { opened: TraceRow; rows: readonly TraceRow[]; host: HTMLElement | null }) {
  return (
    <>
      <RecordRow
        row={opened}
        fresh={false}
        onSelect={() => undefined}
        live={Boolean(opened.open)}
        current={true}
        pending={true}
      />
      {callsUnder(rows, opened).map((call) => (
        <RecordRow
          key={call.key ?? call.trace.id}
          row={call}
          fresh={false}
          depth={1}
          live={Boolean(call.open)}
          pending={true}
          onSelect={(id) => go({ name: "trace", id })}
        />
      ))}
      {host ? createPortal(<TraceLoading variant="waterfall" />, host) : null}
    </>
  );
}

/** Under the list: that older records left the store, and that the filter or the kinds left nothing else. */
function ListNotes({
  letGo,
  narrowedTo,
  onShowAll,
}: {
  letGo: boolean;
  /** Narrowed to nothing but the open record: the filter's words, or "" for the kinds alone. */
  narrowedTo: string | null;
  onShowAll: () => void;
}) {
  return (
    <>
      {letGo ? <p className="panel-let-go">Older requests left the local store: it keeps the newest traces.</p> : null}
      {narrowedTo === null ? null : (
        <p className="panel-no-match">
          {narrowedTo ? `No other requests match “${narrowedTo}”.` : "No other requests have these kinds."}
          <button type="button" className="tp-link-button" onClick={onShowAll}>
            Show all
          </button>
        </p>
      )}
    </>
  );
}

const NO_ROWS: readonly TraceRow[] = [];

/** How many of the tab's rows the list shows at first, and adds as it is scrolled to its end. */
const LIST_PAGE = 50;

function PanelApp({ route }: { route: Route }) {
  const history = useTabHistory();
  // The latest rows first, older ones as the list is scrolled to its end: the list asks for, and counts, only those.
  const [roots, setRoots] = useState(LIST_PAGE);
  const { rows, stored, runs, counts, more } = useTabRows(history, roots);
  const listed = withRuns(rows, runs);
  // The list says what each chain adds up to: the waterfall needs no chain loaded per row for its numbers.
  const rowChains = useRowChains(counts ? NO_ROWS : listed, stored);
  // Each view's calls from its chain in the rows they were in flight (withViewCalls): the list shows these.
  const settled = settledIn(rowChains.settled, rows, stored);
  const known = withLoads(useKnownApps(listed), listed, history?.runtime ?? undefined);
  const shown = withViewCalls(listed, rowChains, withoutFlying(rowChains.apps, history), { settled, known });
  const [chainOpen, toggleChain] = useChainOpen();
  const currentId = history?.current ?? null;
  const pageRows = pageScope(history, rows);
  const selectedId =
    route.name === "trace" ? route.id : (currentId ?? rows.find((row) => row.depth === 0)?.trace.id ?? null);
  // A linked trace opened from another view: the way back to it, as it was.
  const back = useBackStep(selectedId);

  const dock = useDock();
  const split = useSplit(dock);
  const [follow, setFollow] = useState(readFollow);
  const sliced = usePanelSlice(selectedId, route);
  const view = usePanelView(route, selectedId, sliced.params);
  const [clearing, setClearing] = useState(false);
  const onFollow = (value: boolean) => {
    setFollow(value);
    writeFollow(value);
  };
  const chains: ListChains = {
    apps: shown.apps,
    loading: rowChains.loading,
    counts: counts ?? rowChains.counts,
    settled,
    cut: rowChains.cut,
    open: chainOpen,
    onToggle: toggleChain,
    // An app's row is that app's part of the chain: the call tree, at the row where its part starts (NAVIGATION.md).
    onApp: (id, app) => go({ name: "trace", id, under: app, tab: "tree" }),
  };
  const tabRows = inOrder(split, rows);
  const followRows = split ? tabRows : pageRows;
  const latestChild = followTarget(followRows);
  useFollowNew(follow, latestChild, history !== null);
  useEscapeCloses();

  const selectedKind = listed.find((row) => row.trace.id === selectedId)?.trace.kind;
  const consoleAt = () =>
    `${base}${consoleHref(selectedId, { ...view.address(), from: sectionFor(selectedKind), ...sliced.params })}`;
  const switchUser = <SwitchUser source={source} onSwitched={() => tellWidget("tracepanel:reload")} />;

  // What Clear empties, as the list counts it: the tab's records (a page and what it called are one), all of them.
  const records = history?.entries.filter((entry) => entry.parent === null).length ?? 0;
  const tabCount = `${records} ${records === 1 ? "request" : "requests"}`;
  return (
    <PanelWaterfall
      tab={{
        rows,
        listRows: recordsOf(inOrder(true, shown.rows), selectedId)
          .reverse()
          .map((row) => {
            const arriving = arrivingIn(rows, stored, row.trace.id) === true;
            const awaiting = !row.awaiting && callsArriving(rows, row, stored);
            return arriving || awaiting ? { ...row, arriving, awaiting: row.awaiting || awaiting } : row;
          }),
        stored,
        chains,
        onMore: more ? () => setRoots((shown) => shown + LIST_PAGE) : undefined,
      }}
      place={{ route, selectedId, dock, empty: history !== null && tabRows.length === 0, sliced, view }}
      bar={{
        listTools: (
          <ListTools
            follow={follow}
            onFollow={onFollow}
            onClear={() => setClearing(true)}
            clearLabel={`Clear ${tabCount}`}
          />
        ),
        toolbar: <BackTo view={back} rows={listed} bare={false} />,
        actions: (explore) => (
          <PanelActions user={switchUser} consoleAt={consoleAt} explore={explore} traceId={selectedId} dock={dock} />
        ),
      }}
      clear={{ open: clearing, onOpenChange: setClearing }}
    />
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
