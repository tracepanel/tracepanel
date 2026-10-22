import type { ReactNode } from "react";
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

export function IssueChip({ kind, count }: { kind: IssueKind; count?: number | undefined }) {
  return (
    <Badge variant={kind === "error" ? "error" : "warn"} size="compact" data-kind={kind}>
      {ISSUE_LABELS[kind]}
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

/** Nothing to show; `action` is the way on, so an empty page is never a dead end. */
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="dt-empty">
      <p className="dt-empty-title">{title}</p>
      {children ? <p className="dt-empty-text">{children}</p> : null}
      {action ? <p className="dt-empty-action">{action}</p> : null}
    </div>
  );
}

/** What a trace is where a request shows its method: a task, a job, a WebSocket, a GraphQL operation. One badge in
 * the console's lists and the panel's. */
export function KindBadge({ kind }: { kind: string }) {
  return (
    <Badge
      variant="outline"
      className="h-[1.375rem] rounded-md border-brand/30 bg-brand-soft px-1.5 font-mono text-2xs text-brand uppercase"
    >
      {{ command: "job", websocket: "ws", graphql: "gql" }[kind] ?? kind}
    </Badge>
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
 * heading, the call tree, search, the panel), whole on hover.
 */
export function TaskName({ name, className }: { name: string; className?: string | undefined }) {
  return (
    <span className={cn("block min-w-0 truncate text-left font-mono [direction:rtl]", className)} title={name}>
      {/* Isolated: the dots and underscores keep their places, only the cut moves to the start. */}
      <bdi>{name}</bdi>
    </span>
  );
}
