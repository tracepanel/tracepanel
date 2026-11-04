import { type CSSProperties, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Details } from "./CallDetails";
import type { RowContext } from "./CallRowParts";
import { hopText, type ProfilesIn, type TraceProfileOpener, UnderSlot } from "./CallRowParts";
import { appName, Rows } from "./CallRows";
import type { ExplainOf } from "./CallTable";
import {
  buildTree,
  type Chain,
  callSpans,
  callTraces,
  findNode,
  hiddenLogsOf,
  type Mark,
  markTree,
  type Node,
  type Picked,
  pathTo,
  type ServedRun,
  type SpanNode,
  withCallIssues,
  withShownLogs,
} from "./callTree";
import { type CatchUp, useChain } from "./hooks/useChain";
import { CloseIcon } from "./icons";
import { type Category, spanCategories } from "./lib/breakdown";
import { isTyping } from "./lib/keys";
import { quietSpans } from "./lib/quiet";
import type { SpanScope } from "./lib/scope";
import type { Slice, TimeRange, Windows } from "./lib/slice";
import { splitByProfile } from "./lib/timeShares";
import { useRemembered, VIEW_KEYS } from "./lib/viewMemory";
import type { TraceLinks } from "./links";
import { SideResize, useSideWidth } from "./SideResize";
import { RangeBand, useHeldSlice, useRangeDrag } from "./TimeSlice";
import type { IssueKind, Related, Span, Trace } from "./types";
import { crumbOf, filterMarks, stretchOf, useWaterfall, type WaterfallHost } from "./Waterfall";
import { WaterfallDetails } from "./WaterfallDetails";

/** From this width of the call tree its details open beside it; narrower, under their row. */
const SIDE_MIN_WIDTH = 760;

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** The pane sticks under the trace's sticky tabs and fits in the rest of the scrolling view. */
function stickyTop(map: HTMLElement): number {
  return map.closest(".dt-trace")?.querySelector<HTMLElement>(".dt-trace-strip, .dt-tabs")?.offsetHeight ?? 0;
}

function viewHeight(map: HTMLElement): number {
  return scrollParent(map)?.clientHeight ?? window.innerHeight;
}

function fitSidePane(map: HTMLElement): void {
  const top = stickyTop(map);
  const view = viewHeight(map);
  map.style.setProperty("--dt-side-top", `${top}px`);
  map.style.setProperty("--dt-side-height", `${view - top}px`);
}

/**
 * The pane's height: from where it is now to the view's bottom. It sticks under the tabs only once the view scrolled
 * it there; before, the tree's head (the time strip, the filters) sits above it, and a pane as tall as the view under
 * the tabs ran that far past the view's bottom. Its own scrolling stops at its edge (a wheel over it never scrolls the
 * view), so its last rows were out of reach.
 */
function fitPane(pane: HTMLElement, map: HTMLElement): void {
  const view = scrollParent(map);
  const viewTop = view ? view.getBoundingClientRect().top + view.clientTop : 0;
  const viewHeight = view?.clientHeight ?? window.innerHeight;
  const at = Math.max(stickyTop(map), pane.getBoundingClientRect().top - viewTop);
  pane.style.maxHeight = `${Math.max(0, viewHeight - at)}px`;
}

/** The view, the tree and the tabs over it, each when it resizes; the view (or the window) as it scrolls. */
function watchView(map: HTMLElement, fit: () => void): () => void {
  const observer = new ResizeObserver(fit);
  observer.observe(map);
  const view = scrollParent(map);
  if (view) observer.observe(view);
  const sticky = map.closest(".dt-trace")?.querySelector<HTMLElement>(".dt-trace-strip, .dt-tabs");
  if (sticky) observer.observe(sticky);
  let frame = 0;
  const scrolled = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fit);
  };
  const scroller: HTMLElement | Window = view ?? window;
  scroller.addEventListener("scroll", scrolled, { passive: true });
  // With no scrolling parent the window is the view.
  window.addEventListener("resize", fit);
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    scroller.removeEventListener("scroll", scrolled);
    window.removeEventListener("resize", fit);
  };
}

/**
 * Whether the call tree is wide enough for the details pane beside it. The tree's height follows the view it scrolls
 * in: a panel dragged taller or shorter changes the view alone, and a height fitted to the old one stopped the line
 * between tree and pane in mid-air.
 */
function useSidePane(map: RefObject<HTMLDivElement | null>): boolean {
  const [side, setSide] = useState(false);
  useEffect(() => {
    const element = map.current;
    if (!element) return;
    return watchView(element, () => {
      setSide(element.clientWidth >= SIDE_MIN_WIDTH);
      fitSidePane(element);
    });
  }, [map]);
  return side;
}

/** Beside the tree, like the devtools' Network panel: the tree keeps its shape, the details stay in view. */
function SidePane({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = pane.current;
    const map = element?.closest<HTMLElement>(".dt-map");
    if (!(element && map)) return;
    const fit = () => fitPane(element, map);
    fit();
    return watchView(map, fit);
  }, []);
  return (
    <aside className="dt-map-side" aria-label="Details" ref={pane}>
      <button type="button" className="dt-map-side-close" aria-label="Close the details" onClick={onClose}>
        <CloseIcon />
      </button>
      {children}
    </aside>
  );
}

/**
 * The tree, and its details beside it while it is wide enough. The edge between them is the grid's own (SideResize),
 * as tall as the tree and the pane together however far either reaches or scrolls: the whole line drags.
 */
function MapBody({ details, onClose, children }: { details: ReactNode; onClose: () => void; children: ReactNode }) {
  const { width, setWidth, style } = useSideWidth();
  return (
    <div className="dt-map-body" data-side={details ? "" : undefined} style={details ? style : undefined}>
      <div className="dt-map-tree">{children}</div>
      {details ? (
        <>
          <SideResize width={width} onWidth={setWidth} />
          <SidePane onClose={onClose}>{details}</SidePane>
        </>
      ) : null}
    </div>
  );
}

/* ---------- the waterfall (redesign A) ---------- */

/** The selection the waterfall holds for every trace's rows: one row selected across them. */
function hostSelection(host: WaterfallHost, traceId: string) {
  const selected = host.selected?.trace === traceId ? host.selected.key : null;
  return {
    selected,
    select: (key: string) => host.select(traceId, selected === key ? null : key),
    close: () => host.select(traceId, null),
  };
}

/** The rows a zoom keeps: the row zoomed to, alone at the top; none of a trace the zoom is not in. */
function zoomedTree(tree: Node[], host: WaterfallHost, trace: Trace): Node[] {
  const zoom = host.zoom;
  if (!zoom) return tree;
  if (zoom.trace !== trace.id) return [];
  const found = findNode(tree, zoom.key, trace);
  return found ? [found.node] : tree;
}

/** z zooms the waterfall to the row selected in this trace. */
function useZoomKey(host: WaterfallHost, tree: Node[], trace: Trace, selected: string | null): void {
  const latest = useRef({ host, tree, trace, selected });
  latest.current = { host, tree, trace, selected };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "z" || isTyping(event)) return;
      const { host: now, tree: rows, trace: of, selected: key } = latest.current;
      if (!key || now.selected?.trace !== of.id) return;
      const found = findNode(rows, key, of);
      if (found) zoomTo(now, of, found.node);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function zoomTo(host: WaterfallHost, trace: Trace, node: Node): void {
  const axis = stretchOf(node);
  if (!axis) return;
  host.setZoom({ trace: trace.id, key: node.key, ...crumbOf(node), axis });
}

function WaterfallRows({
  host,
  tree,
  trace,
  ctx,
  depth,
  details,
  selected,
}: {
  host: WaterfallHost;
  tree: Node[];
  trace: Trace;
  ctx: RowContext;
  depth: number;
  details: ReactNode;
  selected: string | null;
}) {
  useZoomKey(host, tree, trace, selected);
  const shown = zoomedTree(tree, host, trace);
  const marks = useMemo(() => (host.filter ? filterMarks(shown, host.filter) : ctx.marks), [shown, host.filter, ctx]);
  if (shown.length === 0) return null;
  const found = selected ? findNode(tree, selected, trace) : undefined;
  return (
    <div className="dt-map" data-waterfall="">
      <div className="dt-map-rows">
        <Rows nodes={shown} depth={host.zoom ? 0 : depth} ctx={{ ...ctx, marks }} />
      </div>
      {found && host.details
        ? createPortal(
            <WaterfallDetails
              node={found.node}
              trace={found.trace}
              onZoom={() => zoomTo(host, trace, found.node)}
              onClose={() => host.select(trace.id, null)}
              onShow={(key) => host.select(trace.id, key)}
            >
              {details}
            </WaterfallDetails>,
            host.details,
          )
        : null}
    </div>
  );
}

/* ---------- component ---------- */

const readKey = (value: string): string | null | undefined => value || undefined;

const writeKey = (key: string | null): string | undefined => key ?? undefined;

/**
 * The selected row; clicking it again closes its details. Remembered by the view (Back returns to it, the console
 * keeps it in the URL): the tree opened again starts on it, else on the span a link asked for.
 */
function useSelection(initialSpan: string | undefined) {
  const [selected, setSelected] = useRemembered<string | null>(VIEW_KEYS.span, initialSpan ?? null, readKey, writeKey);
  // Another span asked for while the tree is open (a mark on the lanes over it): that one is selected.
  const asked = useRef(initialSpan);
  useEffect(() => {
    if (initialSpan === asked.current) return;
    asked.current = initialSpan;
    if (initialSpan) setSelected(initialSpan);
  }, [initialSpan, setSelected]);
  const select = (key: string) => setSelected(selected === key ? null : key);
  return { selected, select, close: () => setSelected(null) };
}

/**
 * The rows, brought into view once when a link opened the tree on one of them. Back puts the page's own scroll back
 * after this: the row stays where the reader left it.
 */
function useScrolledToInitial(initialSpan: string | undefined): RefObject<HTMLDivElement | null> {
  const rows = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (initialSpan) rows.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
  }, [initialSpan]);
  return rows;
}

function readKeys(value: string): ReadonlySet<string> | undefined {
  try {
    const keys: unknown = JSON.parse(value);
    return Array.isArray(keys) ? new Set(keys.filter((key) => typeof key === "string")) : undefined;
  } catch {
    return undefined;
  }
}

const writeKeys = (keys: ReadonlySet<string>): string | undefined =>
  keys.size ? JSON.stringify([...keys]) : undefined;

/**
 * The rows folded or opened from where they start: remembered by the view, so Back returns to the same tree. The rows
 * on the way to the one a link asked for (`initialSpan`) are opened.
 */
function useFolded(
  tree: readonly Node[],
  initialSpan: string | undefined,
  folded: readonly string[] = [],
): [ReadonlySet<string>, (key: string) => void] {
  const [keys, setKeys] = useRemembered<ReadonlySet<string>>(
    VIEW_KEYS.folded,
    () => new Set(folded),
    readKeys,
    writeKeys,
  );
  const toggle = (key: string) => {
    const next = new Set(keys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setKeys(next);
  };
  // The rows on the way to one opened: a group's opened (it starts folded), a span's not folded (it starts open).
  const openPath = (path: readonly Node[]) => {
    const next = openedTo(keys, path);
    if (next.size !== keys.size || [...next].some((key) => !keys.has(key))) setKeys(next);
  };
  useOpenedTo(tree, initialSpan, openPath);
  return [keys, toggle];
}

/** The rows folded or opened with those on the way to a row opened: a group's opened, a span's no longer folded. */
function openedTo(keys: ReadonlySet<string>, path: readonly Node[]): Set<string> {
  const next = new Set(keys);
  for (const node of path.slice(0, -1)) {
    if (node.type === "group") next.add(`open:${node.key}`);
    else next.delete(node.key);
  }
  return next;
}

/**
 * A row a link asked for, shown: the rows on its way opened, once, as soon as the tree has it (a call's trace comes
 * with the chain, a moment after the tree).
 */
function useOpenedTo(
  tree: readonly Node[],
  initialSpan: string | undefined,
  openPath: (path: readonly Node[]) => void,
) {
  // The row asked for and not shown yet; another one asked for later takes its place.
  const pending = useRef<{ asked: string | undefined; key: string | undefined }>({ asked: undefined, key: undefined });
  const opener = useRef(openPath);
  opener.current = openPath;
  useEffect(() => {
    if (pending.current.asked !== initialSpan) pending.current = { asked: initialSpan, key: initialSpan };
    const key = pending.current.key;
    const path = key ? pathTo(tree, key) : undefined;
    if (!path) return;
    pending.current.key = undefined;
    opener.current(path);
    // Into view once it is drawn, open.
    requestAnimationFrame(() =>
      document.querySelector('.dt-map-rows [aria-current="true"]')?.scrollIntoView({ block: "center" }),
    );
  }, [tree, initialSpan]);
}

/** What is under a row, as the trace's tabs take it: a span's, a group's spans', a call's trace. */
function scopeOfNode(node: Node): SpanScope | undefined {
  if (node.type === "span") return spanScope(node);
  if (node.type === "group") {
    return {
      targets: node.spans.map((span) => span.id),
      label: `${node.spans[0]?.name} ×${node.spans.length}`,
      only: false,
    };
  }
  if (node.type === "task" && node.kind === "call") {
    return { targets: [node.run.id], label: appName(node) ?? node.run.name, only: false };
  }
  return undefined;
}

/** What a row's details call what is under it: "Inside this span", "Inside these calls". */
export type UnderSubject = "this span" | "this call" | "these calls" | "this trace";

function subjectOf(node: Node): UnderSubject {
  if (node.type === "group") return "these calls";
  if (node.type === "task") return "this trace";
  return node.type === "span" && node.served ? "this call" : "this span";
}

/** A span's, a merged call's (see hopScope). */
function spanScope({ span, served }: SpanNode): SpanScope {
  return served ? hopScope(span, served) : { targets: [span.id], label: span.name, only: false };
}

/** What is under a merged call: its span's, which takes the trace served for it too. */
function hopScope(span: Span, served: ServedRun): SpanScope {
  const app = appName(served);
  return { targets: [span.id], label: app ? `${hopText(span)} → ${app}` : span.name, only: false };
}

function detailsOf(
  tree: Node[],
  selected: string | null,
  trace: Trace,
  hosts: {
    links: TraceLinks | undefined;
    explainOf: ExplainOf | undefined;
    onTraceProfile: TraceProfileOpener | undefined;
    under: ((scope: SpanScope, subject: UnderSubject) => ReactNode) | undefined;
  },
): ReactNode {
  const found = selected ? findNode(tree, selected, trace) : undefined;
  if (!found) return null;
  // A query is explained by the app of the trace it is in: this one's, or a linked trace's (the agent asks that app).
  const onExplain = hosts.explainOf?.(found.trace);
  const scope = hosts.under && scopeOfNode(found.node);
  return (
    <UnderSlot value={scope ? hosts.under?.(scope, subjectOf(found.node)) : null}>
      <Details
        node={found.node}
        trace={found.trace}
        links={hosts.links}
        onExplain={onExplain}
        onTraceProfile={hosts.onTraceProfile}
      />
    </UnderSlot>
  );
}

/** The rows a slice keeps, or undefined while it is the whole trace. */
function marksOf(tree: Node[], picked: Picked): Map<string, Mark> | undefined {
  if (picked.parts.size === 0 && picked.range === null) return undefined;
  const found = new Map<string, Mark>();
  markTree(tree, picked, found);
  return found;
}

/** Where the track column of the rows is, across the tree: the picked range is drawn over it, rows and head. */
function useTrackColumn(
  timed: RefObject<HTMLDivElement | null>,
  ruler: RefObject<HTMLSpanElement | null>,
): CSSProperties | undefined {
  const [place, setPlace] = useState<CSSProperties | undefined>(undefined);
  useEffect(() => {
    const box = timed.current;
    if (!box) return;
    const observer = new ResizeObserver(() => {
      const column = ruler.current?.getBoundingClientRect();
      const outer = box.getBoundingClientRect();
      if (column) setPlace({ left: column.left - outer.left, width: column.width });
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [timed, ruler]);
  return place;
}

/**
 * The head and the rows, over the trace's time: a drag across the bars' column (or the head over it) picks a
 * stretch of it, a double click lets it go.
 */
function TimedRows({
  trace,
  range,
  onRange,
  children,
}: {
  trace: Trace;
  range: TimeRange | null;
  onRange: (range: TimeRange | null) => void;
  children: ReactNode;
}) {
  const timed = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const column = useTrackColumn(timed, ruler);
  const total = Math.max(trace.duration, 1);
  const drag = useRangeDrag(total, onRange);
  const shown = drag.draft ?? range;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drag over the rows, which are buttons of their own.
    <div
      className="dt-map-timed"
      ref={timed}
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (ruler.current && target.closest(".dt-map-track, .dt-map-ruler")) drag.start(event, ruler.current);
      }}
      onDoubleClick={(event) => {
        if ((event.target as Element).closest(".dt-map-track, .dt-map-ruler")) onRange(null);
      }}
    >
      <div className="dt-map-head">
        <span>Call tree</span>
        <span className="dt-map-ruler" ref={ruler} title="Drag to pick a stretch of the time" />
        <span>Time</span>
      </div>
      {children}
      {shown && column ? (
        <div className="dt-map-range-layer" style={column}>
          <RangeBand range={shown} total={total} />
        </div>
      ) : null}
    </div>
  );
}

/** The tree with the records that show, and how many don't, by span: none hidden while every one shows. */
function useShownLogs(trace: Trace, related: Related | undefined, all: boolean, loaded: ReadonlyMap<string, Related>) {
  const tree = useMemo(() => {
    const chain: Chain = { level: 0, relatedOf: (id) => loaded.get(id), seen: new Set([trace.id]), allLogs: all };
    return buildTree(withShownLogs(trace, all), related, chain);
  }, [trace, related, all, loaded]);
  const hidden = useMemo(
    () =>
      all
        ? new Map<string, number>()
        : hiddenLogsOf([trace, ...callTraces(related, loaded)], callSpans(related, loaded)),
    [trace, related, all, loaded],
  );
  return { tree, hidden };
}

/**
 * The profile opened at stretches of the trace (a code row's), where its time can be split by it: it says when its
 * samples were taken, or it has none (the spans say it all, its code not profiled).
 */
function profileOpener(
  open: (() => void) | undefined,
  trace: Trace,
  profileAt: (windows: Windows | null) => void,
): ((windows: Windows) => void) | undefined {
  if (!open) return undefined;
  return (windows) => {
    // The Profile tab's own stretch: the call tree's range is a drag's only.
    if (splitByProfile(trace)) profileAt(windows);
    open();
  };
}

/** Each span's share of the time, and those whose own code ran long with nothing recorded inside. */
function useSpansTime(trace: Trace) {
  const categories = useMemo(() => spanCategories(trace), [trace]);
  const quiet = useMemo(() => quietSpans(trace), [trace]);
  return { categories, quiet };
}

function pickedOf(slice: Slice, trace: Trace, categories: ReadonlyMap<string, Category>): Picked {
  return { parts: new Set(slice.parts), range: slice.range, start: trace.start, categories };
}

/** The request as a call tree: what ran inside what, in order, and how long each part took. */
export function CallMap({
  trace,
  issueBySpan,
  related,
  links,
  initialSpan,
  head,
  ...wiring
}: {
  trace: Trace;
  issueBySpan: ReadonlyMap<string, IssueKind>;
  /** Above the tree, in the panel: the trace's time and its legend, which pick the rows. */
  head?: ReactNode;
  /** The trace's chain of calls, loaded on its own clock: the tree's links are asked again while they miss any of it. */
  expected?: CatchUp["expected"];
  /** Asks for `related` again: while it misses a call's trace the chain has. */
  reloadRelated?: (() => void) | undefined;
  /** Opens the trace's profile, when it has one: its code rows lead there. */
  onProfile?: (() => void) | undefined;
  /** Opens another trace's profile by its id: a call's trace from another app, opened under its call. */
  onTraceProfile?: TraceProfileOpener | undefined;
  /** Whether the app that recorded a trace profiles a request when asked: its untraced code then says how. */
  profilesIn?: ProfilesIn | undefined;
  /** EXPLAIN for a query of this trace or a linked one: a SELECT's details then have its plan, as the DB tab's. */
  explainOf?: ExplainOf | undefined;
  /** Linked traces: tasks this trace enqueued appear under their enqueue span. */
  related?: Related | undefined;
  links?: TraceLinks | undefined;
  /** A span to open with its details, as a link to it asks (a log line's span). */
  initialSpan?: string | undefined;
  /**
   * Loads another trace's links: a call's trace opened in the tree then has the traces its own calls reached under
   * them, down the chain (the browser's view, the BFF, each service). Without it the tree opens one level.
   */
  loadRelated?: ((traceId: string) => Promise<Related>) | undefined;
  /** Under a row's details' title: what is under it (its records, ...), each a way to the tab that lists them. */
  under?: ((scope: SpanScope, subject: UnderSubject) => ReactNode) | undefined;
  /** In the waterfall: how deep its rows start (a page's requests under the page), its root row folded. */
  depth?: number | undefined;
  foldRoot?: boolean | undefined;
}) {
  // The part of the time picked: the kinds of calls and the stretch of time the rows are kept for.
  const { slice: current, change, profileAt } = useHeldSlice();
  const chain = useChain(trace.id, wiring.loadRelated, related, {
    expected: wiring.expected,
    reloadRoot: wiring.reloadRelated,
  });
  const { tree, hidden } = useShownLogs(trace, related, current.logs, chain.loaded);
  const issues = useMemo(
    () => withCallIssues(issueBySpan, related, chain.loaded),
    [issueBySpan, related, chain.loaded],
  );
  const host = useWaterfall();
  const own = useSelection(initialSpan);
  const { selected, select, close } = host ? hostSelection(host, trace.id) : own;
  const map = useRef<HTMLDivElement>(null);
  const side = useSidePane(map);
  const rows = useScrolledToInitial(initialSpan);
  const rootKeys = wiring.foldRoot ? tree.map((node) => node.key) : [];
  const [collapsed, toggle] = useFolded(tree, initialSpan, rootKeys);
  const details = detailsOf(tree, selected, trace, {
    links,
    explainOf: wiring.explainOf,
    onTraceProfile: wiring.onTraceProfile,
    under: wiring.under,
  });
  const { categories, quiet } = useSpansTime(trace);
  const marks = useMemo(() => marksOf(tree, pickedOf(current, trace, categories)), [tree, current, trace, categories]);
  const inline = side ? null : details;
  const ctx: RowContext = {
    trace,
    issueBySpan: issues,
    selected,
    onSelect: select,
    collapsed,
    onToggle: toggle,
    marks,
    details: host ? null : inline,
    hiddenLogs: hidden,
    code: {
      trace,
      quiet,
      onProfile: profileOpener(wiring.onProfile, trace, profileAt),
      profiles: wiring.profilesIn?.(trace) === true,
    },
    categories,
    slice: current,
    onTraceProfile: wiring.onTraceProfile,
    profilesIn: wiring.profilesIn,
    onShowLogs: () => change({ ...current, logs: true }),
    onChain: chain.want,
  };
  if (host) {
    return (
      <WaterfallRows
        host={host}
        tree={tree}
        trace={trace}
        ctx={ctx}
        depth={wiring.depth ?? 0}
        details={details}
        selected={selected}
      />
    );
  }

  return (
    <div className="dt-map" ref={map}>
      {head}
      <MapBody details={side ? details : null} onClose={close}>
        <TimedRows trace={trace} range={current.range} onRange={(range) => change({ ...current, range })}>
          <div className="dt-map-rows" ref={rows}>
            <Rows nodes={tree} depth={0} ctx={ctx} />
          </div>
        </TimedRows>
      </MapBody>
    </div>
  );
}
