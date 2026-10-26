import type { ReactNode } from "react";
import { AttrValue } from "./AttrValue";
import { Badge } from "./components/ui/badge";
import { FactGrid } from "./FactGrid";
import { dayTime, duration } from "./format";
import { GraphqlCode } from "./GraphqlCode";
import { grouped, LinkedTrace, tracesRow } from "./LinkedTrace";
import { collectstaticFacts } from "./lib/collectstatic";
import { handlerFullName, handlerWord } from "./lib/handler";
import { shownValue } from "./lib/pyliteral";
import { traceRuntime } from "./lib/runtime";
import { unreceived } from "./lib/signals";
import { linkProps, type TraceLinks } from "./links";
import { type PropRow, PropTable } from "./PropTable";
import { RoutePath, TraceBadge } from "./primitives";
import { isRequestDetail, RequestParts, requestParts } from "./RequestParts";
import { SegmentLabel } from "./Segmented";
import { HeadingTitle, heading, htmxOf, outcomeOf } from "./TraceHeading";
import type { Attrs, Related, Trace } from "./types";
import { taskTimingRows, workflowFacts, workflowPart } from "./Workflow";
import { WorkflowGraph } from "./WorkflowGraph";

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
      // A note, read whole: a line of its own.
      wide: true,
    },
  ];
}

/** The signals sent with no receiver: no span each, a count the SDK keeps (`signal.unreceived`). */
function unreceivedRows(attrs: Attrs): PropRow[] {
  const sends = unreceived(attrs).join(", ");
  if (!sends) return [];
  return [
    {
      label: "Sent with no receiver",
      value: (
        <span className="text-muted-foreground" title={sends}>
          {sends}
        </span>
      ),
      mono: true,
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
  return off === null ? [] : [{ label: "Clock", value: <ClockNote off={off} />, wide: true }];
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

/**
 * A task run's own facts. Its name and state are its head's (the page's header, the panel's head line), its queue
 * and worker too where the head line says them (`hero`).
 */
function taskRows(trace: Trace, related: Related | undefined, links: TraceLinks | undefined, hero: boolean): PropRow[] {
  const attrs = trace.attrs;
  const value = (key: string) => text(attrs[key]);
  const wait = attrs["task.queue_wait"];
  const row = (label: string, key: string, mono = true): PropRow[] => {
    const shown = value(key);
    return shown ? [{ label, value: shown, copy: shown, mono }] : [];
  };
  return [
    ...row("Task ID", "task.id"),
    ...(hero ? [] : [...row("Queue", "task.queue"), ...row("Worker", "task.worker")]),
    {
      label: "Ran",
      value: attrs["task.eager"]
        ? "eagerly, inside the caller"
        : `in a worker${typeof wait === "number" ? ` after ${duration(wait)} in the queue` : ""}`,
    },
    ...taskTimingRows(trace),
    ...row("Triggered by", "task.trigger", false),
    ...(Number(attrs["task.retries"]) > 0 ? row("Attempt", "task.retries") : []),
    ...wideRow("Retry reason", "task.retry_reason", value("task.retry_reason")),
    ...wideRow("Arguments", "task.args", value("task.args")),
    ...wideRow("Keyword args", "task.kwargs", value("task.kwargs")),
    ...wideRow("Result", "task.result", value("task.result")),
    ...workflowFacts(trace, related, links),
  ];
}

/** A task's value that may be long (its arguments, result, retry reason): laid out and coloured as attributes are. */
function wideRow(label: string, key: string, shown: string | null | undefined): PropRow[] {
  if (!shown) return [];
  return [{ label, value: <AttrValue value={shownValue(key, shown)} />, copy: shown, mono: true, wide: true }];
}

export interface RequestInfoProps {
  trace: Trace;
  /** Traces linked to this one (Celery): shown with links when given. */
  related?: Related | undefined;
  links?: TraceLinks | undefined;
  /** The trace's head line on top of the tab (badge, name, outcome, time; what handled it): where the page's header
   *  isn't there to say them (the panel). */
  hero?: boolean | undefined;
}

/**
 * The traces this one is linked to, each once: a task a broker delivered was both enqueued and sent by the same
 * request (and that request both enqueued it and delivered to it), and it is listed under the first of those names.
 */
function relatedRows(related: Related | undefined, links: TraceLinks | undefined, taken: Set<string>): PropRow[] {
  if (!related) return [];
  const shown = new Set(taken);
  const one = (label: string, trace: Related["enqueued_by"]): PropRow[] => {
    if (!trace || shown.has(trace.id)) return [];
    shown.add(trace.id);
    return grouped([trace]).map((group) => ({ label, value: <LinkedTrace group={group} links={links} /> }));
  };
  const many = (single: string, plural: string, all: Related["enqueued"]): PropRow[] => {
    const fresh = all.filter((trace) => !shown.has(trace.id));
    for (const trace of fresh) shown.add(trace.id);
    return tracesRow(single, plural, fresh, links);
  };
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

/** The view or handler that answered, as a fact where the head line doesn't say it (the console's page). */
function handlerRows(trace: Trace): PropRow[] {
  const handler = text(trace.attrs["code.view"]);
  return textRow(handlerWord(trace.attrs), handler, <HandlerName trace={trace} name={handler ?? ""} />);
}

/** A command's own line, when its SDK recorded one. */
const COMMAND_LINE = ["process.command_line", "process.command_args", "command.line"];

/**
 * What handled it, under the head line, quietly: a request's view or handler (and its route when it isn't the URL),
 * a task's queue and worker, a job's command line, a page's URL.
 */
function codeOf(trace: Trace): ReactNode[] {
  const attrs = trace.attrs;
  const handler = text(attrs["code.view"]);
  const route = text(attrs["http.route"]);
  return [
    handler ? <HandlerName key="handler" trace={trace} name={handler} /> : null,
    route && route !== attrs["http.path"] ? <RoutePath key="route" path={route} /> : null,
    ...["task.queue", "task.worker", "page.url", ...COMMAND_LINE].map((key) => {
      const value = text(attrs[key]);
      return value ? <span key={key}>{value}</span> : null;
    }),
  ].filter(Boolean);
}

/**
 * Any trace at a glance, the same anatomy for every kind (the panel's first tab): its badge and name large, how it
 * ended and how long it took beside, as the console's page header says them; what handled it under, quietly.
 */
function Hero({ trace }: { trace: Trace }) {
  const head = heading(trace);
  const code = codeOf(trace);
  return (
    <header className="dt-hero grid gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <TraceBadge word={head.badge} htmx={htmxOf(trace)} />
        <span className="flex min-w-0 font-mono text-base font-medium [overflow-wrap:anywhere]">
          <HeadingTitle kind={trace.kind} title={head.title} />
        </span>
        {outcomeOf(trace)}
        <span className="text-sm text-muted-foreground tabular-nums">{duration(trace.duration)}</span>
      </div>
      {code.length ? (
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-0.5 font-mono text-xs text-muted-foreground">{code}</div>
      ) : null}
    </header>
  );
}

/**
 * The trace's own facts, one order for every kind: its kind's own first (a task's id, its run; the console's
 * request its handler), then who made it, then App, Runtime, Started and Trace ID, then what to know about the
 * trace itself. What its head already says (its name, status or state, duration) isn't said again.
 */
function ownRows(trace: Trace, hero: boolean, related: Related | undefined, links: TraceLinks | undefined): PropRow[] {
  const attrs = trace.attrs;
  return [
    ...(trace.kind === "task" ? taskRows(trace, related, links, hero) : []),
    // A job's own: collectstatic's files and phases.
    ...collectstaticFacts(trace),
    ...(hero ? [] : handlerRows(trace)),
    ...userRows(attrs),
    ...htmxRows(attrs),
    ...appRows(attrs, links),
    ...runtimeRows(attrs),
    { label: "Started", value: dayTime(trace.start) },
    { label: "Trace ID", value: trace.id, copy: trace.id, mono: true },
    ...droppedRows(attrs),
    ...unreceivedRows(attrs),
    ...clockRows(trace),
  ];
}

/** A titled part of the overview, when it has anything to show. */
function Part({ label, title, children }: { label: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={label}>
      {/* Its name on the pill track the parts with a switch have (Attributes, Headers), the same full-width track:
          one system of parts. */}
      <h3 className="m-0 grid">
        <SegmentLabel>{title}</SegmentLabel>
      </h3>
      {children}
    </section>
  );
}

/** A task run's workflow drawn whole, when it is in one of more than one task. */
function WorkflowSection({ trace, related, links }: Omit<RequestInfoProps, "hero">) {
  const graph = related?.workflow?.graph;
  if (!graph) return null;
  return (
    <Part label="Workflow" title="Workflow">
      <WorkflowGraph graph={graph} current={trace.id} links={links} />
    </Part>
  );
}

/**
 * The related traces' rows: what queued it, what it called, what it delivered to, and its workflow's runs before and
 * after it, unless the workflow's graph below draws them.
 */
function linkedRows(trace: Trace, related: Related | undefined, links: TraceLinks | undefined): PropRow[] {
  const workflow = workflowPart(trace, related, links);
  const drawn = Boolean(related?.workflow?.graph);
  return [...relatedRows(related, links, workflow.taken), ...(drawn ? [] : workflow.rows)];
}

/** Overview of the traced request or task run: what ran, how it went, who caused it; every id copies. */
export function RequestInfo({ trace, related, links, hero: wanted }: RequestInfoProps) {
  const hero = wanted === true;
  const document = text(trace.attrs["graphql.document"]);
  // The document is shown formatted in its own part: not again, on one line, among the attributes.
  const { "graphql.document": _, ...rest } = trace.attrs;
  const others = Object.fromEntries(Object.entries(rest).filter(([key]) => !isRequestDetail(key)));
  const graphql = document ? [{ id: "graphql", label: "GraphQL", content: <GraphqlCode document={document} /> }] : [];
  // The traces it is linked to come after its own: what queued it, what it called, what it delivered to.
  // A task run's workflow lists the runs before and after it: the other rows leave those out.
  const linked = linkedRows(trace, related, links);
  return (
    <div className="@container grid gap-5 p-4">
      {hero ? <Hero trace={trace} /> : null}
      <FactGrid rows={ownRows(trace, hero, related, links)} />
      {linked.length ? (
        <Part label="Related traces" title="Related traces">
          <PropTable dense rows={linked} />
        </Part>
      ) : null}
      <WorkflowSection trace={trace} related={related} links={links} />
      <RequestParts parts={requestParts(trace.attrs, others, graphql)} look="plain" />
    </div>
  );
}
