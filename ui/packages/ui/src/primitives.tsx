import { type ComponentType, type ReactNode, useLayoutEffect, useRef } from "react";
import { Badge } from "./components/ui/badge";
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
 * consumer's handler), not the package they share. One look wherever a task is named (its lists, its page, a trace's
 * heading, the call tree, search, the panel), whole on hover. Cut here, not by the browser: a name cut by an
 * right-to-left box starts a little right of an uncut one, and a column of names must start at one edge.
 */
export function TaskName({ name, className }: { name: string; className?: string | undefined }) {
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
      className={cn("block min-w-0 overflow-hidden text-left font-mono whitespace-nowrap", className)}
      title={name}
    />
  );
}

/** `name` in `element`, or as much of its end as fits after a "…". Its text is this function's, not React's. */
function startCut(element: HTMLElement, name: string): void {
  // Not laid out (hidden, or not in the page yet): whole, until it has a width.
  if (fits(element, name) || element.clientWidth === 0) return;
  element.textContent = `…${name.slice(afterSeparator(name, fewestDropped(element, name)))}`;
}

/** Where a cut name starts: past a dot right after the "…", so it never reads "….Thumbnail". */
function afterSeparator(name: string, from: number): number {
  let start = from;
  while (start < name.length - 1 && name[start] === ".") start += 1;
  return start;
}

/** Whether `text` fits in `element`'s width, left in it to show. */
function fits(element: HTMLElement, text: string): boolean {
  element.textContent = text;
  return element.scrollWidth <= element.clientWidth;
}

/** The fewest characters dropped from the start of `name` that let the rest fit after a "…". */
function fewestDropped(element: HTMLElement, name: string): number {
  let low = 1;
  let high = name.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (fits(element, `…${name.slice(middle)}`)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Where a status goes, kept when there is none (a task, a job, a view), so the columns after it line up. */
export function StatusSlot({ status }: { status: number | null | undefined }) {
  if (status === null || status === undefined) return <span className="dt-status dt-status-empty" aria-hidden="true" />;
  return <StatusBadge status={status} />;
}
