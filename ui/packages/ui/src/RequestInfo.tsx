import type { ReactNode } from "react";
import { Badge } from "./components/ui/badge";
import { FactGrid } from "./FactGrid";
import { duration } from "./format";
import { GraphqlCode } from "./GraphqlCode";
import { handlerFullName, handlerWord } from "./lib/handler";
import { traceRuntime } from "./lib/runtime";
import { linkProps, type TraceLinks } from "./links";
import { type PropRow, PropTable } from "./PropTable";
import { MethodBadge, RoutePath, StatusBadge } from "./primitives";
import { isRequestDetail, RequestParts, requestParts } from "./RequestParts";
import type { Attrs, Related, Trace, TraceSummary } from "./types";

function text(value: unknown): string | null {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function userRows(attrs: Attrs): PropRow[] {
  if (!("user.id" in attrs)) return [];
  const id = text(attrs["user.id"]);
  if (!id) return [{ label: "User", value: <span className="text-muted-foreground">anonymous</span> }];
  const username = text(attrs["user.username"]);
  const roles = [attrs["user.is_superuser"] ? "Superuser" : null, attrs["user.is_staff"] ? "Staff" : null].filter(
    (role): role is string => role !== null,
  );
  return [
    { label: "User ID", value: id, copy: id, mono: true },
    ...(username ? [{ label: "Username", value: username, copy: username, mono: true }] : []),
    {
      label: "Role",
      value: roles.length ? (
        <span className="flex gap-1.5">
          {roles.map((role) => (
            <Badge key={role} variant="outline" className="border-brand/30 bg-brand-soft text-brand">
              {role}
            </Badge>
          ))}
        </span>
      ) : (
        <span className="text-muted-foreground">regular user</span>
      ),
    },
  ];
}

/** What ran the trace: "Python 3.12.3 (cpython) · Django 6.0.1", "Go 1.27.1 · net/http". */
/** "501 spans": a count with its noun, when there is any. */
function counted(value: unknown, noun: string): string[] {
  const count = Number(value ?? 0);
  return count > 0 ? [`${count} ${noun}${count === 1 ? "" : "s"}`] : [];
}

/** What went unrecorded, over the SDK's or the agent's limits: the call tree and logs show the rest. */
function droppedRows(attrs: Attrs): PropRow[] {
  const parts = [
    ...counted(attrs["tracepanel.dropped_spans"], "span"),
    ...counted(attrs["tracepanel.dropped_logs"], "log record"),
  ];
  if (parts.length === 0) return [];
  return [
    {
      label: "Not recorded",
      value: <span className="text-warn">{parts.join(" and ")}: over the limit of one trace</span>,
    },
  ];
}

/** A gap between clocks, roughly: 40 s, 12 min, 2.0 h. */
function roughly(us: number): string {
  const seconds = us / 1_000_000;
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

// How far the app's clock may be from this machine's before it is called out: past what sending takes.
const AHEAD_US = 10_000_000;
const BEHIND_US = 60_000_000;

/**
 * How far the app's clock is off this machine's (µs, ahead above zero), when it is: the trace ended (by the app's
 * clock) after the agent had it, or long before. Times across apps then don't line up, nor does `since:`.
 */
function clockOff(trace: Trace): number | null {
  if (typeof trace.received !== "number") return null;
  const off = trace.start + trace.duration - trace.received;
  return off > AHEAD_US || off < -BEHIND_US ? off : null;
}

function ClockNote({ off }: { off: number }) {
  return (
    <span className="text-warn">
      The app's clock is about {roughly(Math.abs(off))} {off > 0 ? "ahead of" : "behind"} this machine's
      {off > 0 ? "" : ", or it sent the trace that late"}
    </span>
  );
}

function clockRows(trace: Trace): PropRow[] {
  const off = clockOff(trace);
  return off === null ? [] : [{ label: "Clock", value: <ClockNote off={off} /> }];
}

/** The app that recorded it, a link to its page (its settings and versions) where there is one. */
function appRows(attrs: Attrs, links: TraceLinks | undefined): PropRow[] {
  const service = text(attrs["service.name"]);
  if (!service) return [];
  const value = links?.app ? (
    <a className="text-brand hover:underline" {...linkProps(links, links.app(service))}>
      {service}
    </a>
  ) : (
    service
  );
  return [{ label: "App", value, copy: service, mono: true }];
}

function runtimeRows(attrs: Attrs): PropRow[] {
  const value = traceRuntime(attrs, true);
  return value ? [{ label: "Runtime", value, copy: value }] : [];
}

/** HX-* response headers, in the order htmx applies them. */
const HTMX_RESPONSE: [string, string][] = [
  ["htmx.response.redirect", "HX-Redirect"],
  ["htmx.response.location", "HX-Location"],
  ["htmx.response.refresh", "HX-Refresh"],
  ["htmx.response.push_url", "HX-Push-Url"],
  ["htmx.response.replace_url", "HX-Replace-Url"],
  ["htmx.response.retarget", "HX-Retarget"],
  ["htmx.response.reselect", "HX-Reselect"],
  ["htmx.response.reswap", "HX-Reswap"],
  ["htmx.response.trigger", "HX-Trigger"],
  ["htmx.response.trigger_after_swap", "HX-Trigger-After-Swap"],
  ["htmx.response.trigger_after_settle", "HX-Trigger-After-Settle"],
];

/** A request htmx sent: what sent it, where the answer goes, and what the server told htmx. */
function htmxRows(attrs: Attrs): PropRow[] {
  if (!attrs["htmx.request"]) return [];
  const trigger = text(attrs["htmx.trigger_name"]) ?? text(attrs["htmx.trigger"]);
  const target = text(attrs["htmx.target"]);
  const from = text(attrs["htmx.current_url"]);
  const kind = attrs["htmx.boosted"] ? "Boosted page" : attrs["htmx.history_restore"] ? "History restore" : "Request";
  const rows: PropRow[] = [{ label: "htmx", heading: true, value: kind }];
  if (trigger) rows.push({ label: "Trigger", id: "htmx-trigger", value: `#${trigger}`, copy: trigger, mono: true });
  if (target) rows.push({ label: "Target", id: "htmx-target", value: `#${target}`, copy: target, mono: true });
  if (from) rows.push({ label: "From page", id: "htmx-from", value: from, copy: from, mono: true });
  for (const [key, header] of HTMX_RESPONSE) {
    const value = text(attrs[key]);
    if (value) rows.push({ label: header, id: key, value, copy: value, mono: true });
  }
  return rows;
}

const STATE_TONE: Record<string, string> = {
  success: "border-ok/30 bg-ok-soft text-ok",
  failure: "border-error/30 bg-error-soft text-error",
  retry: "border-warn/30 bg-warn-soft text-warn",
};

function taskRows(trace: Trace): PropRow[] {
  const attrs = trace.attrs;
  const value = (key: string) => text(attrs[key]);
  const state = value("task.state");
  const wait = attrs["task.queue_wait"];
  const row = (label: string, key: string, mono = true): PropRow[] => {
    const shown = value(key);
    return shown ? [{ label, value: shown, copy: shown, mono }] : [];
  };
  return [
    ...row("Task", "task.name"),
    ...(state
      ? [
          {
            label: "State",
            value: (
              <Badge variant="outline" className={STATE_TONE[state.toLowerCase()] ?? ""}>
                {state.toLowerCase()}
              </Badge>
            ),
          },
        ]
      : []),
    ...row("Task ID", "task.id"),
    ...row("Queue", "task.queue"),
    ...row("Worker", "task.worker"),
    {
      label: "Ran",
      value: attrs["task.eager"]
        ? "eagerly, inside the caller"
        : `in a worker${typeof wait === "number" ? ` after ${duration(wait)} in the queue` : ""}`,
    },
    ...row("Triggered by", "task.trigger", false),
    ...(Number(attrs["task.retries"]) > 0 ? row("Attempt", "task.retries") : []),
    ...row("Retry reason", "task.retry_reason"),
    ...row("Arguments", "task.args"),
    ...row("Keyword args", "task.kwargs"),
    ...row("Result", "task.result"),
  ];
}

export interface RequestInfoProps {
  trace: Trace;
  /** Traces linked to this one (Celery): shown with links when given. */
  related?: Related | undefined;
  links?: TraceLinks | undefined;
  /** The method, URL, status and time on top of the tab: where the trace's own header is hidden (the panel). */
  hero?: boolean | undefined;
}

/** Traces of the same kind and name as one: 36 deliveries to one listener, the first standing for them. */
interface Group {
  first: TraceSummary;
  count: number;
  failed: number;
}

function TraceBadge({ trace }: { trace: TraceSummary }) {
  if (trace.kind === "http") return <MethodBadge method={trace.method} />;
  return (
    <Badge variant="outline" className="font-mono text-2xs uppercase">
      {trace.kind}
    </Badge>
  );
}

/** How many it stands for and how many failed; one alone, whether it failed and how long it took. */
function Tally({ group: { first, count, failed } }: { group: Group }) {
  if (count > 1) {
    return (
      <>
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">×{count}</span>
        {failed > 0 ? <span className="text-sm text-error">{failed} failed</span> : null}
      </>
    );
  }
  return (
    <>
      {failed > 0 ? <span className="text-sm text-error">failed</span> : null}
      <span className="ml-auto shrink-0 text-sm text-muted-foreground tabular-nums">{duration(first.duration)}</span>
    </>
  );
}

function LinkedTrace({ group, links }: { group: Group; links?: TraceLinks | undefined }) {
  const trace = group.first;
  const body = (
    <span className="flex min-w-0 items-center gap-2">
      <TraceBadge trace={trace} />
      <span className="truncate font-mono text-base">{trace.path ?? trace.name}</span>
      <Tally group={group} />
    </span>
  );
  if (!links?.trace) return body;
  return (
    <a
      className="block w-full rounded-md py-0.5 text-left hover:bg-accent"
      {...linkProps(links, links.trace(trace.id))}
    >
      {body}
    </a>
  );
}

function groupKey(trace: TraceSummary): string {
  return `${trace.kind} ${trace.path ?? trace.name}`;
}

/** Traces of the same kind and name as one row: 36 deliveries to one listener. */
function grouped(traces: readonly TraceSummary[]): Group[] {
  const groups = new Map<string, Group>();
  for (const trace of traces) {
    const group = groups.get(groupKey(trace)) ?? { first: trace, count: 0, failed: 0 };
    group.count += 1;
    group.failed += Number(trace.status === "error");
    groups.set(groupKey(trace), group);
  }
  return [...groups.values()];
}

function relatedRows(related: Related | undefined, links: TraceLinks | undefined): PropRow[] {
  if (!related) return [];
  const one = (label: string, trace: Related["enqueued_by"]): PropRow[] =>
    trace ? grouped([trace]).map((group) => ({ label, value: <LinkedTrace group={group} links={links} /> })) : [];
  const many = (single: string, plural: string, traces: Related["enqueued"]): PropRow[] =>
    traces.length
      ? [
          {
            label: traces.length === 1 ? single : `${plural} (${traces.length})`,
            value: (
              <span className="grid w-full gap-0.5">
                {grouped(traces).map((group) => (
                  <LinkedTrace key={group.first.id} group={group} links={links} />
                ))}
              </span>
            ),
          },
        ]
      : [];
  return [
    ...one("Enqueued by", related.enqueued_by),
    ...many("Enqueued task", "Enqueued tasks", related.enqueued),
    ...one("Connection", related.connection),
    ...many("Connection event", "Connection events", related.connection_events),
    ...one("Sent by", related.sent_by),
    ...many("Delivered to", "Delivered to", related.delivered),
    ...one("Called by", related.called_by),
    ...many("Served by another app", "Served by other apps", related.calls),
  ];
}

/** A row of text, when there is any. */
function textRow(label: string, value: string | null, shown: ReactNode = value): PropRow[] {
  return value ? [{ label, value: shown, copy: value, mono: true }] : [];
}

/** The handler's name as the app names it, its full name on hover when the SDK keeps a longer one. */
function HandlerName({ trace, name }: { trace: Trace; name: string }) {
  const full = handlerFullName(trace);
  return (
    <span className="[overflow-wrap:anywhere]" title={full ?? undefined}>
      {name}
    </span>
  );
}

/** What a request was, in the hero above its facts: its method, URL, status and time; its handler and route under. */
function whatRan(trace: Trace): PropRow[] {
  const attrs = trace.attrs;
  const route = text(attrs["http.route"]);
  const handler = text(attrs["code.view"]);
  const status = attrs["http.status_code"];
  return [
    ...textRow("URL", text(attrs["http.path"])),
    ...textRow("Route", route, <RoutePath path={route ?? ""} />),
    ...textRow(handlerWord(attrs), handler, <HandlerName trace={trace} name={handler ?? ""} />),
    ...(typeof status === "number" ? [{ label: "Status", value: <StatusBadge status={status} /> }] : []),
  ];
}

/** Whether the tab heads with the request at a glance: asked for, and a request it is. */
function heroShown(trace: Trace, wanted: boolean | undefined): boolean {
  return wanted === true && isRequest(trace);
}

function isRequest(trace: Trace): boolean {
  return trace.kind !== "task" && typeof trace.attrs["http.path"] === "string";
}

/** Under the URL: the view or handler that answered, and the route when it differs from the URL. */
function HandlerAndRoute({ trace, route }: { trace: Trace; route: string | null }) {
  const handler = text(trace.attrs["code.view"]);
  return (
    <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-0.5 font-mono text-xs text-muted-foreground">
      {handler ? <HandlerName trace={trace} name={handler} /> : null}
      {route ? <RoutePath path={route} /> : null}
    </div>
  );
}

/** A request at a glance: method and URL large, how it ended and how long it took beside; its handler and route under. */
function Hero({ trace }: { trace: Trace }) {
  const attrs = trace.attrs;
  const route = text(attrs["http.route"]);
  const status = attrs["http.status_code"];
  return (
    <header className="grid gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <MethodBadge method={text(attrs["http.method"])} />
        <span className="min-w-0 font-mono text-base font-medium [overflow-wrap:anywhere]">
          {text(attrs["http.path"])}
        </span>
        {typeof status === "number" ? <StatusBadge status={status} /> : null}
        <span className="text-sm text-muted-foreground tabular-nums">{duration(trace.duration)}</span>
      </div>
      <HandlerAndRoute trace={trace} route={route === attrs["http.path"] ? null : route} />
    </header>
  );
}

/** The request's or run's own fields: what ran (unless the hero shows it), how it went, who made it. */
function ownRows(trace: Trace, hero: boolean, links: TraceLinks | undefined): PropRow[] {
  const attrs = trace.attrs;
  return [
    ...(trace.kind === "task" ? taskRows(trace) : []),
    ...(hero ? [] : whatRan(trace)),
    ...userRows(attrs),
    ...htmxRows(attrs),
    ...appRows(attrs, links),
    ...runtimeRows(attrs),
    ...droppedRows(attrs),
    ...clockRows(trace),
    { label: "Started", value: new Date(trace.start / 1000).toLocaleString() },
    ...(hero ? [] : [{ label: "Duration", value: duration(trace.duration) }]),
    { label: "Trace ID", value: trace.id, copy: trace.id, mono: true },
  ];
}

/** A titled part of the overview, when it has anything to show. */
function Part({ label, title, children }: { label: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={label}>
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** Overview of the traced request or task run: what ran, how it went, who caused it; every id copies. */
export function RequestInfo({ trace, related, links, hero: wanted }: RequestInfoProps) {
  const hero = heroShown(trace, wanted);
  const document = text(trace.attrs["graphql.document"]);
  // The document is shown formatted in its own part: not again, on one line, among the attributes.
  const { "graphql.document": _, ...rest } = trace.attrs;
  const others = Object.fromEntries(Object.entries(rest).filter(([key]) => !isRequestDetail(key)));
  const graphql = document ? [{ id: "graphql", label: "GraphQL", content: <GraphqlCode document={document} /> }] : [];
  // The traces it is linked to come after its own: what queued it, what it called, what it delivered to.
  const linked = relatedRows(related, links);
  return (
    <div className="@container grid gap-5 p-4">
      {hero ? <Hero trace={trace} /> : null}
      <FactGrid rows={ownRows(trace, hero, links)} />
      {linked.length ? (
        <Part label="Related traces" title="Related traces">
          <PropTable dense rows={linked} />
        </Part>
      ) : null}
      <RequestParts parts={requestParts(trace.attrs, others, graphql)} />
    </div>
  );
}
