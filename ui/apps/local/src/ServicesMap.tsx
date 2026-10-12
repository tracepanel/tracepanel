import {
  duration,
  RuntimeIcon,
  runtimeKind,
  ServiceIcon,
  type ServiceMap,
  type ServiceNode,
  systemName,
} from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { MinusIcon, PlusIcon } from "lucide-react";
import { type ReactNode, type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";
import { href } from "./routes";
import {
  appTarget,
  byHost,
  byProject,
  type Host,
  type HostEdge,
  hostEdges,
  hostUses,
  hostWhere,
  type Project,
  serviceTarget,
} from "./services";

/** The hosts' groups (by their busiest use), in the order a request reaches them: its data first, then what it hands work to. */
const KIND_GROUPS: readonly { kind: ServiceNode["kind"]; label: string }[] = [
  { kind: "database", label: "Databases" },
  { kind: "cache", label: "Caches" },
  { kind: "queue", label: "Brokers" },
  { kind: "http", label: "HTTP APIs" },
  { kind: "mail", label: "Mail" },
];

const appAnchor = (service: string, role: string) => `app:${service}/${role}`;
const nodeAnchor = (id: string) => `node:${id}`;

/** An edge as drawn: its curve, how thick (by calls), whether any call failed, and the two ends it joins. */
interface Drawn {
  key: string;
  d: string;
  width: number;
  failed: boolean;
  inbound: boolean;
  ends: [string, string];
  title: string;
}

/** From the right of one card to the left of the other, in the map's own (unzoomed) pixels. */
function curve(from: DOMRect, to: DOMRect, box: DOMRect, zoom: number): string {
  const [x1, y1] = [(from.right - box.left) / zoom, (from.top + from.height / 2 - box.top) / zoom];
  const [x2, y2] = [(to.left - box.left) / zoom, (to.top + to.height / 2 - box.top) / zoom];
  const bend = Math.max((x2 - x1) / 2, 24);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function drawn(edge: HostEdge, ends: [Element, Element], box: DOMRect, zoom: number, busiest: number): Drawn {
  const app = appAnchor(edge.service, edge.role);
  return {
    key: `${app} ${edge.host} ${edge.direction}`,
    d: curve(ends[0].getBoundingClientRect(), ends[1].getBoundingClientRect(), box, zoom),
    // 1px for one call, up to 4px for the busiest edge: a log scale, so a few calls still show.
    width: 1 + (3 * Math.log1p(edge.calls)) / Math.log1p(busiest),
    failed: edge.errors > 0,
    inbound: edge.direction === "in",
    ends: [app, nodeAnchor(edge.host)],
    title: `${edge.service} ${edge.role} → ${edge.calls} calls in ${edge.traces} traces, ${duration(edge.total)}`,
  };
}

/** The edges' curves, measured from where the cards are and measured again when the map changes size. */
function useEdges(box: RefObject<HTMLElement | null>, edges: readonly HostEdge[], zoom: number): Drawn[] {
  const [paths, setPaths] = useState<Drawn[]>([]);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const find = (anchor: string) => element.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`);
    const busiest = Math.max(...edges.map((edge) => edge.calls), 1);
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setPaths(
        edges.flatMap((edge) => {
          const from = find(appAnchor(edge.service, edge.role));
          const to = find(nodeAnchor(edge.host));
          return from && to ? [drawn(edge, [from, to], rect, zoom, busiest)] : [];
        }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, edges, zoom]);
  return paths;
}

/** A card on the map, compact: an icon, the name and its numbers, where it runs; a link to where it is listed. */
function Card({
  anchor,
  to,
  icon,
  name,
  detail,
  stats,
  failed,
  onHover,
}: {
  anchor: string;
  to: string;
  icon: ReactNode;
  name: string;
  detail: string | null;
  stats: string;
  failed: boolean;
  onHover: (anchor: string | null) => void;
}) {
  // The full numbers on hover; the card shows the short ones.
  return (
    <a
      href={to}
      data-anchor={anchor}
      className={cn(
        "relative flex items-center gap-2 rounded-md border bg-card px-2 py-1 text-sm text-foreground no-underline shadow-xs hover:border-input hover:bg-accent",
        failed && "border-error/40",
      )}
      onMouseEnter={() => onHover(anchor)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(anchor)}
      onBlur={() => onHover(null)}
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

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function failures(errors: number): string {
  return errors ? ` · ${errors} failed` : "";
}

/** A project, with a card per role it runs as (web, worker, command): the edges start at the roles. */
function AppCards({ app, onHover }: { app: Project; onHover: (anchor: string | null) => void }) {
  const kind = app.runtime ? runtimeKind(app.runtime) : null;
  return (
    <div className="grid gap-1">
      {app.roles.map((role) => (
        <Card
          key={role.role}
          anchor={appAnchor(role.service, role.role)}
          to={href(appTarget(role))}
          icon={kind ? <RuntimeIcon kind={kind} /> : null}
          name={`${role.service} · ${role.role}`}
          detail={app.runtime}
          stats={`${role.traces.toLocaleString()} · ${duration(role.total)}${failures(role.errors)}`}
          failed={role.errors > 0}
          onHover={onHover}
        />
      ))}
    </div>
  );
}

/** A server (or an in-process backend), with how the app uses it when more than one way. */
function HostCard({ host, onHover }: { host: Host; onHover: (anchor: string | null) => void }) {
  return (
    <Card
      anchor={nodeAnchor(host.key)}
      to={href(serviceTarget(host.primary))}
      icon={<ServiceIcon node={host.primary} />}
      name={systemName(host.primary)}
      detail={[hostWhere(host), hostUses(host)].filter(Boolean).join(" · ")}
      stats={`${plural(host.calls, "call", "calls")} · ${duration(host.total)}${failures(host.errors)}`}
      failed={host.errors > 0}
      onHover={onHover}
    />
  );
}

function Column({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("grid min-w-0 content-start gap-1", className)} aria-label={title}>
      <h3 className="px-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** A curve's look: red with failures; with a card hovered, its own in the brand's colour and the rest faded. */
function edgeClass(path: Drawn, hover: string | null): string {
  if (hover === null) return cn("transition-opacity", strokeOf(path, false));
  const mine = path.ends.includes(hover);
  return cn("transition-opacity", strokeOf(path, mine), !mine && "opacity-15");
}

function strokeOf(path: Drawn, mine: boolean): string {
  if (path.failed) return "stroke-error/70";
  return mine ? "stroke-brand" : "stroke-muted-foreground/45";
}

/** The curves between the cards, under them; with a card hovered, its own stand out and the rest fade. */
function Edges({ paths, hover }: { paths: readonly Drawn[]; hover: string | null }) {
  return (
    <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden="true">
      <defs>
        <marker id="services-in" viewBox="0 0 8 8" refX="1" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 8 0 L 0 4 L 8 8 z" className="fill-muted-foreground" />
        </marker>
      </defs>
      {paths.map((path) => (
        <path
          key={path.key}
          d={path.d}
          fill="none"
          strokeWidth={path.width}
          strokeLinecap="round"
          markerStart={path.inbound ? "url(#services-in)" : undefined}
          className={edgeClass(path, hover)}
        >
          <title>{path.title}</title>
        </path>
      ))}
    </svg>
  );
}

const ZOOM_KEY = "tracepanel:map-zoom";
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5];

function storedZoom(): number {
  try {
    const zoom = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOMS.includes(zoom) ? zoom : 1;
  } catch {
    return 1;
  }
}

/** The map's zoom, a step at a time, kept across visits (a big project's map is easier to take in smaller). */
function useZoom() {
  const [zoom, setZoom] = useState(storedZoom);
  const set = (next: number) => {
    setZoom(next);
    try {
      localStorage.setItem(ZOOM_KEY, String(next));
    } catch {
      // Blocked storage: the zoom lasts until the page reloads.
    }
  };
  const at = ZOOMS.indexOf(zoom);
  return {
    zoom,
    out: at > 0 ? () => set(ZOOMS[at - 1] ?? zoom) : undefined,
    in: at < ZOOMS.length - 1 ? () => set(ZOOMS[at + 1] ?? zoom) : undefined,
    reset: () => set(1),
  };
}

function ZoomButton({
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
      className="grid h-6 min-w-6 place-items-center rounded px-1 text-xs text-text-2 tabular-nums hover:bg-accent hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5"
      aria-label={label}
      title={label}
      disabled={!onClick}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ZoomControls({ zoom }: { zoom: ReturnType<typeof useZoom> }) {
  return (
    <div className="flex items-center rounded-md border bg-card shadow-xs">
      <ZoomButton label="Zoom out" onClick={zoom.out}>
        <MinusIcon />
      </ZoomButton>
      <ZoomButton label="Actual size" onClick={zoom.reset}>
        {Math.round(zoom.zoom * 100)}%
      </ZoomButton>
      <ZoomButton label="Zoom in" onClick={zoom.in}>
        <PlusIcon />
      </ZoomButton>
    </div>
  );
}

/**
 * The project's apps on the left, the servers they talk to on the right by kind (one card per host and port, however
 * many ways the app uses it), a curve for each pair: thicker for more calls, red with failures, an arrow into a worker
 * for a broker it takes tasks from. Compact, with a zoom; a card opens where its calls are listed, the table below has
 * the numbers.
 */
export function ServicesMap({ map }: { map: ServiceMap }) {
  const box = useRef<HTMLDivElement>(null);
  const zoom = useZoom();
  const hosts = useMemo(() => byHost(map.services), [map.services]);
  const edges = useMemo(() => hostEdges(map.edges, hosts), [map.edges, hosts]);
  const paths = useEdges(box, edges, zoom.zoom);
  const [hover, setHover] = useState<string | null>(null);
  const columns = KIND_GROUPS.map((group) => ({
    ...group,
    hosts: hosts.filter((one) => one.primary.kind === group.kind),
  })).filter((group) => group.hosts.length > 0);
  if (map.apps.length === 0 || columns.length === 0) return null;
  return (
    <section className="relative mb-6 rounded-xl border bg-muted/20 max-[900px]:hidden" aria-label="Service map">
      <div className="flex justify-end px-3 pt-3">
        <ZoomControls zoom={zoom} />
      </div>
      <div className="max-h-[70vh] overflow-auto px-4 pt-1 pb-4">
        <div
          ref={box}
          className="relative grid grid-cols-[minmax(13rem,18rem)_minmax(4rem,1fr)_minmax(15rem,22rem)] items-start gap-x-3"
          style={{ zoom: zoom.zoom }}
        >
          <Edges paths={paths} hover={hover} />
          {/* Level with the middle of what they call: the curves fan out evenly, up and down. */}
          <Column title="Apps" className="self-center">
            {byProject(map.apps).map((app) => (
              <AppCards key={app.service} app={app} onHover={setHover} />
            ))}
          </Column>
          {/* The gap the curves cross: the cards on either side stay readable. */}
          <span />
          {/* One column, by kind: every curve runs left to right, none crosses a card. */}
          <div className="grid min-w-0 content-start gap-3">
            {columns.map((group) => (
              <Column key={group.kind} title={group.label}>
                {group.hosts.map((one) => (
                  <HostCard key={one.key} host={one} onHover={setHover} />
                ))}
              </Column>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
