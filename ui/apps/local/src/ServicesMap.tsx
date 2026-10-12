import {
  duration,
  RuntimeIcon,
  runtimeKind,
  type ServiceEdge,
  ServiceIcon,
  type ServiceMap,
  type ServiceNode,
  serviceWhere,
  systemName,
} from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { href } from "./routes";
import { appTarget, byProject, type Project, serviceTarget } from "./services";

/** The services' groups, in the order a request reaches them: its data first, then what it hands work to. */
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

function curve(from: DOMRect, to: DOMRect, box: DOMRect): string {
  const [x1, y1] = [from.right - box.left, from.top + from.height / 2 - box.top];
  const [x2, y2] = [to.left - box.left, to.top + to.height / 2 - box.top];
  const bend = Math.max((x2 - x1) / 2, 24);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function drawn(edge: ServiceEdge, ends: [Element, Element], box: DOMRect, busiest: number): Drawn {
  const app = appAnchor(edge.service, edge.role);
  return {
    key: `${app} ${edge.peer}`,
    d: curve(ends[0].getBoundingClientRect(), ends[1].getBoundingClientRect(), box),
    // 1px for one call, up to 4px for the busiest edge: a log scale, so a few calls still show.
    width: 1 + (3 * Math.log1p(edge.calls)) / Math.log1p(busiest),
    failed: edge.errors > 0,
    inbound: edge.direction === "in",
    ends: [app, nodeAnchor(edge.peer)],
    title: `${edge.service} ${edge.role} → ${edge.calls} calls in ${edge.traces} traces, ${duration(edge.total)}`,
  };
}

/** The edges' curves, measured from where the cards are and measured again when the map changes size. */
function useEdges(box: RefObject<HTMLElement | null>, edges: readonly ServiceEdge[]): Drawn[] {
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
          const to = find(nodeAnchor(edge.peer));
          return from && to ? [drawn(edge, [from, to], rect, busiest)] : [];
        }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, edges]);
  return paths;
}

/** A card on the map: an icon, the name over where it runs, its numbers; a link to where it is listed. */
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
  return (
    <a
      href={to}
      data-anchor={anchor}
      className={cn(
        "relative flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-foreground no-underline shadow-xs hover:border-input hover:bg-accent",
        failed && "border-error/40",
      )}
      onMouseEnter={() => onHover(anchor)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(anchor)}
      onBlur={() => onHover(null)}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/60 text-text-2 [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{name}</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">{detail}</span>
        <span className={cn("block text-xs text-text-2", failed && "text-error")}>{stats}</span>
      </span>
    </a>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function failures(errors: number): string {
  return errors ? ` · ${plural(errors, "error", "errors")}` : "";
}

/** A project, with a card per role it runs as (web, worker, command): the edges start at the roles. */
function AppCards({ app, onHover }: { app: Project; onHover: (anchor: string | null) => void }) {
  const kind = app.runtime ? runtimeKind(app.runtime) : null;
  return (
    <div className="grid gap-1.5">
      {app.roles.map((role) => (
        <Card
          key={role.role}
          anchor={appAnchor(role.service, role.role)}
          to={href(appTarget(role))}
          icon={kind ? <RuntimeIcon kind={kind} /> : null}
          name={`${role.service} · ${role.role}`}
          detail={app.runtime}
          stats={`${plural(role.traces, "trace", "traces")} · ${duration(role.total)}${failures(role.errors)}`}
          failed={role.errors > 0}
          onHover={onHover}
        />
      ))}
    </div>
  );
}

function NodeCard({ node, onHover }: { node: ServiceNode; onHover: (anchor: string | null) => void }) {
  return (
    <Card
      anchor={nodeAnchor(node.id)}
      to={href(serviceTarget(node))}
      icon={<ServiceIcon node={node} />}
      name={systemName(node)}
      detail={serviceWhere(node)}
      stats={`${plural(node.calls, "call", "calls")} · ${duration(node.total)}${failures(node.errors)}`}
      failed={node.errors > 0}
      onHover={onHover}
    />
  );
}

function Column({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("grid content-start gap-1.5", className)} aria-label={title}>
      <h3 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
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

/**
 * The project's apps on the left, what they talk to on the right by kind, a curve for each pair: thicker for more
 * calls, red with failures, an arrow into a worker for a broker it takes tasks from. A card opens where its calls are
 * listed; the table below has the numbers.
 */
export function ServicesMap({ map }: { map: ServiceMap }) {
  const box = useRef<HTMLElement>(null);
  const paths = useEdges(box, map.edges);
  const [hover, setHover] = useState<string | null>(null);
  const columns = KIND_GROUPS.map((group) => ({
    ...group,
    nodes: map.services.filter((node) => node.kind === group.kind),
  })).filter((group) => group.nodes.length > 0);
  if (map.apps.length === 0 || columns.length === 0) return null;
  return (
    <section
      ref={box}
      className="relative mb-6 grid grid-cols-[minmax(13rem,18rem)_minmax(6rem,1fr)_minmax(14rem,20rem)] items-start gap-x-4 rounded-xl border bg-muted/20 p-5 max-[900px]:hidden"
      aria-label="Service map"
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
      <div className="grid content-start gap-4">
        {columns.map((group) => (
          <Column key={group.kind} title={group.label}>
            {group.nodes.map((node) => (
              <NodeCard key={node.id} node={node} onHover={setHover} />
            ))}
          </Column>
        ))}
      </div>
    </section>
  );
}
