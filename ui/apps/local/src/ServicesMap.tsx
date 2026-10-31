import {
  type AppLink,
  AppMark,
  duration,
  plural,
  type ServiceApp,
  ServiceIcon,
  type ServiceMap,
  systemName,
} from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { cn } from "@tracepanel/ui/lib/utils";
import {
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  type LucideIcon,
  MinusIcon,
  PlusIcon,
  ScanIcon,
  TerminalIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import { type CSSProperties, Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { type Box, type Diagram, type Link, laidOut, mermaidOf, type Placed, type Point } from "./architecture";
import { href, type Route } from "./routes";
import { appTarget, type Host, type HostEdge, hostUses, hostWhere, serviceTarget } from "./services";

/** A host's name on the diagram and in the Mermaid text: what runs there, where, and how the app uses it. */
function hostLabel(host: Host): string {
  return [systemName(host.primary), hostWhere(host), hostUses(host)].filter(Boolean).join(" · ");
}

/* ---------- the canvas: pan and zoom ---------- */

const ZOOM_KEY = "tracepanel:map-zoom";
/** The steps the buttons go through; a pinch or ctrl+wheel zooms anywhere between the ends. */
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2];
const [MIN_ZOOM, MAX_ZOOM] = [ZOOMS[0] ?? 0.1, ZOOMS.at(-1) ?? 2];
/** The least zoom the map opens at: its boxes' names still read. */
const FIRST_ZOOM = 0.5;
/** Room around the diagram when it is fitted into the canvas. */
const PAD = 16;
/** Room above it for the toolbar, which would cover its top row otherwise. */
const TOP = 48;
/** How far the pointer moves before a press is a drag, not a click: a hand's jitter still opens a box. */
const DRAG_SLOP = 4;
/** How far an arrow key moves the view. */
const KEY_STEP = 48;
/** The dot grid's spacing at actual size: it moves with the view and scales with the zoom. */
const DOTS = 24;

/** Where the diagram sits in the canvas: its top-left corner, and its scale. */
interface View {
  x: number;
  y: number;
  k: number;
}

type Size = { width: number; height: number };

function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** The zoom chosen on an earlier visit, or null: none chosen yet. */
function storedZoom(): number | null {
  try {
    const zoom = Number(localStorage.getItem(ZOOM_KEY));
    return zoom >= MIN_ZOOM && zoom <= MAX_ZOOM ? zoom : null;
  } catch {
    return null;
  }
}

/** A zoom the user chose, kept for the next visit; null forgets it: the map opens fitted again. */
function storeZoom(k: number | null): void {
  try {
    if (k === null) localStorage.removeItem(ZOOM_KEY);
    else localStorage.setItem(ZOOM_KEY, String(k));
  } catch {
    // Blocked storage: the zoom lasts until the page reloads.
  }
}

/**
 * The view at scale k, the diagram in the middle of the canvas under the toolbar, or right under it when taller than
 * the room there.
 */
function centered(diagram: Size, canvas: Size, k: number): View {
  const [width, height] = [diagram.width * k, diagram.height * k];
  return {
    k,
    x: Math.max(PAD, (canvas.width - width) / 2),
    y: Math.max(TOP, TOP + (canvas.height - TOP - PAD - height) / 2),
  };
}

/**
 * The whole diagram in the canvas under the toolbar, centered: zoomed out only as far as it takes, never in past actual
 * size, so a small map stays at 100% in the middle rather than shrunk into empty space.
 */
function fitView(diagram: Size, canvas: Size): View {
  return centered(diagram, canvas, fitScale(diagram, canvas));
}

function fitScale(diagram: Size, canvas: Size): number {
  const k = Math.min((canvas.width - 2 * PAD) / diagram.width, (canvas.height - TOP - PAD) / diagram.height, 1);
  return clampZoom(k);
}

/**
 * The first view: the zoom the user chose on an earlier visit, else fitted; a map too big to fit at half size opens at
 * half size, its top in view, where its boxes still read (Fit shows it whole).
 */
function firstView(diagram: Size, canvas: Size): View {
  const k = storedZoom() ?? Math.max(fitScale(diagram, canvas), FIRST_ZOOM);
  return centered(diagram, canvas, k);
}

/** The view zoomed to k around a point of the canvas: what is under it stays under it. */
function zoomedAt(view: View, k: number, at: Point): View {
  const next = clampZoom(k);
  const scale = next / view.k;
  return { k: next, x: at.x - (at.x - view.x) * scale, y: at.y - (at.y - view.y) * scale };
}

/** The canvas element and its size, as it changes. */
function useCanvas(): [HTMLDivElement | null, Size, (element: HTMLDivElement | null) => void] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry?.contentRect.width ?? 0, height: entry?.contentRect.height ?? 0 }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [element, size, setElement];
}

/** The view before one is placed: the first, once the canvas has a size. */
function unplaced(diagram: Diagram, size: Size): View | null {
  return size.width > 0 ? firstView(diagram, size) : null;
}

/** The buttons' steps below and above a view's zoom. */
function stepsAround(view: View | null): { lower: number | undefined; higher: number | undefined } {
  const k = view?.k ?? 1;
  return {
    lower: ZOOMS.filter((step) => step < k - 0.001).at(-1),
    higher: ZOOMS.find((step) => step > k + 0.001),
  };
}

/** A button's action to a step, or none past the last. */
function stepTo(step: number | undefined, zoom: (k: number) => void): (() => void) | undefined {
  return step === undefined ? undefined : () => zoom(step);
}

/**
 * The canvas's view: placed once the canvas has a size, then moved by a drag, a two-finger scroll and the arrow
 * keys, zoomed by a pinch, ctrl+wheel and the buttons. A zoom the user chose is kept across visits, until Fit.
 */
function useView(diagram: Diagram) {
  const [canvas, size, ref] = useCanvas();
  const [placed, setView] = useState<View | null>(null);
  const view = placed ?? unplaced(diagram, size);
  const current = useRef(view);
  current.current = view;
  const middle = { x: size.width / 2, y: size.height / 2 };
  const zoomTo = useCallback((k: number, at: Point) => {
    const from = current.current;
    if (!from) return;
    const next = zoomedAt(from, k, at);
    storeZoom(next.k);
    setView(next);
  }, []);
  const panBy = useCallback((dx: number, dy: number) => {
    const from = current.current;
    if (from) setView({ ...from, x: from.x + dx, y: from.y + dy });
  }, []);
  // A wheel over the canvas is the canvas's: not passive, so the page doesn't scroll (or zoom) under it.
  useEffect(() => {
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const from = current.current;
      if (!from) return;
      if (event.ctrlKey || event.metaKey) {
        const box = canvas.getBoundingClientRect();
        zoomTo(from.k * Math.exp(-event.deltaY * 0.01), { x: event.clientX - box.left, y: event.clientY - box.top });
      } else {
        panBy(-event.deltaX, -event.deltaY);
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [canvas, zoomTo, panBy]);
  const { lower, higher } = stepsAround(view);
  return {
    ref,
    view,
    panBy,
    zoomTo,
    out: stepTo(lower, (k) => zoomTo(k, middle)),
    in: stepTo(higher, (k) => zoomTo(k, middle)),
    reset: () => zoomTo(1, middle),
    // Back to the map as it opens: fitted, the chosen zoom forgotten.
    fit: () => {
      if (size.width === 0) return;
      storeZoom(null);
      setView(fitView(diagram, size));
    },
  };
}

type Canvas = ReturnType<typeof useView>;

interface Press {
  id: number;
  x: number;
  y: number;
  dragging: boolean;
}

/** The press the pointer drags, once it has moved past the slop; null for another pointer or a hand's jitter. */
function moving(press: Press | null, event: React.PointerEvent): Press | null {
  return press?.id === event.pointerId && pastSlop(press, event) ? press : null;
}

/** Whether a press drags: it did already, or the pointer has moved past the slop. */
function pastSlop(at: Press, event: React.PointerEvent): boolean {
  return at.dragging || Math.hypot(event.clientX - at.x, event.clientY - at.y) >= DRAG_SLOP;
}

/**
 * A press on the canvas that moves past the slop pans it, and the click that ends it opens nothing; a shorter one
 * is a click (a box opens). The pointer is captured only once it drags: captured from the press, the click would
 * land on the canvas, not on the box under it.
 */
function useDrag(canvas: Canvas, onDrag: () => void, setDragging: (dragging: boolean) => void) {
  const press = useRef<Press | null>(null);
  const dragged = useRef(false);
  return {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
      // A drag the browser ended with no click: its flag must not swallow this press's.
      dragged.current = false;
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const at = moving(press.current, event);
      if (!at) return;
      if (!at.dragging) {
        at.dragging = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        onDrag();
      }
      canvas.panBy(event.clientX - at.x, event.clientY - at.y);
      [at.x, at.y] = [event.clientX, event.clientY];
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      const at = press.current;
      press.current = null;
      if (!at?.dragging) return;
      dragged.current = true;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    onPointerCancel: () => {
      press.current = null;
      setDragging(false);
    },
    onClickCapture: (event: React.MouseEvent) => {
      if (!dragged.current) return;
      dragged.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

/** What each key does to the canvas: arrows pan, + and − zoom, 0 fits the whole diagram. */
const KEYS = new Map<string, (canvas: Canvas) => (() => void) | undefined>([
  ["ArrowLeft", (canvas) => () => canvas.panBy(KEY_STEP, 0)],
  ["ArrowRight", (canvas) => () => canvas.panBy(-KEY_STEP, 0)],
  ["ArrowUp", (canvas) => () => canvas.panBy(0, KEY_STEP)],
  ["ArrowDown", (canvas) => () => canvas.panBy(0, -KEY_STEP)],
  ["+", (canvas) => canvas.in],
  ["=", (canvas) => canvas.in],
  ["-", (canvas) => canvas.out],
  ["0", (canvas) => canvas.fit],
]);

/** A key on the canvas or a box in it, without a modifier (ctrl+0 and the like stay the browser's). */
function onCanvasKey(canvas: Canvas, event: React.KeyboardEvent): void {
  const modified = [event.altKey, event.ctrlKey, event.metaKey].some(Boolean);
  const action = modified ? undefined : KEYS.get(event.key)?.(canvas);
  if (!action) return;
  event.preventDefault();
  action();
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex h-6 min-w-6 items-center justify-center gap-1 rounded px-1.5 text-xs text-text-2 tabular-nums hover:bg-accent hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5"
      aria-label={label}
      title={label}
      disabled={!onClick}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The diagram as Mermaid text on the clipboard, to paste into a README, an issue or a doc. */
function CopyMermaid({ map }: { map: ServiceMap }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(mermaidOf(map, hostLabel)).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <ToolButton label="Copy as Mermaid, for a README or an issue" onClick={copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : "Mermaid"}
    </ToolButton>
  );
}

/** Over the canvas's top-right corner: the Mermaid copy, the zoom, and the whole diagram in view. */
function Toolbar({ map, canvas }: { map: ServiceMap; canvas: Canvas }) {
  return (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
      <div className="flex items-center rounded-md border bg-card shadow-xs">
        <CopyMermaid map={map} />
      </div>
      <div className="flex items-center rounded-md border bg-card shadow-xs">
        <ToolButton label="Zoom out" onClick={canvas.out}>
          <MinusIcon />
        </ToolButton>
        <ToolButton label="Actual size" onClick={canvas.reset}>
          {Math.round((canvas.view?.k ?? 1) * 100)}%
        </ToolButton>
        <ToolButton label="Zoom in" onClick={canvas.in}>
          <PlusIcon />
        </ToolButton>
        <ToolButton label="Fit the map" onClick={canvas.fit}>
          <ScanIcon />
        </ToolButton>
      </div>
    </div>
  );
}

/* ---------- boxes ---------- */

/** Where a box sits: dagre places centres, the box is drawn from its corner. */
function at(placed: Placed<unknown>): CSSProperties {
  return {
    left: placed.x - placed.width / 2,
    top: placed.y - placed.height / 2,
    width: placed.width,
    height: placed.height,
  };
}

/** What the pointer or the focus is on: a box or a line, and where on the canvas its numbers show. */
interface Tip {
  /** A box's id, or a line's key. */
  id: string;
  x: number;
  y: number;
}

interface Hovering {
  hover: string | null;
  onTip: (tip: Tip | null, element?: Element, event?: React.MouseEvent) => void;
}

/** A box's problems, nothing when there are none: its failures, the issues its traces raised. */
function Problems({ failed, issues }: { failed: number; issues: number }) {
  return (
    <>
      {failed ? (
        <Badge variant="error" size="compact" className="ml-auto">
          {failed.toLocaleString()} failed
        </Badge>
      ) : null}
      {issues ? (
        <Badge
          variant="warn"
          size="compact"
          className={cn(!failed && "ml-auto")}
          title={plural(issues, "issue", "issues")}
        >
          <TriangleAlertIcon aria-label="Issues" />
          {issues.toLocaleString()}
        </Badge>
      ) : null}
    </>
  );
}

/**
 * A box: an icon, the name and its problems, what runs it or where; a link to where its calls are listed. Its numbers
 * show on hover and focus.
 */
function Card({
  placed,
  to,
  icon,
  name,
  detail,
  failed,
  issues,
  hovering,
}: {
  placed: Placed<Box>;
  to: string;
  icon: ReactNode;
  name: string;
  detail: string | null;
  failed: number;
  issues: number;
  hovering: Hovering;
}) {
  const id = placed.item.id;
  return (
    <a
      href={to}
      style={at(placed)}
      draggable={false}
      className={cn(
        "absolute flex items-center gap-2 rounded-md border bg-card px-2 text-sm text-foreground no-underline shadow-xs hover:border-input hover:bg-accent",
        failed > 0 && "border-error/40",
      )}
      onMouseMove={(event) => hovering.onTip({ id, x: 0, y: 0 }, undefined, event)}
      onMouseLeave={() => hovering.onTip(null)}
      onFocus={(event) => hovering.onTip({ id, x: 0, y: 0 }, event.currentTarget)}
      onBlur={() => hovering.onTip(null)}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded border bg-muted/60 text-text-2 [&_svg]:size-3.5 [&_.dt-monogram]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium">{name}</span>
          <Problems failed={failed} issues={issues} />
        </span>
        <span className="block truncate font-mono text-xs text-muted-foreground">{detail}</span>
      </span>
    </a>
  );
}

// Where each role's work comes from: requests over the network, a command line or a schedule, people in a browser.
const ENTRY_ICONS: Record<string, LucideIcon> = { web: GlobeIcon, command: TerminalIcon, browser: UsersIcon };

function EntryBox({ placed, label }: { placed: Placed<Box>; label: string }) {
  const Icon = ENTRY_ICONS[placed.item.id.replace(/^entry:/, "")];
  return (
    <span
      style={at(placed)}
      className="absolute flex items-center justify-center gap-1.5 rounded-full border border-dashed bg-card text-xs text-text-2"
    >
      {Icon ? <Icon size={13} aria-hidden="true" className="shrink-0 text-muted-foreground" /> : null}
      {label}
    </span>
  );
}

function RoleBox({ placed, hovering }: { placed: Placed<Box>; hovering: Hovering }) {
  const box = placed.item;
  if (box.type !== "role") return null;
  return (
    <Card
      placed={placed}
      to={href(appTarget(box.app))}
      // A role it didn't name reads "app".
      icon={<AppMark runtime={box.runtime} labelled />}
      name={box.app.role || "app"}
      detail={box.runtime}
      failed={box.app.errors}
      issues={box.app.issues ?? 0}
      hovering={hovering}
    />
  );
}

function HostBox({ placed, host, hovering }: { placed: Placed<Box>; host: Host; hovering: Hovering }) {
  return (
    <Card
      placed={placed}
      to={href(serviceTarget(host.primary))}
      icon={<ServiceIcon node={host.primary} />}
      name={systemName(host.primary)}
      detail={[hostWhere(host), hostUses(host)].filter(Boolean).join(" · ")}
      failed={host.errors}
      issues={0}
      hovering={hovering}
    />
  );
}

function BoxView({ placed, hovering }: { placed: Placed<Box>; hovering: Hovering }) {
  const box = placed.item;
  if (box.type === "entry") return <EntryBox placed={placed} label={box.label} />;
  if (box.type === "role") return <RoleBox placed={placed} hovering={hovering} />;
  return <HostBox placed={placed} host={box.host} hovering={hovering} />;
}

/** A project's frame around its roles, or an AWS region's around its services, its name on the top edge. */
function ProjectFrame({ placed }: { placed: Placed<string> }) {
  return (
    <div style={at(placed)} className="absolute rounded-lg border border-dashed border-input bg-muted/30">
      <span className="absolute top-1 left-2.5 text-xs font-medium text-text-2">{placed.item}</span>
    </div>
  );
}

/* ---------- numbers, on hover ---------- */

/** One line of a box's or a call's numbers: a name, its value, red for failures. */
type Row = [label: string, value: string, tone?: "error" | "warn" | undefined];

function rate(errors: number, count: number): Row {
  if (!errors) return ["Errors", "none"];
  return ["Errors", `${errors.toLocaleString()} · ${percentOf(errors, count)}%`, "error"];
}

/** A share in whole percent, "<1" for less than one. */
function percentOf(part: number, whole: number): string {
  const share = (100 * part) / Math.max(whole, 1);
  return share < 1 ? "<1" : String(Math.round(share));
}

/** What the agent says of a role's traces: how many, how long (p50, p95), how many failed and raised issues. */
function appRows(app: ServiceApp): Row[] {
  return [
    ["Traces", app.traces.toLocaleString()],
    ...latency(app),
    rate(app.errors, app.traces),
    ...(app.issues ? [["Issues", app.issues.toLocaleString(), "warn"] as Row] : []),
  ];
}

/** p50 and p95, from an agent that says them. */
function latency(of: { p50?: number; p95?: number }): Row[] {
  return of.p50 === undefined || of.p95 === undefined
    ? []
    : [
        ["p50", duration(of.p50)],
        ["p95", duration(of.p95)],
      ];
}

/**
 * A server's calls: how many, how long one takes on average, how many failed. The agent keeps each trace's calls to a
 * server summed, not each call's time: an average, not percentiles.
 */
function callRows(calls: number, total: number, errors: number, traces?: number): Row[] {
  return [
    ["Calls", calls.toLocaleString()],
    ...(traces === undefined ? [] : [["In traces", traces.toLocaleString()] as Row]),
    ["Avg per call", duration(Math.round(total / Math.max(calls, 1)))],
    rate(errors, calls),
  ];
}

type Numbers = { title: string; rows: Row[] };

function boxNumbers(box: Box): Numbers | null {
  if (box.type === "role") return { title: `${box.service} · ${box.app.role || "app"}`, rows: appRows(box.app) };
  return box.type === "host" ? hostNumbers(box.host) : null;
}

/** A server's calls; none for a broker the apps only take tasks from. */
function hostNumbers(host: Host): Numbers | null {
  if (host.calls === 0) return null;
  return { title: hostLabel(host), rows: callRows(host.calls, host.total, host.errors) };
}

/** A line's numbers: a role's calls to a server (named as its box is), or the traces another app served. */
function linkNumbers(link: Link, byId: ReadonlyMap<string, Box>): Numbers | null {
  if (link.edge) return edgeNumbers(link, link.edge, byId);
  return link.app ? appLinkNumbers(link.app) : null;
}

function edgeNumbers(link: Link, edge: HostEdge, byId: ReadonlyMap<string, Box>): Numbers {
  const server = [byId.get(link.to), byId.get(link.from)].find((box) => box?.type === "host");
  const name = server?.type === "host" ? systemName(server.host.primary) : edge.peer;
  return {
    title: `${edge.service} ${edge.role} → ${name}`,
    rows: callRows(edge.calls, edge.total, edge.errors, edge.traces),
  };
}

function appLinkNumbers(app: AppLink): Numbers {
  return {
    title: `${app.service} → ${app.to_service}`,
    rows: [["Traces", app.traces.toLocaleString()], ...latency(app), rate(app.errors, app.traces)],
  };
}

/** The numbers of a box or a line, by its id or key. */
function numbersOf(tip: Tip | null, byId: ReadonlyMap<string, Box>, byKey: ReadonlyMap<string, Link>): Numbers | null {
  const id = tip?.id ?? "";
  const box = byId.get(id);
  if (box) return boxNumbers(box);
  const link = byKey.get(id);
  return link ? linkNumbers(link, byId) : null;
}

/** The numbers of what the pointer is on, beside it; kept inside the canvas. */
function TipCard({ tip, numbers, canvas }: { tip: Tip; numbers: Numbers; canvas: Size }) {
  const width = 240;
  const left = tip.x + 14 + width > canvas.width ? Math.max(4, tip.x - 14 - width) : tip.x + 14;
  return (
    <div
      role="tooltip"
      style={{ left, top: Math.min(tip.y + 14, Math.max(4, canvas.height - 150)), width }}
      className="pointer-events-none absolute z-20 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
    >
      <div className="mb-1 truncate font-medium">{numbers.title}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
        {numbers.rows.map(([label, value, tone]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd
              className={cn(
                "text-right tabular-nums",
                tone === "error" && "text-error",
                tone === "warn" && "text-warn",
              )}
            >
              {value}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/* ---------- links ---------- */

function midpoint(a: Point, b: Point): string {
  return `${(a.x + b.x) / 2} ${(a.y + b.y) / 2}`;
}

/** Through dagre's points, softened: a straight start and end, rounded bends between. */
function pathOf(points: readonly Point[]): string {
  const [first, ...rest] = points;
  const last = rest.at(-1);
  if (!first || !last) return "";
  // Side to side: an S from one box's right to the other's left, level where it leaves and where it arrives.
  if (rest.length === 1) {
    const bend = (last.x - first.x) / 2;
    return `M ${first.x} ${first.y} C ${first.x + bend} ${first.y} ${last.x - bend} ${last.y} ${last.x} ${last.y}`;
  }
  const bends = rest
    .slice(0, -1)
    .map((point, index) => `Q ${point.x} ${point.y} ${midpoint(point, rest[index + 1] ?? point)}`);
  return [`M ${first.x} ${first.y}`, ...bends, `L ${last.x} ${last.y}`].join(" ");
}

/** A point on a line about its middle: the S's centre, else its middle bend. */
function middleOf(points: readonly Point[]): Point | null {
  if (points.length === 2) {
    const [a, b] = points as [Point, Point];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  return points[Math.floor(points.length / 2)] ?? null;
}

/** What a link stands for: a role's calls to a server, or the traces another app served for its calls. */
interface Carried {
  count: number;
  errors: number;
  /** Its traces: the role's that called the server, or the ones the other app served. */
  target: Route;
}

function carried(link: Link): Carried | null {
  const { edge, app } = link;
  if (edge) {
    return {
      count: edge.calls,
      errors: edge.errors,
      target: { name: "traces", q: `service:${edge.service} peer:${edge.peer}` },
    };
  }
  if (app) {
    return { count: app.traces, errors: app.errors, target: { name: "traces", q: `service:${app.to_service}` } };
  }
  return null;
}

/** A line's tone: red with failures, the brand's when its box or itself is hovered, else the map's line colour. */
type Tone = "edge" | "error" | "mine";

/** Each tone's stroke, and its arrowhead's fill: the head is the line's colour. */
const TONES: Record<Tone, { stroke: string; head: string }> = {
  edge: { stroke: "stroke-(--map-edge)", head: "fill-(--map-edge)" },
  error: { stroke: "stroke-error/70", head: "fill-error/70" },
  mine: { stroke: "stroke-brand", head: "fill-brand" },
};

function toneOf(link: Link, mine: boolean): Tone {
  if (carried(link)?.errors) return "error";
  return mine ? "mine" : "edge";
}

/** Whether a line is the one hovered or leads to or from the box hovered; null with nothing hovered. */
function mineOf(link: Link, hover: string | null): boolean | null {
  return hover === null ? null : [link.from, link.to, link.key].includes(hover);
}

/** A link's look: its tone, and with a box or another line hovered, faded. */
function linkClass(tone: Tone, mine: boolean | null): string {
  return cn("transition-opacity", TONES[tone].stroke, mine === false && "opacity-15");
}

/** The arrowhead of each tone, by id. */
const arrowOf = (tone: Tone) => `arch-arrow-${tone}`;

function LinkPath({
  link,
  points,
  busiest,
  hovering,
}: {
  link: Link;
  points: Point[];
  busiest: number;
  hovering: Hovering;
}) {
  const d = pathOf(points);
  const what = carried(link);
  const mine = mineOf(link, hovering.hover);
  const tone = toneOf(link, mine === true);
  return (
    <g>
      <path
        d={d}
        fill="none"
        strokeWidth={widthOf(link, busiest)}
        markerEnd={`url(#${arrowOf(tone)})`}
        className={linkClass(tone, mine)}
      />
      {what ? (
        // A wider, invisible twin to point at: its numbers on hover, a link to the call's traces.
        <a
          href={href(what.target)}
          tabIndex={-1}
          className="pointer-events-auto"
          draggable={false}
          onMouseMove={(event) => hovering.onTip({ id: link.key, x: 0, y: 0 }, undefined, event)}
          onMouseLeave={() => hovering.onTip(null)}
        >
          <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
        </a>
      ) : null}
    </g>
  );
}

/** 1px for one call, up to 4px for the busiest: a log scale, so a few calls still show. */
function widthOf(link: Link, busiest: number): number {
  return 1 + (3 * Math.log1p(carried(link)?.count ?? 0)) / Math.log1p(busiest);
}

/** The same arrowhead on every line, however thick (in the diagram's pixels, not the stroke's), in each tone's colour. */
function Arrowheads() {
  return (
    <defs>
      {(Object.keys(TONES) as Tone[]).map((tone) => (
        <marker
          key={tone}
          id={arrowOf(tone)}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="8"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" className={TONES[tone].head} />
        </marker>
      ))}
    </defs>
  );
}

function Links({ diagram, hovering }: { diagram: Diagram; hovering: Hovering }) {
  const busiest = Math.max(...diagram.links.map(({ link }) => carried(link)?.count ?? 0), 1);
  return (
    <svg className="absolute inset-0 overflow-visible" width={diagram.width} height={diagram.height} aria-hidden="true">
      <Arrowheads />
      {/* A halo in the canvas's colour under every line: the dots it crosses don't break it up. */}
      <g className="stroke-(--map-canvas)" data-map="halos">
        {diagram.links.map(({ link, points }) => (
          <path key={link.key} d={pathOf(points)} fill="none" strokeWidth={widthOf(link, busiest) + 4} />
        ))}
      </g>
      {diagram.links.map(({ link, points }) => (
        <LinkPath key={link.key} link={link} points={points} busiest={busiest} hovering={hovering} />
      ))}
    </svg>
  );
}

/** A line's failures and its middle, null for a line with none. */
function failuresOn(link: Link, points: readonly Point[]): { errors: number; middle: Point } | null {
  const errors = carried(link)?.errors;
  const middle = middleOf(points);
  return errors && middle ? { errors, middle } : null;
}

/** A line's failures, on its middle: nothing on a line with none. */
function LinkProblems({ diagram }: { diagram: Diagram }) {
  return (
    <>
      {diagram.links.flatMap(({ link, points }) => {
        const failed = failuresOn(link, points);
        if (!failed) return [];
        const { errors, middle } = failed;
        return [
          <Badge
            key={link.key}
            variant="error"
            size="compact"
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 border border-error/30"
            style={{ left: middle.x, top: middle.y }}
          >
            {errors.toLocaleString()} failed
          </Badge>,
        ];
      })}
    </>
  );
}

/** The canvas's height: the diagram's at actual size, at least a usable map, at most the window less the page's head. */
function canvasHeight(diagram: Diagram): string {
  return `clamp(min(440px, 70dvh), ${Math.ceil(diagram.height + TOP + PAD)}px, calc(100dvh - 15rem))`;
}

/** The dot grid under the diagram: moving with the view, scaled with the zoom, so the map reads as a canvas. */
function dots({ x, y, k }: View): CSSProperties {
  const step = DOTS * k;
  // Small dots, a hairline's size at most: a texture, not a pattern competing with the lines.
  const radius = Math.max(0.5, 0.75 * k);
  return {
    backgroundImage: `radial-gradient(circle, var(--map-dot) ${radius}px, transparent ${radius + 0.5}px)`,
    backgroundSize: `${step}px ${step}px`,
    backgroundPosition: `${x}px ${y}px`,
  };
}

/** Where a tip shows: by the pointer, else (a box with focus) under the box. */
function tipAt(canvas: HTMLElement, element?: Element, event?: React.MouseEvent): Point {
  const box = canvas.getBoundingClientRect();
  if (event) return { x: event.clientX - box.left, y: event.clientY - box.top };
  const of = element?.getBoundingClientRect();
  return of ? { x: of.left - box.left, y: of.bottom - box.top - 10 } : { x: 0, y: 0 };
}

/** What the pointer or the focus is on, and the handler that follows it: nothing while the canvas is dragged. */
function useTip(element: { current: HTMLElement | null }, dragging: boolean) {
  const [tip, setTip] = useState<Tip | null>(null);
  const onTip: Hovering["onTip"] = (next, target, event) => {
    const canvas = element.current;
    setTip(next && canvas && !dragging ? { ...next, ...tipAt(canvas, target, event) } : null);
  };
  const shown = dragging ? null : tip;
  return { tip: shown, hover: shown?.id ?? null, onTip, clear: () => setTip(null) };
}

/**
 * The project's architecture, drawn from its calls: where work comes in, the apps' roles (framed by project), the
 * servers they call by host and port, and an arrow per call between them, laid out left to right in layers so a
 * broker sits between the app that enqueues and the worker that takes. Thicker for more calls, red with failures; a
 * box says only what it is, and its problems when it has any. Hovering a box or a line shows its numbers and brings
 * out its arrows; a line opens its traces, a box where its calls are listed. A canvas: dragged or scrolled to pan,
 * pinched or ctrl+wheeled to zoom. Copies as Mermaid; the table below has the numbers too.
 */
export function ServicesMap({ map }: { map: ServiceMap }) {
  const diagram = useMemo(() => laidOut(map), [map]);
  if (map.apps.length === 0 || map.services.length === 0) return null;
  return <MapCanvas map={map} diagram={diagram} />;
}

function MapCanvas({ map, diagram }: { map: ServiceMap; diagram: Diagram }) {
  const canvas = useView(diagram);
  const element = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const tips = useTip(element, dragging);
  const drag = useDrag(canvas, tips.clear, setDragging);
  const byId = useMemo(() => new Map(diagram.boxes.map((placed) => [placed.item.id, placed.item])), [diagram]);
  const byKey = useMemo(() => new Map(diagram.links.map(({ link }) => [link.key, link])), [diagram]);
  const hovering: Hovering = { hover: tips.hover, onTip: tips.onTip };
  return (
    <section className="mb-6 overflow-hidden rounded-xl border bg-(--map-canvas)" aria-label="Architecture">
      <div
        ref={(node) => {
          element.current = node;
          canvas.ref(node);
        }}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas pans and zooms with the keyboard.
        tabIndex={0}
        aria-label="Map canvas: drag or use the arrow keys to move, + and − to zoom, 0 to fit"
        role="application"
        className={canvasClass(dragging)}
        style={canvasStyle(diagram, canvas.view)}
        {...drag}
        onDragStart={(event) => event.preventDefault()}
        onScroll={(event) => panScrolled(canvas, event.currentTarget)}
        onKeyDown={(event) => onCanvasKey(canvas, event)}
      >
        <Toolbar map={map} canvas={canvas} />
        <Drawing diagram={diagram} view={canvas.view} hovering={hovering} />
        <TipLayer tip={tips.tip} numbers={numbersOf(tips.tip, byId, byKey)} canvas={element.current} />
      </div>
    </section>
  );
}

/** The canvas's look: the hand that grabs it, closed while it drags. */
function canvasClass(dragging: boolean): string {
  return cn(
    "relative touch-none overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50",
    dragging ? "cursor-grabbing" : "cursor-grab",
  );
}

/** The canvas's height, and its dots where the view is. */
function canvasStyle(diagram: Diagram, view: View | null): CSSProperties {
  return { height: canvasHeight(diagram), ...(view ? dots(view) : {}) };
}

/**
 * A box taking focus scrolls the canvas to it (as a click does that the browser scrolls into view): the view pans
 * there instead, and the canvas stays unscrolled, the dots and the tips where they belong.
 */
function panScrolled(canvas: Canvas, element: HTMLElement): void {
  const { scrollLeft, scrollTop } = element;
  if (!(scrollLeft || scrollTop)) return;
  // Both before the next paint: the box stays where the scroll put it.
  flushSync(() => canvas.panBy(-scrollLeft, -scrollTop));
  element.scrollTo(0, 0);
}

/** The diagram where the view puts it: frames, lines, boxes, and the lines' failures over them. */
function Drawing({ diagram, view, hovering }: { diagram: Diagram; view: View | null; hovering: Hovering }) {
  if (!view) return null;
  return (
    <div
      className="absolute top-0 left-0 origin-top-left [&_a]:cursor-pointer"
      data-map="diagram"
      style={{
        width: diagram.width,
        height: diagram.height,
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
      }}
    >
      {diagram.projects.map((placed) => (
        <ProjectFrame key={`${placed.item} ${placed.x}`} placed={placed} />
      ))}
      <Links diagram={diagram} hovering={hovering} />
      {diagram.boxes.map((placed) => (
        <BoxView key={placed.item.id} placed={placed} hovering={hovering} />
      ))}
      <LinkProblems diagram={diagram} />
    </div>
  );
}

/** The tip of what the pointer is on, when it has numbers. */
function TipLayer({ tip, numbers, canvas }: { tip: Tip | null; numbers: Numbers | null; canvas: HTMLElement | null }) {
  if (!(tip && numbers && canvas)) return null;
  return <TipCard tip={tip} numbers={numbers} canvas={{ width: canvas.clientWidth, height: canvas.clientHeight }} />;
}
