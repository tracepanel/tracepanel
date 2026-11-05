import {
  CloseIcon,
  Empty,
  ExternalIcon,
  Hint,
  type ListChains,
  Logo,
  LogoMark,
  memoryFromParams,
  parseSlice,
  RecordRow,
  RowFilter,
  type Slice,
  sliceParams,
  type TabId,
  TraceList,
  type TraceRow,
  type ViewMemory,
} from "@tracepanel/ui";
import { TooltipProvider } from "@tracepanel/ui/components/ui/tooltip";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClearDialog } from "./ClearDialog";
import { Console } from "./Console";
import { exploreFor } from "./explore";
import { useTabHistory } from "./hooks";
import { readLastTab, writeLastTab } from "./lastTab";
import { forgetUnless, goBackInPanel, restoringFor, setCurrentView, useBackStep } from "./panelBack";
import { useChainOpen, useKnownApps, useRowChains, useTabRows } from "./panelChains";
import { type Dock, SplitHandle, tellWidget, useDock, useSplit } from "./panelLayout";
import {
  BackTo,
  currentTrace,
  DockButton,
  ListToggles,
  opensOnTab,
  PANEL_LINKS,
  PANEL_V2,
  PageRequests,
  RequestSwitcher,
  readFollow,
  sectionFor,
  writeFollow,
} from "./panelList";
import { arrivingIn, followTarget, inOrder, manyApps, pageScope, requestCount, runningIn, withRuns } from "./panelRows";
import { base, source } from "./panelSource";
import { DetailsSplitter, MapSplitter, PanelFilter, useDetailsSplit, useMapWidth } from "./panelSplit";
import { RefreshProvider } from "./refresh";
import { go, href, type Route, useRoute } from "./routes";
import { SearchPalette } from "./SearchPalette";
import { ShareAction } from "./ShareDialog";
import { NAV, ThemeToggle } from "./Sidebar";
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

/** ⌘K, as in the console: a trace opens here, anything else in the console, in a new tab. */
function useSearchKey(setSearching: (change: (open: boolean) => boolean) => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setSearching((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearching]);
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
      if (PANEL_V2 || !goBackInPanel(currentTrace())) tellWidget("tracepanel:close");
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

/** The panel as one waterfall: the tab's records as rows, the one selected open to its call tree, details beside them. */
function PanelWaterfall({
  route,
  selectedId,
  rows,
  listRows,
  stored,
  chains,
  opensOn,
  currentId,
  toolbar,
  actions,
  dock,
  empty,
  sliced,
  view,
  clearing,
  setClearing,
}: {
  route: Route;
  selectedId: string | null;
  rows: readonly TraceRow[];
  listRows: readonly TraceRow[];
  stored: ReadonlySet<string>;
  chains: ListChains;
  opensOn: ReturnType<typeof opensOnTab>;
  currentId: string | null;
  toolbar: ReactNode;
  actions: (explore: ReactNode) => ReactNode;
  dock: Dock;
  empty: boolean;
  sliced: ReturnType<typeof usePanelSlice>;
  view: ReturnType<typeof usePanelView>;
  clearing: boolean;
  setClearing: (open: boolean) => void;
}) {
  const [detailsHost, setDetailsHost] = useState<HTMLElement | null>(null);
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // The record opened, at the top of the rows: closing the one above it would move it away from the click.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the record opened, not each thing it draws.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      list.current?.querySelector(".dt-requests-open")?.parentElement?.scrollIntoView({ block: "start" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [selectedId]);
  const trace = route.name === "trace" ? route : null;
  const details = useDetailsSplit(dock);
  const map = useMapWidth();
  const [filter, setFilter] = useState("");
  // The waterfall stays put: a link to a trace in the open record's chain picks its row there. Only a trace outside
  // the chain opens on its own.
  const shownRecord = useRef<string | null>(null);
  const [outside, setOutside] = useState<string | null>(null);
  const isRecord = listRows.some((row) => row.trace.id === selectedId);
  if (isRecord) shownRecord.current = selectedId;
  const rootId = isRecord || outside === selectedId ? selectedId : (shownRecord.current ?? selectedId);
  const focusTrace = rootId !== selectedId ? (selectedId ?? undefined) : undefined;
  const records = filteredRecords(listRows, filter, rootId);
  const opened = rows.find((row) => row.trace.id === rootId);
  return (
    <div className="panel" data-v2="" style={{ ...details.style, ...map.style }}>
      <header className="panel-top" data-dock={dock} data-focus={focusTrace ? "" : undefined}>
        <div className="panel-top-rows">
          <LogoMark className="size-5" />
          <PanelFilter value={filter} onChange={setFilter} />
          <div className="panel-top-controls">{toolbar}</div>
        </div>
        <div className="bar-actions">{actions(<span ref={setActionsHost} className="contents" />)}</div>
      </header>
      <div className="panel-wf" data-dock={dock} data-no-details={empty ? "" : undefined}>
        <div className="panel-wf-tree">
          {empty ? null : <MapSplitter {...map.handle} />}
          <div className="panel-wf-rows" ref={list}>
            {empty ? (
              <Empty title="No requests yet">Requests from this browser tab will appear here.</Empty>
            ) : (
              <RowFilter.Provider value={filter}>
                <TraceList
                  compact={true}
                  services={manyApps(rows)}
                  rows={records}
                  selectedId={rootId}
                  currentId={currentId}
                  chains={chains}
                  opensOn={opensOn}
                  onSelect={(id) => go({ name: "trace", id })}
                  openContent={
                    rootId ? (
                      <TraceScreen
                        key={trace ? `${trace.tab ?? ""}|${trace.under ?? ""}` : ""}
                        id={rootId}
                        focusTrace={focusTrace}
                        onOutsideChain={setOutside}
                        source={source}
                        arriving={arrivingIn(rows, stored, rootId)}
                        running={runningIn(rows, rootId)}
                        variant="waterfall"
                        waiting={
                          opened ? (
                            <>
                              <RecordRow row={opened} fresh={false} onSelect={() => undefined} live={true} />
                              {callsUnder(rows, opened).map((call) => (
                                <RecordRow
                                  key={call.key ?? call.trace.id}
                                  row={call}
                                  fresh={false}
                                  depth={1}
                                  live={Boolean(call.open)}
                                  onSelect={(id) => go({ name: "trace", id })}
                                />
                              ))}
                              {detailsHost ? createPortal(<TraceLoading variant="waterfall" />, detailsHost) : null}
                            </>
                          ) : undefined
                        }
                        detailsHost={detailsHost}
                        actionsHost={actionsHost}
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
                    ) : null
                  }
                />
              </RowFilter.Provider>
            )}
          </div>
        </div>
        <DetailsSplitter {...details.handle} />
        <aside ref={setDetailsHost} className="panel-wf-details" aria-label="Details" />
      </div>
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
  );
}

const NO_ROWS: readonly TraceRow[] = [];

function PanelApp({ route }: { route: Route }) {
  const history = useTabHistory();
  const { rows, stored, runs, counts } = useTabRows(history);
  const listed = withRuns(rows, runs);
  // The list says what each chain adds up to: the waterfall needs no chain loaded per row for its numbers.
  const rowChains = useRowChains(PANEL_V2 && counts ? NO_ROWS : listed, stored);
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
  useSearchKey(setSearching);
  const onFollow = (value: boolean) => {
    setFollow(value);
    writeFollow(value);
  };
  const chains: ListChains = {
    apps: shown.apps,
    loading: rowChains.loading,
    counts: (PANEL_V2 ? counts : undefined) ?? rowChains.counts,
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
  useFollowNew(follow, latestChild, history !== null);
  useEscapeCloses();

  const selectedKind = listed.find((row) => row.trace.id === selectedId)?.trace.kind;
  const consoleAt = () =>
    `${base}${consoleHref(selectedId, { ...view.address(), from: sectionFor(selectedKind), ...sliced.params })}`;
  const toolbarInTrace = split && selectedId !== null;
  const switchUser = <SwitchUser source={source} onSwitched={() => tellWidget("tracepanel:reload")} />;
  const panelActions = (explore?: ReactNode) => (
    <PanelActions
      user={toolbarInTrace ? null : switchUser}
      consoleAt={consoleAt}
      explore={explore}
      traceId={selectedId}
      dock={dock}
    />
  );
  const tabCount = `${tabRows.length} ${tabRows.length === 1 ? "request" : "requests"}`;
  if (PANEL_V2) {
    return (
      <PanelWaterfall
        route={route}
        selectedId={selectedId}
        rows={rows}
        listRows={recordsOf(inOrder(true, shown.rows), selectedId).reverse()}
        stored={stored}
        chains={chains}
        opensOn={opensOn}
        currentId={currentId}
        toolbar={
          <>
            <BackTo view={back} rows={listed} bare={false} />
            <span className="flex shrink-0 items-center gap-1">
              <ListToggles
                follow={follow}
                onFollow={onFollow}
                onClear={() => setClearing(true)}
                clearLabel={`Clear ${tabCount}`}
              />
            </span>
          </>
        }
        actions={(explore) => (
          <PanelActions user={switchUser} consoleAt={consoleAt} explore={explore} traceId={selectedId} dock={dock} />
        )}
        dock={dock}
        empty={history !== null && tabRows.length === 0}
        sliced={sliced}
        view={view}
        clearing={clearing}
        setClearing={setClearing}
      />
    );
  }

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
