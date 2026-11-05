import {
  type CSSProperties,
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CodeDetails, type CodeInfo } from "./CallCode";
import { Details } from "./CallDetails";
import { hopText, type ProfilesIn, type RowContext, type TraceProfileOpener, UnderSlot } from "./CallRowParts";
import { appName, Rows } from "./CallRows";
import type { ExplainOf } from "./CallTable";
import {
  buildTree,
  type Chain,
  callSpans,
  callTraces,
  childrenOf,
  filteredTree,
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
import { quietSpans } from "./lib/quiet";
import type { CodeStretch, SpanScope } from "./lib/scope";
import type { Slice, TimeRange, Windows } from "./lib/slice";
import { splitByProfile } from "./lib/timeShares";
import { useRemembered, VIEW_KEYS } from "./lib/viewMemory";
import type { TraceLinks } from "./links";
import { SideResize, useSideWidth } from "./SideResize";
import { RangeBand, useHeldSlice, useRangeDrag } from "./TimeSlice";
import type { IssueKind, Related, Span, Trace } from "./types";

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
  return { selected, select, pick: setSelected, close: () => setSelected(null) };
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
): [ReadonlySet<string>, (key: string) => void] {
  const [keys, setKeys] = useRemembered<ReadonlySet<string>>(VIEW_KEYS.folded, () => new Set(), readKeys, writeKeys);
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

/**
 * The rows a slice keeps under the row picked beside the details (its legend picked the share): the rest of the tree
 * as it is. The whole tree's otherwise.
 */
function scopedMarks(tree: Node[], picked: Picked, selected: string | null): Map<string, Mark> | undefined {
  const all = marksOf(tree, picked);
  const node = all && selected ? pathTo(tree, selected)?.at(-1) : undefined;
  if (!(all && node)) return all;
  const marks = new Map<string, Mark>();
  markTree(childrenOf(node), picked, marks);
  const under = new Set<string>();
  const collect = (nodes: readonly Node[]) => {
    for (const each of nodes) {
      under.add(each.key);
      collect(childrenOf(each));
    }
  };
  collect(childrenOf(node));
  const shown = (nodes: readonly Node[]) => {
    for (const each of nodes) {
      if (!under.has(each.key)) marks.set(each.key, "match");
      shown(childrenOf(each));
    }
  };
  shown(tree);
  return marks;
}

/**
 * The rows of the kinds shown. None among the rows loaded (its calls to other apps not opened yet, where they are),
 * the tree whole: the record has them, the list kept it for them, never an empty record.
 */
function kindMarks(tree: Node[], picked: Picked): Map<string, Mark> | undefined {
  const marks = marksOf(tree, picked);
  return marks && marks.size > 0 ? marks : undefined;
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
  onRange: ((range: TimeRange | null) => void) | undefined;
  children: ReactNode;
}) {
  const timed = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const column = useTrackColumn(timed, ruler);
  const total = Math.max(trace.duration, 1);
  const drag = useRangeDrag(total, onRange ?? (() => undefined));
  const shown = drag.draft ?? range;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drag over the rows, which are buttons of their own.
    <div
      className="dt-map-timed"
      ref={timed}
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (onRange && ruler.current && target.closest(".dt-map-track, .dt-map-ruler"))
          drag.start(event, ruler.current);
      }}
      onDoubleClick={(event) => {
        if ((event.target as Element).closest(".dt-map-track, .dt-map-ruler")) onRange?.(null);
      }}
    >
      <div className="dt-map-head">
        <span>Call tree</span>
        <span className="dt-map-ruler" ref={ruler} title={onRange ? "Drag to pick a stretch of the time" : undefined} />
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
function HostedDetails({ host, details }: { host: HTMLElement | null | undefined; details: ReactNode }) {
  return host && details ? createPortal(details, host) : null;
}

/**
 * The selected row. With its details hosted out of the tree (`detailsHost`) a row is always selected, the root at
 * first, a click never closes them, and the host hears the row's scope.
 */
function useRowPicked(
  tree: Node[],
  trace: Trace,
  initialSpan: string | undefined,
  { detailsHost, onPicked }: { detailsHost?: HTMLElement | null | undefined; onPicked?: PickedHandler | undefined },
  code: { info: CodeInfo; at: CodeStretch } | null,
) {
  const held = useSelection(initialSpan);
  const external = detailsHost !== undefined;
  const rootKey = tree[0]?.key ?? null;
  const selected = external ? (held.selected ?? rootKey) : held.selected;
  const picked = external && selected !== rootKey ? selected : null;
  const found = picked ? findNode(tree, picked, trace) : undefined;
  // A code or wait row: its span's own time at its stretches, named as the row is, the root's too.
  const node = found?.node ?? (code ? tree[0] : undefined);
  const codeKey = code ? `${code.at.trace}:${code.at.windows.join(";")}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the row picked, not each new tree it is found in.
  useEffect(() => {
    const scope = node ? scopeOfNode(node) : undefined;
    const coded = scope && code ? { ...scope, label: code.info.name, only: true, at: code.at } : scope;
    if (external) onPicked?.(coded ?? null);
  }, [external, picked, codeKey]);
  // A row picked from elsewhere (an issue's link) may be off screen: it comes into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the row picked is what moves the view.
  useEffect(() => {
    if (!external) return;
    const frame = requestAnimationFrame(() =>
      document.querySelector('.dt-map-row[aria-current="true"]')?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [external, selected]);
  const select = external ? (key: string) => (key === selected ? undefined : held.pick(key)) : held.select;
  return { selected, select, close: held.close, external };
}

type PickedHandler = (scope: SpanScope | null) => void;

/** What the rows are filtered by, where a filter is over them (the panel's waterfall). */
export const RowFilter = createContext("");

/**
 * The kinds of calls the panel shows (its Show menu: SQL, GraphQL, HTTP…): their rows and the way to them, every
 * record's. None picked, all show.
 */
export const RowKinds = createContext<readonly string[]>([]);

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
  /** Where the selected row's details go, out of the tree: a row is then always selected, the root at first. */
  detailsHost?: HTMLElement | null | undefined;
  /** The selected row's scope, in a tree with a `detailsHost`: null for its root. */
  onPicked?: PickedHandler | undefined;
  /** Beside the root row's name, in a tree with no summary over it. */
  rootMark?: ReactNode;
  issuesIn?: RowContext["issuesIn"];
  onIssues?: RowContext["onIssues"];
  /** Beside the tree: opens the Profile tab, a code row's profile. */
  onProfileTab?: (() => void) | undefined;
}) {
  // The part of the time picked: the kinds of calls and the stretch of time the rows are kept for.
  const { slice: current, change, profileAt } = useHeldSlice();
  const chain = useChain(trace.id, wiring.loadRelated, related, {
    expected: wiring.expected,
    reloadRoot: wiring.reloadRelated,
  });
  const { tree: whole, hidden } = useShownLogs(trace, related, current.logs, chain.loaded);
  const query = useContext(RowFilter);
  const tree = useMemo(() => filteredTree(whole, query), [whole, query]);
  const issues = useMemo(
    () => withCallIssues(issueBySpan, related, chain.loaded),
    [issueBySpan, related, chain.loaded],
  );
  const [codeRow, setCodeRow] = useState<{ row: string; info: CodeInfo; at: CodeStretch } | null>(null);
  const { selected, select, close, external } = useRowPicked(tree, trace, initialSpan, wiring, codeRow);
  const map = useRef<HTMLDivElement>(null);
  const side = useSidePane(map);
  const rows = useScrolledToInitial(initialSpan);
  const [collapsed, toggle] = useFolded(tree, initialSpan);
  const details = codeRow ? (
    <CodeDetails info={codeRow.info} onProfile={wiring.onProfileTab} />
  ) : (
    detailsOf(tree, selected, trace, {
      links,
      explainOf: wiring.explainOf,
      onTraceProfile: wiring.onTraceProfile,
      under: wiring.under,
    })
  );
  const { categories, quiet } = useSpansTime(trace);
  const kinds = useContext(RowKinds);
  const marks = useMemo(
    () =>
      kinds.length > 0
        ? kindMarks(tree, pickedOf({ ...current, parts: kinds, range: null }, trace, categories))
        : scopedMarks(tree, pickedOf(current, trace, categories), external ? selected : null),
    [tree, current, trace, categories, external, selected, kinds],
  );
  // A share picked is of the row it was picked on: another row picked lets it go.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the row picked, not the slice it changes.
  useEffect(() => {
    if (external && current.parts.length > 0) change({ ...current, parts: [] });
  }, [external, selected]);
  const inline = side || external ? null : details;

  return (
    <div className="dt-map" ref={map}>
      {head}
      <HostedDetails host={wiring.detailsHost} details={details} />
      <MapBody details={side && !external ? details : null} onClose={close}>
        <TimedRows
          trace={trace}
          range={external ? null : current.range}
          // Beside the details, the rows are picked one by one: no stretch dragged across them.
          onRange={external ? undefined : (range) => change({ ...current, range })}
        >
          <div className="dt-map-rows" ref={rows}>
            <Rows
              nodes={tree}
              depth={0}
              ctx={{
                trace,
                issueBySpan: issues,
                selected,
                onSelect: (key) => {
                  setCodeRow(null);
                  select(key);
                },
                opensOnly: external,
                codeRow: codeRow?.row,
                onCodeRow: external
                  ? (row, span, info, at) => {
                      select(span);
                      setCodeRow({ row, info, at });
                    }
                  : undefined,
                issuesIn: wiring.issuesIn,
                onIssues: wiring.onIssues,
                rootMark: wiring.rootMark,
                collapsed,
                onToggle: toggle,
                marks,
                details: inline,
                hiddenLogs: hidden,
                code: {
                  trace,
                  quiet,
                  onProfile: profileOpener(wiring.onProfile, trace, profileAt),
                  profiles: wiring.profilesIn?.(trace) === true,
                },
                categories,
                // The kinds shown pick the code rows too: none of them is SQL.
                slice: kinds.length > 0 ? { ...current, parts: kinds, range: null } : current,
                onTraceProfile: wiring.onTraceProfile,
                profilesIn: wiring.profilesIn,
                onShowLogs: () => change({ ...current, logs: true }),
                onChain: chain.want,
              }}
            />
          </div>
        </TimedRows>
      </MapBody>
    </div>
  );
}
