// The panel, redesign A (a prototype): one toolbar (the page and the zoom as breadcrumbs, the facets with their
// totals, a filter, Follow), a thin overview of the page's time with the window, and one waterfall whose rows open
// into the call tree: the page, its requests, their calls. The selected row's details are in one pane: right of the
// rows docked at the bottom, a sheet under them docked right.
import {
  type Axis,
  CloseIcon,
  duration,
  ExternalIcon,
  type Facet,
  Hint,
  Logo,
  TraceBadge,
  type TraceRow,
  WaterfallContext,
  type WaterfallFacts,
  type WaterfallHost,
  type Zoom,
} from "@tracepanel/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@tracepanel/ui/components/ui/dropdown-menu";
import { isTyping } from "@tracepanel/ui/lib/keys";
import { writeItem } from "@tracepanel/ui/lib/storage";
import {
  ArrowUpRightIcon,
  DatabaseIcon,
  EllipsisIcon,
  ScrollTextIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFollowNew } from "./App";
import { ClearDialog } from "./ClearDialog";
import { useTabHistory } from "./hooks";
import { useTabRows } from "./panelChains";
import { tellWidget, useDock } from "./panelLayout";
import { DockButton, ListToggles, PANEL_LINKS, readFollow, writeFollow } from "./panelList";
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

/** Where the axis says its times: about five ticks at a round step. */
function ticks(axis: Axis): { at: number; label: string }[] {
  const raw = axis.duration / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((each) => each * power).find((each) => each >= raw) ?? raw;
  const out: { at: number; label: string }[] = [];
  for (let at = 0; at <= axis.duration; at += step)
    out.push({ at: at / axis.duration, label: at ? duration(at) : "0" });
  return out;
}

/** The facets' totals, over every trace in the waterfall. */
function totals(facts: ReadonlyMap<string, WaterfallFacts>) {
  const all = [...facts.values()];
  const sum = (pick: (each: WaterfallFacts) => number) => all.reduce((total, each) => total + pick(each), 0);
  const calls = (pick: (each: WaterfallFacts) => WaterfallFacts["db"]) => {
    const count = sum((each) => pick(each).count);
    const us = sum((each) => pick(each).us);
    const one = all.filter((each) => pick(each).count > 0);
    const time = one.length === 1 && one[0] ? pick(one[0]).time : us > 0 ? duration(us) : "";
    return { count, time };
  };
  return {
    issues: sum((each) => each.issues),
    db: calls((each) => each.db),
    http: calls((each) => each.http),
    logs: sum((each) => each.logs),
  };
}

const FACETS: { id: Facet; label: string; icon: ReactNode; hint: string }[] = [
  { id: "issues", label: "Issues", icon: <TriangleAlertIcon />, hint: "Brighten the rows with issues" },
  { id: "db", label: "DB", icon: <DatabaseIcon />, hint: "Brighten the queries" },
  { id: "http", label: "HTTP", icon: <ArrowUpRightIcon />, hint: "Brighten the HTTP calls" },
  { id: "logs", label: "Logs", icon: <ScrollTextIcon />, hint: "Brighten the log records" },
];

function Facets({
  facts,
  facet,
  onFacet,
}: {
  facts: ReturnType<typeof totals>;
  facet: Facet | null;
  onFacet: (facet: Facet | null) => void;
}) {
  const of = (id: Facet) =>
    id === "issues" ? { count: facts.issues, time: "" } : id === "logs" ? { count: facts.logs, time: "" } : facts[id];
  return (
    <div className="wf-facets" role="toolbar" aria-label="Facets">
      {FACETS.map((each) => {
        const { count, time } = of(each.id);
        if (count === 0) return null;
        return (
          <Hint key={each.id} title={each.hint}>
            <button
              type="button"
              className="wf-facet"
              data-facet={each.id}
              aria-pressed={facet === each.id}
              onClick={() => onFacet(facet === each.id ? null : each.id)}
            >
              {each.icon}
              <span className="wf-facet-label">{each.label}</span>
              <b>{count}</b>
              {time ? <span className="wf-facet-time">{time}</span> : null}
            </button>
          </Hint>
        );
      })}
    </div>
  );
}

/** The page's crumb, then the row zoomed to: the page's crumb zooms out. */
function Crumbs({ head, zoom, onOut }: { head: TraceRow | undefined; zoom: Zoom | null; onOut: () => void }) {
  if (!head) return <span className="wf-crumbs" />;
  const word = head.trace.kind === "page" ? "VIEW" : (head.trace.method ?? head.trace.kind.toUpperCase());
  const name = head.trace.kind === "page" ? head.trace.name : (head.trace.path ?? head.trace.name);
  return (
    <nav className="wf-crumbs" aria-label="Breadcrumbs">
      <button type="button" className="wf-crumb" onClick={onOut} aria-current={zoom ? undefined : "page"}>
        <TraceBadge word={word} />
        <span className="wf-crumb-name">{name}</span>
      </button>
      {zoom ? (
        <>
          <span className="wf-crumb-sep" aria-hidden="true">
            ›
          </span>
          <span className="wf-crumb" aria-current="page">
            <TraceBadge word={zoom.badge} />
            <span className="wf-crumb-name">{zoom.label}</span>
          </span>
        </>
      ) : null}
    </nav>
  );
}

/** The page's time in one thin line: its traces' bars, the window the waterfall shows over them. */
function Overview({
  page,
  axis,
  zoom,
  onZoom,
}: {
  page: readonly TraceRow[];
  axis: Axis;
  zoom: Zoom | null;
  onZoom: (row: TraceRow | null) => void;
}) {
  const place = (start: number, length: number) => ({
    left: `${Math.max(((start - axis.start) / axis.duration) * 100, 0)}%`,
    width: `${Math.max((length / axis.duration) * 100, 0.4)}%`,
  });
  const requests = page.filter((row) => row.depth).length;
  return (
    <div className="wf-overview">
      <span className="wf-overview-label">
        <b>This page</b>
        {requests ? ` · ${requests} ${requests === 1 ? "request" : "requests"}` : ""}
        {zoom ? ` · window: ${zoom.label}` : ""}
      </span>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click beside the window zooms out; the bars are buttons. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Backspace zooms out from the keyboard. */}
      <span className="wf-overview-track" onClick={(event) => event.target === event.currentTarget && onZoom(null)}>
        {page.map((row) => (
          <button
            type="button"
            key={row.key ?? row.trace.id}
            className="wf-overview-bar"
            data-kind={row.trace.kind}
            data-depth={row.depth ?? 0}
            title={`${row.trace.name} · ${duration(row.trace.duration)}`}
            style={place(row.trace.start, row.trace.duration)}
            onClick={() => onZoom(row.depth ? row : null)}
          />
        ))}
        {zoom ? <span className="wf-overview-window" style={place(zoom.axis.start, zoom.axis.duration)} /> : null}
      </span>
      <span className="wf-overview-total">{duration(axis.duration)}</span>
    </div>
  );
}

function AxisHead({ axis }: { axis: Axis }) {
  return (
    <div className="wf-head">
      <span>Call</span>
      <span className="wf-ticks" aria-hidden="true">
        {ticks(axis).map((tick) => (
          <span key={tick.at} style={{ left: `${tick.at * 100}%` }}>
            {tick.label}
          </span>
        ))}
      </span>
      <span>Time</span>
    </div>
  );
}

function MoreMenu({ traceId }: { traceId: string | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="icon-button" aria-label="More">
          <EllipsisIcon />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="flex items-center gap-1 px-1 py-1">
          <ShareAction traceId={traceId} source={source} compact={true} />
          <ThemeToggle compact={true} />
          <SwitchUser source={source} onSwitched={() => tellWidget("tracepanel:reload")} />
        </div>
        <DropdownMenuItem
          onSelect={() => {
            writeItem(PANEL_A_KEY, "off");
            window.location.reload();
          }}
        >
          Show the old panel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The waterfall's state: the selection, the zoom, the facet, the filter, and what each trace reports. */
function useHost(axis: Axis | null, details: HTMLElement | null) {
  const [selected, setSelected] = useState<{ trace: string; key: string } | null>(null);
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const [facet, setFacet] = useState<Facet | null>(null);
  const [filter, setFilter] = useState("");
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
    () => ({
      axis: zoom?.axis ?? axis,
      selected,
      select,
      details,
      filter,
      facet,
      zoom,
      setZoom,
      report,
    }),
    [axis, zoom, selected, select, details, filter, facet, report],
  );
  return { host, facts, setFacet, setFilter, setZoom, setSelected };
}

/** Backspace zooms out; Esc zooms out, then lets the row go, then closes the panel; / goes to the filter. */
function usePanelKeys(
  state: { zoom: Zoom | null; selected: unknown },
  out: () => void,
  deselect: () => void,
  filter: React.RefObject<HTMLInputElement | null>,
) {
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "/" && !isTyping(event)) {
        event.preventDefault();
        filter.current?.focus();
        return;
      }
      if (event.key === "Backspace" && !isTyping(event) && latest.current.zoom) {
        event.preventDefault();
        out();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (latest.current.zoom) out();
      else if (latest.current.selected) deselect();
      else tellWidget("tracepanel:close");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [out, deselect, filter]);
}

export function PanelA({ route }: { route: Route }) {
  const history = useTabHistory();
  const { rows, stored, runs } = useTabRows(history);
  const listed = withRuns(rows, runs);
  const currentId = history?.current ?? null;
  const selectedId =
    route.name === "trace" ? route.id : (currentId ?? rows.find((row) => row.depth === 0)?.trace.id ?? null);
  const dock = useDock();
  const [follow, setFollow] = useState(readFollow);
  const [clearing, setClearing] = useState(false);
  const [details, setDetails] = useState<HTMLElement | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const page = useMemo(() => pageOf(listed, selectedId), [listed, selectedId]);
  const top = topRows(page);
  const axisKey = page.map((row) => `${row.trace.id}:${row.trace.start}:${row.trace.duration}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `axisKey` says when the page's time changed.
  const axis = useMemo(() => pageAxis(page), [axisKey]);
  const { host, facts, setFacet, setFilter, setZoom, setSelected } = useHost(axis, details);
  const zoomOut = useCallback(() => setZoom(null), [setZoom]);
  const deselect = useCallback(() => setSelected(null), [setSelected]);
  usePanelKeys({ zoom: host.zoom, selected: host.selected }, zoomOut, deselect, filterRef);
  // A new page on screen: no zoom or selection of the last one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new page only.
  useEffect(() => {
    setZoom(null);
    setSelected(null);
  }, [top[0]?.trace.id]);

  const latest = followTarget(inOrder(true, rows));
  useFollowNew(follow, latest, history !== null);
  const onFollow = (value: boolean) => {
    setFollow(value);
    writeFollow(value);
  };
  const sums = totals(facts);
  const consoleAt = () => `${base}${selectedId ? href({ name: "trace", id: selectedId }) : "#/"}`;
  const zoomToRow = (row: TraceRow | null) => {
    if (!row) return setZoom(null);
    // A request of the page: the waterfall shows it alone, on its own time.
    setZoom({
      trace: row.trace.id,
      key: "",
      badge: row.trace.kind === "page" ? "VIEW" : (row.trace.method ?? "REQ"),
      label: row.trace.name,
      axis: { start: row.trace.start, duration: Math.max(row.trace.duration, 1) },
    });
  };

  return (
    <WaterfallContext.Provider value={host}>
      <div className="panel wf-panel" data-dock={dock}>
        <header className="wf-bar">
          <Logo className="shrink-0 gap-1.5 text-md [&>span]:hidden [&_svg]:size-5" />
          <Crumbs head={top[0]} zoom={host.zoom} onOut={zoomOut} />
          <span className="wf-bar-fill" />
          <Facets facts={sums} facet={host.facet} onFacet={setFacet} />
          <label className="wf-filter">
            <SearchIcon />
            <input
              ref={filterRef}
              type="search"
              placeholder="Filter calls"
              value={host.filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setFilter("");
                  event.currentTarget.blur();
                }
              }}
            />
            <kbd>/</kbd>
          </label>
          <span className="flex shrink-0 items-center gap-0.5">
            <ListToggles follow={follow} onFollow={onFollow} onClear={() => setClearing(true)} />
          </span>
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
          <MoreMenu traceId={selectedId} />
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
        </header>
        {axis ? <Overview page={page} axis={axis} zoom={host.zoom} onZoom={zoomToRow} /> : null}
        <div className="wf-main" data-details={host.selected ? "" : undefined}>
          <div className="wf-scroll">
            {host.axis ? <AxisHead axis={host.axis} /> : null}
            <div className="wf-rows" data-facet={host.facet ?? undefined} data-filter={host.filter ? "" : undefined}>
              {selectedId && top.length === 0 ? (
                <WaterfallTrace id={selectedId} rows={rows} stored={stored} depth={0} fold={false} />
              ) : null}
              {top.map((row, at) =>
                host.zoom && host.zoom.key === "" && host.zoom.trace !== row.trace.id ? null : (
                  <WaterfallTrace
                    key={row.key ?? row.trace.id}
                    id={row.trace.id}
                    rows={rows}
                    stored={stored}
                    depth={at === 0 || host.zoom ? 0 : 1}
                    fold={at > 0 && !host.zoom}
                  />
                ),
              )}
              {history && !selectedId ? (
                <p className="wf-hint">No requests yet: requests from this browser tab appear here.</p>
              ) : null}
              {selectedId ? (
                <p className="wf-hint">
                  z zooms the axis to the selected row · Backspace zooms out · new requests append here
                </p>
              ) : null}
            </div>
          </div>
          <aside className="wf-details" ref={setDetails} aria-label="Details" hidden={!host.selected} />
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
}: {
  id: string;
  rows: readonly TraceRow[];
  stored: ReadonlySet<string>;
  depth: number;
  fold: boolean;
}) {
  return (
    <TraceScreen
      id={id}
      source={source}
      arriving={arrivingIn(rows, stored, id)}
      running={runningIn(rows, id)}
      variant="waterfall"
      waterfall={{ depth, foldRoot: fold }}
      links={PANEL_LINKS}
    />
  );
}
