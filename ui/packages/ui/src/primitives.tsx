import { ArrowRightIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useLayoutEffect, useRef } from "react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { ISSUE_LABELS } from "./labels";
import { templatePlace } from "./lib/callFields";
import { runtimeKind } from "./lib/runtime";
import { cn } from "./lib/utils";
import { RuntimeIcon } from "./RuntimeIcon";
import type { IssueKind } from "./types";

/**
 * The request's method, and `hx` when htmx sent it: one badge wherever a request is shown (lists, the trace's
 * header, search, logs, emails), so an htmx request looks the same everywhere.
 */
export function MethodBadge({
  method,
  htmx,
}: {
  method: string | null | undefined;
  htmx?: "request" | "boosted" | null | undefined;
}) {
  const value = (method ?? "GET").toUpperCase();
  const badge = (
    <span className="dt-method" data-method={value}>
      {value}
    </span>
  );
  if (!htmx) return badge;
  return (
    <span className="dt-method-group" title={htmx === "boosted" ? "Sent by htmx (a boosted page)" : "Sent by htmx"}>
      {badge}
      <span className="dt-htmx">hx</span>
    </span>
  );
}

export function StatusBadge({ status }: { status: number | null | undefined }) {
  if (status === null || status === undefined) return null;
  const tone = status >= 500 ? "error" : status >= 400 ? "warn" : status >= 300 ? "info" : "ok";
  return (
    <span className="dt-status" data-tone={tone}>
      {status}
    </span>
  );
}

/** An issue chip that gives way last in a row too narrow for it, cut with an ellipsis. */
export const ISSUE_CHIP_SHRINKS = "min-w-0 shrink justify-start";

export function IssueChip({
  kind,
  count,
  className,
}: {
  kind: IssueKind;
  count?: number | undefined;
  /** `ISSUE_CHIP_SHRINKS` in a row too narrow for it: cut with an ellipsis, not past the row's edge. */
  className?: string | undefined;
}) {
  return (
    <Badge variant={kind === "error" ? "error" : "warn"} size="compact" data-kind={kind} className={className}>
      <span className="truncate">{ISSUE_LABELS[kind]}</span>
      {count !== undefined && count > 1 ? <span className="opacity-75">{count}</span> : null}
    </Badge>
  );
}

/**
 * How many times a call repeated, beside its name wherever repeats fold into one row: the call tree, a trace's DB,
 * Cache and HTTP calls tabs. Nothing for a call made once.
 */
export function Times({ count }: { count: number }) {
  if (count <= 1) return null;
  return <span className="dt-map-times">×{count}</span>;
}

/** Database or cache alias, shown only when it is not "default". */
export function AliasChip({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === "" || value === "default") return null;
  return (
    <span className="dt-alias" title={String(value)}>
      {String(value)}
    </span>
  );
}

/**
 * A query a template made as it rendered (a lazy QuerySet in a {% for %}, a related object it read): the template and
 * its line. One chip wherever queries are listed: the SQL tab, the call tree.
 */
export function TemplateChip({ attrs }: { attrs: Readonly<Record<string, unknown>> }) {
  const place = templatePlace(attrs);
  if (!place) return null;
  return (
    <span className="dt-from-template" title={`From the template ${place}: it ran as the template rendered`}>
      <span className="dt-from-template-label">template</span> {place}
    </span>
  );
}

/** Route patterns like /posts/<int:pk>/ with the parameter parts dimmed. */
export function RoutePath({ path }: { path: string }) {
  const parts = path.split(/(<[^>]+>)/g).filter(Boolean);
  return (
    <span className="dt-path">
      {parts.map((part, index) =>
        part.startsWith("<") ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one string never reorder.
          <span key={index} className="dt-path-param">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}

/**
 * A request's path in a row short of room: cut in its middle, never at its end. Its head gives way first
 * ("/api/cat…/trail-runner-gtx"), its last segment stays whole, all of it in the tooltip. Under a run of one route
 * (`shared`, that route), the part the run's paths share is quiet and what tells them apart stands out ("/authors" then
 * "/7"); with no room, "…/7". Whatever follows the path (`children`, what sent an htmx request) gives way before it.
 */
export function TailPath({
  path,
  shared,
  params,
  title = path,
  children,
}: {
  path: string;
  shared?: string | null | undefined;
  /** A route pattern: its parameters dimmed, as RoutePath has them. */
  params?: boolean | undefined;
  title?: string | undefined;
  children?: ReactNode;
}) {
  const [head, tail] = splitPath(path, shared);
  const text = (part: string) => (params ? <RoutePath path={part} /> : part);
  return (
    <span className="dt-request-path" data-split="" data-shared={shared ? "" : undefined} title={title}>
      {head ? <span className="dt-path-head">{text(head)}</span> : null}
      <span className="dt-path-tail">{text(tail)}</span>
      {children}
    </span>
  );
}

/**
 * A path's head and its tail: what follows the segments it shares with `shared` (a run's route: "/authors" and "/7"
 * of "/authors/7" under "/authors/{author_id}"), else its last segment ("/trail-runner-gtx"), a trailing slash and a
 * query string with it. A path of one segment is all tail.
 */
function splitPath(path: string, shared: string | null | undefined): [string, string] {
  if (shared) {
    const mine = path.split("/");
    const theirs = shared.split("/");
    let same = 0;
    while (same < mine.length - 1 && mine[same] === theirs[same]) same += 1;
    if (same > 1) return [mine.slice(0, same).join("/"), `/${mine.slice(same).join("/")}`];
  }
  const query = path.indexOf("?");
  const cut = path
    .slice(0, query === -1 ? path.length : query)
    .replace(/\/+$/, "")
    .lastIndexOf("/");
  return cut > 0 ? [path.slice(0, cut), path.slice(cut)] : ["", path];
}

/** Renders `code` spans in hint text written with backticks. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("`") ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one string never reorder.
          <code key={index}>{part.slice(1, -1)}</code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * Nothing to show, one look everywhere: a section's first empty state, a search that matches nothing, a trace or an
 * issue that isn't stored. `icon` in a tile above the title; `action` is the way on, a button, so an empty page is
 * never a dead end; `page` takes the page's room, its state in the middle.
 */
export function Empty({
  title,
  children,
  action,
  icon: Icon,
  page = false,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ComponentType<{ className?: string }> | undefined;
  page?: boolean;
}) {
  return (
    <div className="dt-empty" data-page={page ? "" : undefined}>
      <EmptyIcon icon={Icon} />
      <p className="dt-empty-title">{title}</p>
      {children ? <p className="dt-empty-text">{children}</p> : null}
      {action ? <p className="dt-empty-action">{action}</p> : null}
    </div>
  );
}

/** An empty state's icon in its tile, when it has one. */
function EmptyIcon({ icon: Icon }: { icon: ComponentType<{ className?: string }> | undefined }) {
  if (!Icon) return null;
  return (
    <span className="dt-empty-icon">
      <Icon className="size-6" />
    </span>
  );
}

/**
 * The actions under an open row or a finding, one footer everywhere (a log record, an email, a query, an issue): its
 * own buttons first, then the way to the trace it came from, an outlined button with its arrow at the right end.
 */
export function DetailsFooter({
  children,
  open,
  rule = true,
}: {
  children?: ReactNode;
  /** The trace's link: its words ("Open request") and the anchor's props. */
  open?: { label: string; link: { href: string; target?: string; rel?: string } } | undefined;
  /** A hairline above it, under a row's details; none inside a card. */
  rule?: boolean;
}) {
  return (
    <div className="dt-details-footer" data-rule={rule ? "" : undefined}>
      {children}
      {open ? (
        <Button variant="outline" size="sm" className="ml-auto" asChild>
          <a {...open.link}>
            {open.label}
            <ArrowRightIcon />
          </a>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Where something is still loading, its shape: a muted block the size of what comes (a title, a tab, a row), so the
 * page has its layout at once and nothing moves when it arrives.
 */
export function Skeleton({
  width,
  height = "0.875rem",
  className,
}: {
  width: string;
  height?: string;
  className?: string;
}) {
  return <span className={cn("dt-skeleton", className)} style={{ width, height }} aria-hidden="true" />;
}

/** A section's heading wherever a trace's details are shown: its info tab and the call tree's pane. */
export function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="m-0 text-sm font-medium text-foreground">{children}</h3>;
}

// A trace's kind in the word its badge shows: a job, a WebSocket, a GraphQL operation in short.
const KIND_WORDS: Record<string, string> = { command: "job", websocket: "ws", graphql: "gql" };
const KINDS = new Set(["task", "job", "ws", "gql", "rpc", "page"]);

/**
 * What a trace is where a request shows its method: a task, a job, a WebSocket, a GraphQL operation. One badge
 * wherever a trace is named (lists, its header, related traces, the call tree, search, the panel), the method's own
 * shape in the brand's colour. `muted`: what a call is in the call tree (a view, a query, a task enqueued), the same
 * shape, quiet, so the traces it links to stand out among its calls.
 */
export function KindBadge({
  kind,
  muted = false,
  className,
}: {
  kind: string;
  muted?: boolean | undefined;
  className?: string | undefined;
}) {
  // A call's kind is its own word (a span may be a "command"); a trace's in short.
  const word = muted ? kind : shortKind(kind);
  return (
    <span className={cn("dt-kind", className)} data-muted={muted ? "" : undefined}>
      {word}
    </span>
  );
}

/**
 * A label in a muted KindBadge's shape and colour, in its own case: a worker in Tasks' Now, with what it does. A label,
 * not a button.
 */
export function NeutralTag({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <span className={cn("dt-kind normal-case", className)} data-muted="" title={title}>
      {children}
    </span>
  );
}

/** A trace's badge from its word: a method (GET, CLICK) as a method, a kind (TASK, JOB, WS, GQL) as a kind. */
export function TraceBadge({ word, htmx }: { word: string | null | undefined; htmx?: "request" | "boosted" | null }) {
  const kind = shortKind(String(word ?? ""));
  return KINDS.has(kind) ? <KindBadge kind={kind} /> : <MethodBadge method={word} htmx={htmx} />;
}

/** A trace's kind in its badge's word: command -> job, TASK -> task. */
function shortKind(kind: string): string {
  const lower = kind.toLowerCase();
  return KIND_WORDS[lower] ?? lower;
}

// A task's state in its tone: done, failed, retried; in flight (Tasks' Now) running or waiting in its queue.
const STATE_TONES: Record<string, string> = {
  success: "ok",
  failure: "error",
  failed: "error",
  retry: "warn",
  retrying: "warn",
  running: "brand",
  queued: "neutral",
  skipped: "info",
};

/**
 * How a task run ended (success, failure, retry) or where one in flight is (running, queued): one badge wherever a
 * task's state shows (lists, its header and facts, related traces, the call tree, Now), a request's status's shape.
 */
export function StateBadge({ state }: { state: string }) {
  const shown = state.toLowerCase();
  return (
    <span className="dt-status" data-tone={STATE_TONES[shown] ?? "neutral"}>
      {shown}
    </span>
  );
}

/**
 * The app that served something: its runtime's mark when known, and its name. The same chip names the app of a call's
 * trace in the call tree and of a request in a list that holds several apps.
 */
export function AppChip({ name, runtime }: { name: string; runtime?: string | undefined }) {
  const kind = runtime ? runtimeKind(runtime) : null;
  return (
    <span className="dt-app-chip" title={runtime ? `${name} · ${runtime}` : name}>
      {kind ? <RuntimeIcon kind={kind} /> : null}
      {name}
    </span>
  );
}

/**
 * A task's name, cut at its start when it doesn't fit: what tells tasks apart is at its end (the function, the
 * consumer's handler), not the package they share. Whole segments go first ("…handlers.build_sales_report", then
 * "…build_sales_report"); where not even its last one fits, that one is cut at its end, so what is left still reads
 * as its name ("build_sales_re…"), never as a tail of it. One look wherever a task is named (its lists, its page, a
 * trace's heading, the call tree, search, the panel), whole on hover unless a tooltip of its own says more (`title`
 * false). Cut here, not by the browser: a name cut by an right-to-left box starts a little right of an uncut one, and
 * a column of names must start at one edge.
 */
export function TaskName({
  name,
  className,
  title = true,
}: {
  name: string;
  className?: string | undefined;
  title?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => startCut(element, name);
    fit();
    // Its room changes with its own box or its row's, and once the fonts have loaded.
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [name]);
  return (
    <span
      ref={ref}
      className={cn("block min-w-0 overflow-hidden text-left font-mono text-ellipsis whitespace-nowrap", className)}
      title={title ? name : undefined}
    />
  );
}

/** `name` in `element`, or the most of its end that fits, in whole segments after a "…"; else its last, cut. */
function startCut(element: HTMLElement, name: string): void {
  // Not laid out (hidden, or not in the page yet): whole, until it has a width.
  if (fits(element, name) || element.clientWidth === 0) return;
  const fitting = segmentStarts(name).some((start) => fits(element, `…${name.slice(start)}`));
  // Not even the last segment: it, cut at its end by the browser's ellipsis.
  if (!fitting) element.textContent = lastSegment(name);
}

/** "build_sales_report" of "app.handlers.build_sales_report". */
function lastSegment(name: string): string {
  return name.slice(segmentStarts(name).at(-1) ?? 0);
}

/** A segment after the first: past a module's dots, a path's slashes, a handler's colons, a space. */
const SEGMENT = /(?<=[.:/\s·])[^.:/\s·]/g;

/** Where each segment after the first starts, longest tail first: "a.b.c" → [2, 4]. */
function segmentStarts(name: string): number[] {
  return [...name.matchAll(SEGMENT)].map((match) => match.index);
}

/** Whether `text` fits in `element`'s width, left in it to show. */
function fits(element: HTMLElement, text: string): boolean {
  element.textContent = text;
  return element.scrollWidth <= element.clientWidth;
}

/** Where a status goes, kept when there is none (a task, a job, a view), so the columns after it line up. */
export function StatusSlot({ status }: { status: number | null | undefined }) {
  if (status === null || status === undefined) return <span className="dt-status dt-status-empty" aria-hidden="true" />;
  return <StatusBadge status={status} />;
}
