import { useState } from "react";
import { clock, since } from "./format";
import { keyed } from "./keys";
import { linkProps, type TraceLinks } from "./links";
import { PropTable } from "./PropTable";
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

/** One record: a click on its message opens where it was logged (its logger in full, code, thread, extra fields). */
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
    <li className="dt-log" data-level={log.level}>
      <time className="dt-log-time" dateTime={new Date(log.time / 1000).toISOString()} title={since(log.time, start)}>
        {clock(log.time)}
      </time>
      <span className="dt-log-level">{log.level}</span>
      <button type="button" className="dt-log-message" aria-expanded={open} onClick={() => setOpen(!open)}>
        {log.message}
      </button>
      <span className="dt-log-logger">{log.logger}</span>
      <ShowSpan spanId={log.span_id} onShowSpan={onShowSpan} />
      {log.exception ? <pre className="dt-code dt-log-exception">{log.exception}</pre> : null}
      {open ? <LogAttrs log={log} /> : null}
    </li>
  );
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

function LogAttrs({ log }: { log: Log }) {
  const rows = [
    { label: "logger", value: log.logger, copy: log.logger, mono: true },
    ...Object.entries(log.attrs)
      .filter(([, value]) => value !== null && value !== "")
      .map(([key, value]) => ({ label: key, value: String(value), copy: String(value), mono: true })),
  ];
  return (
    <div className="dt-log-attrs">
      <PropTable rows={rows} />
    </div>
  );
}
