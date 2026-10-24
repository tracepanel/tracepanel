// How a trace is headed, by its kind: its badge, its title and how it went. The console's page header and the panel's
// first tab both say it this way.
import type { ReactNode } from "react";
import { pageParts } from "./lib/page";
import { StateBadge, StatusBadge, TaskName } from "./primitives";
import type { Trace } from "./types";

/** The badge and title of a trace, by kind: a GraphQL request is its operation, not POST /graphql/. */
export function htmxOf(trace: Trace): "request" | "boosted" | null {
  if (!trace.attrs["htmx.request"]) return null;
  return trace.attrs["htmx.boosted"] ? "boosted" : "request";
}

/** A view or an action in the browser: VIEW /books, or CLICK "Save" · /books. */
function pageHeading(name: string): { badge: string; title: string } {
  const { badge, label, page } = pageParts(name);
  return { badge, title: page ? `${label} · ${page}` : label };
}

/** The heading of a trace that isn't a request, by its kind. */
const KIND_HEADINGS: Record<string, (name: string) => { badge: string; title: string }> = {
  task: (name) => ({ badge: "TASK", title: name }),
  command: (name) => ({ badge: "JOB", title: name }),
  websocket: (name) => ({ badge: "WS", title: name.replace(/^WS /, "") }),
  page: pageHeading,
};

/** The heading's title: a task's name cut where a task's name is everywhere. */
export function HeadingTitle({ kind, title }: { kind: string; title: string }) {
  return kind === "task" ? <TaskName name={title} /> : title;
}

export function heading(trace: Trace): { badge: string; title: string } {
  const operation = trace.attrs["graphql.operation"];
  if (typeof operation === "string") return { badge: "GQL", title: operation };
  const byKind = KIND_HEADINGS[trace.kind];
  return byKind ? byKind(trace.name) : requestHeading(trace);
}

/** A request's: its method and path, or its name's when it has none. */
function requestHeading(trace: Trace): { badge: string; title: string } {
  const method = trace.attrs["http.method"];
  const path = trace.attrs["http.path"];
  return {
    badge: typeof method === "string" ? method : (trace.name.split(" ")[0] ?? ""),
    title: typeof path === "string" ? path : trace.name,
  };
}

/** How it went, on the Request tab: its status, a task's state, or that it failed. */
export function outcomeOf(trace: Trace): ReactNode {
  const status = trace.attrs["http.status_code"];
  const state = trace.attrs["task.state"];
  if (typeof status === "number") return <StatusBadge status={status} />;
  if (typeof state === "string") return <StateBadge state={state} />;
  return trace.status === "error" ? (
    <span className="dt-status" data-tone="error">
      failed
    </span>
  ) : null;
}
