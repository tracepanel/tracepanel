import { useState } from "react";
import { clock, since } from "./format";
import { keyed } from "./keys";
import { LogRecordDetails } from "./LogRecordDetails";
import { linkProps, type TraceLinks } from "./links";
import type { Log } from "./types";

export function LogList({
  logs,
  start,
  traceId,
  links,
  onShowSpan,
}: {
  logs: readonly Log[];
  start: number;
  traceId: string;
  links?: TraceLinks | undefined;
  /** Open the call tree at the span a record was logged in. */
  onShowSpan?: ((spanId: string) => void) | undefined;
}) {
  if (logs.length === 0) return <p className="dt-note">No log records in this request.</p>;
  return (
    <>
      {links?.logs ? (
        <p className="dt-logs-more">
          <a className="dt-issue-link" {...linkProps(links, links.logs(traceId))}>
            In the logs list, to filter and search →
          </a>
        </p>
      ) : null}
      <ol className="dt-logs">
        {keyed(logs, (log) => `${log.time}:${log.logger}:${log.message}`).map(({ key, item: log }) => (
          <LogRecord key={key} log={log} start={start} onShowSpan={onShowSpan} />
        ))}
      </ol>
    </>
  );
}

/** One record, compact; a click on it opens its details below, as the call tree shows a picked record. */
function LogRecord({
  log,
  start,
  onShowSpan,
}: {
  log: Log;
  start: number;
  onShowSpan?: ((spanId: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the message inside is the button the keyboard opens it with.
    <li
      className="dt-log"
      data-level={log.level}
      data-open={open || undefined}
      onClick={(event) => opens(event.target) && setOpen(!open)}
    >
      <time className="dt-log-time" dateTime={new Date(log.time / 1000).toISOString()} title={since(log.time, start)}>
        {clock(log.time)}
      </time>
      <span className="dt-log-level">{log.level}</span>
      <button type="button" className="dt-log-message" aria-expanded={open}>
        {log.message}
      </button>
      <span className="dt-log-logger">{log.logger}</span>
      <ShowSpan spanId={log.span_id} onShowSpan={onShowSpan} />
      <Exception text={open ? null : log.exception} />
      {open ? (
        <div className="dt-log-details">
          <LogRecordDetails log={log} />
        </div>
      ) : null}
    </li>
  );
}

/** Whether a click in a row opens it: anywhere but its call tree link and its opened details. */
function opens(target: EventTarget): boolean {
  return !(target as Element).closest("a, .dt-log-span, .dt-log-details");
}

/** A record's exception under it, while its details (which show it) are closed. */
function Exception({ text }: { text: string | null | undefined }) {
  return text ? <pre className="dt-code dt-log-exception">{text}</pre> : null;
}

/** The call tree opened at the span a record was logged in, when it was logged in one. */
function ShowSpan({
  spanId,
  onShowSpan,
}: {
  spanId: string | null | undefined;
  onShowSpan?: ((spanId: string) => void) | undefined;
}) {
  if (!onShowSpan || !spanId) return null;
  return (
    <button type="button" className="dt-log-span" onClick={() => onShowSpan(spanId)}>
      In the call tree
    </button>
  );
}
