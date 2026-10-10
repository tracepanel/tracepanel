import {
  AppWindowIcon,
  CogIcon,
  DatabaseIcon,
  GlobeIcon,
  InboxIcon,
  LayersIcon,
  type LucideIcon,
  MailIcon,
  TerminalIcon,
} from "lucide-react";
import { useState } from "react";
import { duration } from "./format";
import { cn } from "./lib/utils";
import type { ServiceApp, ServiceEdge, ServiceMap, ServiceNode } from "./types";

const SYSTEMS: Record<string, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  oracle: "Oracle",
  redis: "Redis",
  valkey: "Valkey",
  memcached: "Memcached",
  locmem: "Local memory",
  file: "File cache",
  database: "Database cache",
  dummy: "Dummy cache",
  smtp: "SMTP",
  console: "Console",
  filebased: "File",
  rabbitmq: "RabbitMQ",
  sqs: "Amazon SQS",
  memory: "In-memory broker",
  filesystem: "Filesystem broker",
  http: "HTTP",
  https: "HTTPS",
};

const KIND_ICONS: Record<ServiceNode["kind"], LucideIcon> = {
  database: DatabaseIcon,
  cache: LayersIcon,
  mail: MailIcon,
  queue: InboxIcon,
  http: GlobeIcon,
};

const ROLE_ICONS: Record<string, LucideIcon> = { web: AppWindowIcon, worker: CogIcon, command: TerminalIcon };

export const SERVICE_KINDS: Record<ServiceNode["kind"], string> = {
  database: "Database",
  cache: "Cache",
  mail: "Mail",
  queue: "Broker",
  http: "HTTP API",
};

export function systemName(node: ServiceNode): string {
  const name = SYSTEMS[node.system] ?? node.system;
  // A mail backend named like a cache backend (locmem) reads better with its kind.
  return node.kind === "mail" && node.system !== "smtp" ? `${name} mail` : name;
}

/** `db.internal:5432 / blog`, `/run/redis.sock`, or the alias of an in-process cache. */
export function serviceWhere(node: ServiceNode): string {
  const host = node.address ? (node.port ? `${node.address}:${node.port}` : node.address) : "";
  return [host, node.namespace].filter(Boolean).join(" / ") || "in process";
}

function appId(app: { service: string; role: string }): string {
  return `${app.service}:${app.role}`;
}

const WIDTH = 1000;
const ROW = 60;
const GAP = 14;
const PAD = 8;
const LEFT_W = 230;
const RIGHT_X = 620;
const RIGHT_W = WIDTH - RIGHT_X;

function column<T>(items: readonly T[], height: number): { item: T; y: number }[] {
  const used = items.length * ROW + Math.max(items.length - 1, 0) * GAP;
  const top = (height - used) / 2;
  return items.map((item, index) => ({ item, y: top + index * (ROW + GAP) }));
}

/**
 * The project's processes on the left, what they call on the right; line width follows the number of calls.
 * Meant for many services; `linkFor` makes a service box a link.
 */
export function ServiceGraph({ map, linkFor }: { map: ServiceMap; linkFor?: (node: ServiceNode) => string }) {
  const [hover, setHover] = useState<string | null>(null);
  const [edgeHover, setEdgeHover] = useState<{ edge: ServiceEdge; x: number; y: number } | null>(null);
  const rows = Math.max(map.apps.length, map.services.length, 1);
  const height = rows * ROW + (rows - 1) * GAP + PAD * 2;
  const left = column(map.apps, height);
  const right = column(map.services, height);
  const leftY = new Map(left.map(({ item, y }) => [appId(item), y + ROW / 2]));
  const rightY = new Map(right.map(({ item, y }) => [item.id, y + ROW / 2]));
  const busiest = Math.max(...map.edges.map((edge) => edge.calls), 1);
  const touches = (edge: ServiceEdge) => hover === null || hover === edge.peer || hover === appId(edge);

  return (
    <figure className="relative m-0 rounded-lg border bg-card p-5">
      <figcaption className="mb-3 flex items-center justify-between text-[14px] text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground">Service map</span> — line width is the number of calls
        </span>
        <span className="flex items-center gap-4 text-[13px]">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-5 rounded bg-muted-foreground/60" /> calls
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-5 rounded bg-error" /> with errors
          </span>
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="block h-auto w-full"
        role="img"
        aria-label="Which parts of the project call which services"
        onMouseLeave={() => {
          setHover(null);
          setEdgeHover(null);
        }}
        // One handler for the whole map: boxes say which node they are, hover strokes which edge.
        onMouseMove={(event) => {
          const element = event.target instanceof Element ? event.target : null;
          const node = element?.closest("[data-node]")?.getAttribute("data-node") ?? null;
          const edge = Number(element?.closest("[data-edge]")?.getAttribute("data-edge") ?? Number.NaN);
          const box = event.currentTarget.getBoundingClientRect();
          setHover(node);
          const hovered = map.edges[edge];
          setEdgeHover(hovered ? { edge: hovered, x: event.clientX - box.left, y: event.clientY - box.top } : null);
        }}
      >
        <defs>
          <marker
            id="dt-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="9"
            markerHeight="9"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0 L8 4 L0 8 z" className="fill-muted-foreground/70" />
          </marker>
        </defs>
        {map.edges.map((edge, index) => {
          const from = leftY.get(appId(edge));
          const to = rightY.get(edge.peer);
          if (from === undefined || to === undefined) return null;
          const [x1, y1, x2, y2] = edge.direction === "in" ? [RIGHT_X, to, LEFT_W, from] : [LEFT_W, from, RIGHT_X, to];
          const bend = (x2 - x1) / 2;
          const width = 1 + 1.5 * Math.sqrt(edge.calls / busiest);
          const path = `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - Math.sign(x2 - x1) * 4} ${y2}`;
          return (
            <g key={`${appId(edge)}>${edge.peer}>${edge.direction}`} opacity={touches(edge) ? 1 : 0.15}>
              <path
                d={path}
                fill="none"
                strokeWidth={width}
                strokeLinecap="round"
                markerEnd="url(#dt-arrow)"
                className={edge.errors ? "stroke-error/70" : "stroke-muted-foreground/40"}
              />
              {/* A wide invisible stroke: easy to hover. */}
              <path d={path} fill="none" stroke="transparent" strokeWidth={16} data-edge={index} />
            </g>
          );
        })}
        {left.map(({ item, y }) => (
          <AppBox key={appId(item)} app={item} y={y} active={hover === appId(item)} />
        ))}
        {right.map(({ item, y }) => (
          <ServiceBox key={item.id} node={item} y={y} active={hover === item.id} link={linkFor?.(item)} />
        ))}
      </svg>
      {edgeHover ? (
        <EdgeTip
          {...edgeHover}
          name={(() => {
            const node = map.services.find((item) => item.id === edgeHover.edge.peer);
            return node ? systemName(node) : edgeHover.edge.peer;
          })()}
        />
      ) : null}
    </figure>
  );
}

function AppBox({ app, y, active }: { app: ServiceApp; y: number; active: boolean }) {
  const Icon = ROLE_ICONS[app.role] ?? AppWindowIcon;
  return (
    <g transform={`translate(0 ${y})`} data-node={appId(app)}>
      <rect
        width={LEFT_W}
        height={ROW}
        rx={10}
        className={cn("fill-brand-soft stroke-brand/40", active && "stroke-brand")}
        strokeWidth={active ? 2 : 1}
      />
      <Icon x={16} y={ROW / 2 - 10} width={20} height={20} className="text-brand" />
      <text x={46} y={25} className="fill-foreground text-[16px] font-semibold">
        {app.role}
      </text>
      <text x={46} y={44} className="fill-muted-foreground font-mono text-[13px]">
        {app.service}
      </text>
    </g>
  );
}

function ServiceBox({
  node,
  y,
  active,
  link,
}: {
  node: ServiceNode;
  y: number;
  active: boolean;
  link: string | undefined;
}) {
  const Icon = KIND_ICONS[node.kind];
  const label = serviceWhere(node);
  return (
    <a href={link} data-node={node.id}>
      <g transform={`translate(${RIGHT_X} ${y})`}>
        <rect
          width={RIGHT_W}
          height={ROW}
          rx={10}
          className={cn(
            "fill-background stroke-border",
            active && "stroke-brand",
            node.errors > 0 && "stroke-error/60",
          )}
          strokeWidth={active ? 2 : 1}
        />
        <Icon x={16} y={ROW / 2 - 10} width={20} height={20} className="text-muted-foreground" />
        <text x={46} y={25} className="fill-foreground text-[16px] font-semibold">
          {systemName(node)}
        </text>
        <text x={46} y={44} className="fill-muted-foreground font-mono text-[13px]">
          {label.length > 34 ? `${label.slice(0, 33)}…` : label}
        </text>
        <text x={RIGHT_W - 16} y={25} textAnchor="end" className="fill-foreground text-[14px] tabular-nums">
          {node.calls.toLocaleString()} calls
        </text>
        <text x={RIGHT_W - 16} y={44} textAnchor="end" className="fill-muted-foreground text-[13px] tabular-nums">
          {duration(node.total)}
        </text>
      </g>
    </a>
  );
}

function EdgeTip({ edge, x, y, name }: { edge: ServiceEdge; x: number; y: number; name: string }) {
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-[200px] rounded-md border bg-popover px-3 py-2 text-[13px] shadow-md"
      style={{ left: x + 28, top: y + 40 }}
    >
      <p className="mb-1 font-semibold">
        {edge.direction === "in" ? `${edge.role} ← ${name} (takes tasks)` : `${edge.role} → ${name}`}
      </p>
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
        <dt className="text-muted-foreground">{edge.direction === "in" ? "Tasks" : "Calls"}</dt>
        <dd className="m-0 text-right">{edge.calls.toLocaleString()}</dd>
        <dt className="text-muted-foreground">In traces</dt>
        <dd className="m-0 text-right">{edge.traces.toLocaleString()}</dd>
        <dt className="text-muted-foreground">{edge.direction === "in" ? "Queue wait" : "Time"}</dt>
        <dd className="m-0 text-right">{duration(edge.total)}</dd>
        {edge.errors ? (
          <>
            <dt className="text-muted-foreground">Errors</dt>
            <dd className="m-0 text-right font-semibold text-error">{edge.errors}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
