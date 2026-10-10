import type { ReactNode } from "react";
import { ISSUE_LABELS } from "./labels";
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
    <span className="dt-chip" data-kind={kind}>
      {ISSUE_LABELS[kind]}
      {count !== undefined && count > 1 ? <span className="dt-chip-count">{count}</span> : null}
    </span>
  );
}

/** Database or cache alias, shown only when it is not "default". */
export function AliasChip({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === "" || value === "default") return null;
  return <span className="dt-alias">{String(value)}</span>;
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

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="dt-empty">
      <p className="dt-empty-title">{title}</p>
      {children ? <p className="dt-empty-text">{children}</p> : null}
    </div>
  );
}
