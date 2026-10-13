import { AttrsTable } from "./AttrsTable";
import { Badge } from "./components/ui/badge";
import { duration } from "./format";
import { GraphqlCode } from "./GraphqlCode";
import { linkProps, type TraceLinks } from "./links";
import { type PropRow, PropTable } from "./PropTable";
import { MethodBadge, RoutePath, StatusBadge } from "./primitives";
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

/** What ran the trace: "Python 3.12.3 (cpython) · Django 6.0.1", "Go go1.27.1 · net/http". */
function runtimeRows(attrs: Attrs): PropRow[] {
  const language = text(attrs["telemetry.sdk.language"]);
  if (!language) return [];
  const name = text(attrs["process.runtime.name"]);
  const version = text(attrs["process.runtime.version"]);
  const framework = text(attrs["tracepanel.framework"]);
  const runtime = [
    `${language[0]?.toUpperCase()}${language.slice(1)}`,
    version,
    name && name !== language ? `(${name})` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const value = framework ? `${runtime} · ${framework}` : runtime;
  return [{ label: "Runtime", value, copy: value }];
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
}

function LinkedTrace({ trace, links }: { trace: TraceSummary; links?: TraceLinks | undefined }) {
  const body = (
    <span className="flex min-w-0 items-center gap-2">
      {trace.kind === "http" ? (
        <MethodBadge method={trace.method} />
      ) : (
        <Badge variant="outline" className="font-mono text-2xs uppercase">
          {trace.kind}
        </Badge>
      )}
      <span className="truncate font-mono text-base">{trace.path ?? trace.name}</span>
      {trace.status === "error" ? <span className="text-sm text-error">failed</span> : null}
      <span className="ml-auto shrink-0 text-sm text-muted-foreground tabular-nums">{duration(trace.duration)}</span>
    </span>
  );
  return links?.trace ? (
    <a
      className="block w-full rounded-md py-0.5 text-left hover:bg-accent"
      {...linkProps(links, links.trace(trace.id))}
    >
      {body}
    </a>
  ) : (
    body
  );
}

function relatedRows(related: Related | undefined, links: TraceLinks | undefined): PropRow[] {
  if (!related) return [];
  const one = (label: string, trace: Related["enqueued_by"]): PropRow[] =>
    trace ? [{ label, value: <LinkedTrace trace={trace} links={links} /> }] : [];
  const many = (single: string, plural: string, traces: Related["enqueued"]): PropRow[] =>
    traces.length
      ? [
          {
            label: traces.length === 1 ? single : `${plural} (${traces.length})`,
            value: (
              <span className="grid w-full gap-0.5">
                {traces.map((child) => (
                  <LinkedTrace key={child.id} trace={child} links={links} />
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

/** Overview of the traced request or task run: what ran, how it went, who caused it; every id copies. */
export function RequestInfo({ trace, related, links }: RequestInfoProps) {
  const attrs = trace.attrs;
  const path = text(attrs["http.path"]);
  const route = text(attrs["http.route"]);
  const view = text(attrs["code.view"]);
  const status = attrs["http.status_code"];
  const document = text(attrs["graphql.document"]);
  // The document is shown formatted above: not again, on one line, among the attributes.
  const listed = document
    ? Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== "graphql.document"))
    : attrs;
  const rows: PropRow[] = [
    ...(trace.kind === "task" ? taskRows(trace) : []),
    ...relatedRows(related, links),
    ...(path ? [{ label: "URL", value: path, copy: path, mono: true }] : []),
    ...(route ? [{ label: "Route", value: <RoutePath path={route} />, copy: route, mono: true }] : []),
    ...(view ? [{ label: "View", value: view, copy: view, mono: true }] : []),
    ...(typeof status === "number" ? [{ label: "Status", value: <StatusBadge status={status} /> }] : []),
    ...userRows(attrs),
    ...htmxRows(attrs),
    ...runtimeRows(attrs),
    { label: "Started", value: new Date(trace.start / 1000).toLocaleString() },
    { label: "Duration", value: duration(trace.duration) },
    { label: "Trace ID", value: trace.id, copy: trace.id, mono: true },
  ];

  return (
    <div className="grid gap-4 p-4">
      <PropTable rows={rows} />
      {document ? (
        <section className="grid gap-2" aria-label="GraphQL query">
          <h3 className="text-sm font-medium text-muted-foreground">Query</h3>
          <GraphqlCode document={document} />
        </section>
      ) : null}
      <section className="grid gap-2" aria-label="All attributes">
        <h3 className="text-sm font-medium text-muted-foreground">
          All attributes <span className="tabular-nums">{Object.keys(listed).length}</span>
        </h3>
        <AttrsTable attrs={listed} />
      </section>
    </div>
  );
}
