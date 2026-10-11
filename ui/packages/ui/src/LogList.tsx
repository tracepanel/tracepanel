import { duration } from "./format";
import { keyed } from "./keys";
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
          <li key={key} className="dt-log" data-level={log.level}>
            <span className="dt-log-time">+{duration(Math.max(log.time - start, 0))}</span>
            <span className="dt-log-level">{log.level}</span>
            <span className="dt-log-message">{log.message}</span>
            <span className="dt-log-logger">{log.logger}</span>
            {onShowSpan && log.span_id ? (
              <button type="button" className="dt-log-span" onClick={() => onShowSpan(log.span_id ?? "")}>
                In the call tree
              </button>
            ) : null}
            {log.exception ? <pre className="dt-code dt-log-exception">{log.exception}</pre> : null}
          </li>
        ))}
      </ol>
    </>
  );
}
