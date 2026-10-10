import { duration } from "./format";
import { keyed } from "./keys";
import type { Log } from "./types";

export function LogList({ logs, start }: { logs: readonly Log[]; start: number }) {
  if (logs.length === 0) return <p className="dt-note">No log records in this request.</p>;
  return (
    <ol className="dt-logs">
      {keyed(logs, (log) => `${log.time}:${log.logger}:${log.message}`).map(({ key, item: log }) => (
        <li key={key} className="dt-log" data-level={log.level}>
          <span className="dt-log-time">+{duration(Math.max(log.time - start, 0))}</span>
          <span className="dt-log-level">{log.level}</span>
          <span className="dt-log-message">{log.message}</span>
          <span className="dt-log-logger">{log.logger}</span>
          {log.exception ? <pre className="dt-code dt-log-exception">{log.exception}</pre> : null}
        </li>
      ))}
    </ol>
  );
}
