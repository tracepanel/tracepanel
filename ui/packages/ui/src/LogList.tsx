import { ListTreeIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "./components/ui/button";
import { keyed } from "./keys";
import { LogRecordDetails } from "./LogRecordDetails";
import { LogTable } from "./LogTable";
import { linkProps, type TraceLinks } from "./links";
import type { Log } from "./types";

/** A trace's records, as the Logs page lists records: one line each, a click opens its details below. */
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
  const [open, setOpen] = useState<string | null>(null);
  // Records carry no id: their time, logger and message, and a counter for repeats, keep them apart.
  const keys = useMemo(
    () => new Map(keyed(logs, (log) => `${log.time}:${log.logger}:${log.message}`).map(({ key, item }) => [item, key])),
    [logs],
  );
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
      <LogTable
        table="trace-logs"
        logs={logs}
        keyOf={(log) => keys.get(log) ?? ""}
        start={start}
        open={open}
        onOpen={setOpen}
        details={(log) => <LogRecordDetails log={log} />}
        action={(log) => <ShowSpan spanId={log.span_id} onShowSpan={onShowSpan} />}
      />
    </>
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
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground"
      aria-label="In the call tree"
      title="In the call tree"
      onClick={() => onShowSpan(spanId)}
    >
      <ListTreeIcon />
    </Button>
  );
}
