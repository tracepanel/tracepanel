import { duration, RuntimeIcon, runtimeKind, ServiceIcon, type ServiceMap, systemName } from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import {
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  type LucideIcon,
  MinusIcon,
  PlusIcon,
  TerminalIcon,
  UsersIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useMemo, useState } from "react";
import { type Box, type Diagram, type Link, laidOut, mermaidOf, type Placed, type Point } from "./architecture";
import { href, type Route } from "./routes";
import { appTarget, type Host, hostUses, hostWhere, serviceTarget } from "./services";

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function failures(errors: number): string {
  return errors ? ` · ${errors} failed` : "";
}

/** A host's name on the diagram and in the Mermaid text: what runs there, where, and how the app uses it. */
function hostLabel(host: Host): string {
  return [systemName(host.primary), hostWhere(host), hostUses(host)].filter(Boolean).join(" · ");
}

/* ---------- zoom ---------- */

const ZOOM_KEY = "tracepanel:map-zoom";
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5];

/** The zoom chosen on an earlier visit, or null: none chosen yet. */
function storedZoom(): number | null {
  try {
    const zoom = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOMS.includes(zoom) ? zoom : null;
  } catch {
    return null;
  }
}

/** The largest step, at most actual size, at which a diagram this wide fits the space it has. */
function fitting(width: number, available: number): number {
  const most = available > 0 ? Math.min(available / width, 1) : 1;
  return ZOOMS.filter((zoom) => zoom <= most).at(-1) ?? ZOOMS[0] ?? 1;
}

/** The width of the element the callback ref is set on, as it changes. */
function useWidth(): [number, (element: HTMLElement | null) => (() => void) | undefined] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [width, ref];
}

/**
 * The diagram's zoom, a step at a time, kept across visits (a big project's diagram is easier to take in smaller).
 * Until one is chosen, the diagram fits the width it has.
 */
function useZoom(fit: number) {
  const [chosen, setZoom] = useState(storedZoom);
  const zoom = chosen ?? fit;
  const set = (next: number) => {
    setZoom(next);
    try {
      localStorage.setItem(ZOOM_KEY, String(next));
    } catch {
      // Blocked storage: the zoom lasts until the page reloads.
    }
  };
  const step = ZOOMS.indexOf(zoom);
  return {
    zoom,
    out: step > 0 ? () => set(ZOOMS[step - 1] ?? zoom) : undefined,
    in: step < ZOOMS.length - 1 ? () => set(ZOOMS[step + 1] ?? zoom) : undefined,
    reset: () => set(1),
  };
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

function Toolbar({ map, zoom }: { map: ServiceMap; zoom: ReturnType<typeof useZoom> }) {
  return (
    <div className="flex items-center justify-end gap-2 px-3 pt-3">
      <div className="flex items-center rounded-md border bg-card shadow-xs">
        <CopyMermaid map={map} />
      </div>
      <div className="flex items-center rounded-md border bg-card shadow-xs">
        <ToolButton label="Zoom out" onClick={zoom.out}>
          <MinusIcon />
        </ToolButton>
        <ToolButton label="Actual size" onClick={zoom.reset}>
          {Math.round(zoom.zoom * 100)}%
        </ToolButton>
        <ToolButton label="Zoom in" onClick={zoom.in}>
          <PlusIcon />
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

interface Hovering {
  hover: string | null;
  onHover: (id: string | null) => void;
}

/** A box: an icon, the name and its numbers, a second line; a link to where its calls are listed. */
function Card({
  placed,
  to,
  icon,
  name,
  detail,
  stats,
  failed,
  hovering,
}: {
  placed: Placed<Box>;
  to: string;
  icon: ReactNode;
  name: string;
  detail: string | null;
  stats: string;
  failed: boolean;
  hovering: Hovering;
}) {
  const id = placed.item.id;
  return (
    <a
      href={to}
      style={at(placed)}
      className={cn(
        "absolute flex items-center gap-2 rounded-md border bg-card px-2 text-sm text-foreground no-underline shadow-xs hover:border-input hover:bg-accent",
        failed && "border-error/40",
      )}
      onMouseEnter={() => hovering.onHover(id)}
      onMouseLeave={() => hovering.onHover(null)}
      onFocus={() => hovering.onHover(id)}
      onBlur={() => hovering.onHover(null)}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded border bg-muted/60 text-text-2 [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate font-medium">{name}</span>
          <span className={cn("ml-auto shrink-0 text-xs text-text-2 tabular-nums", failed && "text-error")}>
            {stats}
          </span>
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
  const kind = box.runtime ? runtimeKind(box.runtime) : null;
  return (
    <Card
      placed={placed}
      to={href(appTarget(box.app))}
      icon={kind ? <RuntimeIcon kind={kind} /> : null}
      name={box.app.role}
      detail={box.runtime}
      stats={`${plural(box.app.traces, "trace", "traces")} · ${duration(box.app.total)}${failures(box.app.errors)}`}
      failed={box.app.errors > 0}
      hovering={hovering}
    />
  );
}

/** A server's calls and their time; nothing for a broker the apps only take tasks from. */
function hostStats(host: Host): string {
  if (host.calls === 0) return "";
  return `${plural(host.calls, "call", "calls")} · ${duration(host.total)}${failures(host.errors)}`;
}

function HostBox({ placed, host, hovering }: { placed: Placed<Box>; host: Host; hovering: Hovering }) {
  return (
    <Card
      placed={placed}
      to={href(serviceTarget(host.primary))}
      icon={<ServiceIcon node={host.primary} />}
      name={systemName(host.primary)}
      detail={[hostWhere(host), hostUses(host)].filter(Boolean).join(" · ")}
      stats={hostStats(host)}
      failed={host.errors > 0}
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

/** A project's frame around its roles, its name on the top edge. */
function ProjectFrame({ placed }: { placed: Placed<string> }) {
  return (
    <div style={at(placed)} className="absolute rounded-lg border border-dashed border-input bg-muted/30">
      <span className="absolute top-1 left-2.5 text-xs font-medium text-text-2">{placed.item}</span>
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
  const bends = rest
    .slice(0, -1)
    .map((point, index) => `Q ${point.x} ${point.y} ${midpoint(point, rest[index + 1] ?? point)}`);
  return [`M ${first.x} ${first.y}`, ...bends, `L ${last.x} ${last.y}`].join(" ");
}

/** What a link stands for: a role's calls to a server, or the traces another app served for its calls. */
interface Carried {
  count: number;
  errors: number;
  title: string;
  /** Its traces: the role's that called the server, or the ones the other app served. */
  target: Route;
}

function carried(link: Link): Carried | null {
  const { edge, app } = link;
  if (edge) {
    return {
      count: edge.calls,
      errors: edge.errors,
      title: `${edge.service} ${edge.role}: ${plural(edge.calls, "call", "calls")} in ${plural(edge.traces, "trace", "traces")}, ${duration(edge.total)}${failures(edge.errors)}. Click for the traces.`,
      target: { name: "traces", q: `service:${edge.service} peer:${edge.peer}` },
    };
  }
  if (app) {
    return {
      count: app.traces,
      errors: app.errors,
      title: `${app.service} → ${app.to_service}: ${plural(app.traces, "trace", "traces")} served, ${duration(app.total)}${failures(app.errors)}. Click for them.`,
      target: { name: "traces", q: `service:${app.to_service}` },
    };
  }
  return null;
}

function strokeOf(link: Link, mine: boolean): string {
  if (carried(link)?.errors) return "stroke-error/70";
  return mine ? "stroke-brand" : "stroke-muted-foreground/50";
}

/** A link's look: red with failures; with a box hovered, its own in the brand's colour and the rest faded. */
function linkClass(link: Link, hover: string | null): string {
  if (hover === null) return cn("transition-opacity", strokeOf(link, false));
  const mine = link.from === hover || link.to === hover;
  return cn("transition-opacity", strokeOf(link, mine), !mine && "opacity-15");
}

function LinkPath({
  link,
  points,
  busiest,
  hover,
}: {
  link: Link;
  points: Point[];
  busiest: number;
  hover: string | null;
}) {
  const d = pathOf(points);
  const what = carried(link);
  // 1px for one call, up to 4px for the busiest: a log scale, so a few calls still show.
  const width = 1 + (3 * Math.log1p(what?.count ?? 0)) / Math.log1p(busiest);
  return (
    <g>
      <path d={d} fill="none" strokeWidth={width} markerEnd="url(#arch-arrow)" className={linkClass(link, hover)} />
      {what ? (
        // A wider, invisible twin to point at: a link to the call's traces.
        <a href={href(what.target)} tabIndex={-1} className="pointer-events-auto">
          <path d={d} fill="none" stroke="transparent" strokeWidth={12}>
            <title>{what.title}</title>
          </path>
        </a>
      ) : null}
    </g>
  );
}

function Links({ diagram, hover }: { diagram: Diagram; hover: string | null }) {
  const busiest = Math.max(...diagram.links.map(({ link }) => carried(link)?.count ?? 0), 1);
  return (
    <svg className="absolute inset-0 overflow-visible" width={diagram.width} height={diagram.height} aria-hidden="true">
      <defs>
        {/* The same arrowhead on every line, however thick: in the diagram's pixels, not the stroke's. */}
        <marker
          id="arch-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="8"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground" />
        </marker>
      </defs>
      {diagram.links.map(({ link, points }) => (
        <LinkPath key={link.key} link={link} points={points} busiest={busiest} hover={hover} />
      ))}
    </svg>
  );
}

/**
 * The project's architecture, drawn from its calls: where work comes in, the apps' roles (framed by project), the
 * servers they call by host and port, and an arrow per call between them, laid out left to right in layers so a
 * broker sits between the app that enqueues and the worker that takes. Thicker for more calls, red with failures;
 * hovering a box brings out its arrows, an arrow opens its traces, a box where its calls are listed. Copies as
 * Mermaid; the table below has the numbers.
 */
export function ServicesMap({ map }: { map: ServiceMap }) {
  const diagram = useMemo(() => laidOut(map), [map]);
  const [available, measured] = useWidth();
  const zoom = useZoom(fitting(diagram.width, available));
  const [hover, setHover] = useState<string | null>(null);
  if (map.apps.length === 0 || map.services.length === 0) return null;
  return (
    <section className="mb-6 rounded-xl border bg-muted/20 max-[900px]:hidden" aria-label="Architecture">
      <Toolbar map={map} zoom={zoom} />
      <div ref={measured} className="overflow-x-auto px-4 pt-1 pb-4">
        <div className="relative mx-auto" style={{ width: diagram.width, height: diagram.height, zoom: zoom.zoom }}>
          {diagram.projects.map((placed) => (
            <ProjectFrame key={placed.item} placed={placed} />
          ))}
          <Links diagram={diagram} hover={hover} />
          {diagram.boxes.map((placed) => (
            <BoxView key={placed.item.id} placed={placed} hovering={{ hover, onHover: setHover }} />
          ))}
        </div>
      </div>
    </section>
  );
}
