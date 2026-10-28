import { ArrowRightIcon, ListTreeIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "./components/ui/button";
import { since } from "./format";
import type { TraceScope } from "./hooks/useTraceChain";
import { keyed } from "./keys";
import { LogRecordDetails } from "./LogRecordDetails";
import { type LogColumn, LogLevel, LogTable } from "./LogTable";
import { withoutAnsi } from "./lib/ansi";
import { plural } from "./lib/plural";
import { type Member, type ScopedLog, type SpanScope, scopeWindow } from "./lib/scope";
import { linkProps, type TraceLinks } from "./links";
import { AppChip } from "./primitives";
import { CountChip, countBy, ScopeHeader, useChainApps } from "./ScopeBar";
import type { Trace } from "./types";

/** The way to the Logs page, to filter and search the trace's records with every other. */
function OpenInLogs({ traceId, links }: { traceId: string; links: TraceLinks | undefined }) {
  if (!links?.logs) return null;
  return (
    <Button variant="outline" size="xs" asChild>
      <a {...linkProps(links, links.logs(traceId))}>
        Open in Logs
        <ArrowRightIcon />
      </a>
    </Button>
  );
}

/** "2 records", or "1 of 2 records" while a chip narrows them. */
function recordCount(count: number, of: number): string {
  return count === of ? plural(count, "record", "records") : `${count} of ${plural(of, "record", "records")}`;
}

/** What narrows the list beyond its scope: one app, one level, one logger. */
interface Picks {
  app: string | null;
  level: string | null;
  logger: string | null;
}

const NO_PICKS: Picks = { app: null, level: null, logger: null };

const LEVELS = ["critical", "error", "warning", "info", "debug"];

/** Records in each of the slices of the scope's time, by level: the worst a slice has colours its bar. */
const SLICES = 24;

function slicesOf(logs: readonly ScopedLog[], window: [number, number]): { count: number; worst: string }[] {
  const start = Math.min(window[0], ...logs.map((log) => log.time));
  const end = Math.max(window[1], ...logs.map((log) => log.time));
  const width = Math.max(end - start, 1) / SLICES;
  const slices = Array.from({ length: SLICES }, () => ({ count: 0, worst: "debug" }));
  for (const log of logs) {
    const slice = slices[Math.min(Math.floor((log.time - start) / width), SLICES - 1)];
    if (!slice) continue;
    slice.count += 1;
    if (LEVELS.indexOf(log.level) < LEVELS.indexOf(slice.worst)) slice.worst = log.level;
  }
  return slices;
}

/** How the records lie over the scope's time: a bar a slice, as tall as its records, the colour of its worst. */
function LevelHistogram({ logs, window }: { logs: readonly ScopedLog[]; window: [number, number] }) {
  const slices = slicesOf(logs, window);
  const most = Math.max(1, ...slices.map((slice) => slice.count));
  return (
    <li className="dt-log-histogram" role="img" aria-label="Records over the time, by level">
      {slices.map((slice, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the slices of the time, in order.
          key={index}
          data-level={slice.count ? slice.worst : undefined}
          style={{ height: `${slice.count ? Math.max(15, (slice.count / most) * 100) : 0}%` }}
        />
      ))}
    </li>
  );
}

/** The first error of the scope: a click opens it. */
function FirstError({ log, start, onOpen }: { log: ScopedLog | undefined; start: number; onOpen: () => void }) {
  if (!log) return null;
  return (
    <li className="min-w-0">
      <button type="button" className="dt-map-filter dt-log-first-error" title="Open the first error" onClick={onOpen}>
        <span className="text-error">First error</span>
        <span className="dt-map-filter-count">{since(log.time, start)}</span>
        <span className="truncate">{withoutAnsi(log.message)}</span>
      </button>
    </li>
  );
}

/**
 * What a scope's records add up to, over the list: by level, by logger, how they lie over its time, its first
 * error. A chip narrows the list to what it counts.
 */
function LogAggregates({
  logs,
  picks,
  onPick,
  window,
  start,
  onOpenFirstError,
}: {
  logs: readonly ScopedLog[];
  picks: Picks;
  onPick: (picks: Picks) => void;
  window: [number, number];
  start: number;
  onOpenFirstError: (log: ScopedLog) => void;
}) {
  if (logs.length === 0) return null;
  const levels = countBy(logs, (log) => log.level);
  const loggers = [...countBy(logs, (log) => withoutAnsi(log.logger))].slice(0, 4);
  const firstError = logs.find((log) => log.level === "error" || log.level === "critical");
  return (
    <>
      {LEVELS.filter((level) => levels.has(level)).map((level) => (
        <CountChip
          key={level}
          pressed={picks.level === level}
          count={levels.get(level) ?? 0}
          onPress={() => onPick({ ...picks, level: picks.level === level ? null : level })}
        >
          <LogLevel level={level} />
        </CountChip>
      ))}
      {loggers.length > 1
        ? loggers.map(([logger, count]) => (
            <CountChip
              key={logger}
              pressed={picks.logger === logger}
              count={count}
              title={`Logger ${logger}`}
              onPress={() => onPick({ ...picks, logger: picks.logger === logger ? null : logger })}
            >
              <span className="font-mono">{logger}</span>
            </CountChip>
          ))
        : null}
      <LevelHistogram logs={logs} window={window} />
      <FirstError log={firstError} start={start} onOpen={() => firstError && onOpenFirstError(firstError)} />
    </>
  );
}

/** The app a record came from, its chip as everywhere else, with its mark. */
function appColumn(runtimes: ReadonlyMap<string, string | undefined> | undefined): LogColumn<ScopedLog> {
  return {
    id: "app",
    label: "App",
    width: 11,
    drop: 1,
    cell: (log) => <AppChip name={log.app} runtime={runtimes?.get(log.app)} />,
  };
}

function picked(logs: readonly ScopedLog[], picks: Picks): ScopedLog[] {
  return logs.filter(
    (log) =>
      (picks.app === null || log.app === picks.app) &&
      (picks.level === null || log.level === picks.level) &&
      (picks.logger === null || withoutAnsi(log.logger) === picks.logger),
  );
}

/** Records carry no id: their trace, time, logger and message, and a counter for repeats, keep them apart. */
function useRecordKeys(logs: readonly ScopedLog[]): ReadonlyMap<ScopedLog, string> {
  return useMemo(
    () =>
      new Map(
        keyed(logs, (log) => `${log.traceId}:${log.time}:${log.logger}:${log.message}`).map(({ key, item }) => [
          item,
          key,
        ]),
      ),
    [logs],
  );
}

/**
 * A trace's records, as the Logs page lists records: one line each, a click opens its details below. Those of its
 * whole chain of calls, each with its app, or what is under a row of the call tree (`scope`); over them what they
 * add up to, each count a filter.
 */
export function LogList({
  logs,
  apps,
  runtimes,
  start,
  window,
  traceId,
  links,
  scope,
  onScope,
  rowOf,
  onShowRow,
}: {
  /** The scope's records, in time order on the trace's clock. */
  logs: readonly ScopedLog[];
  /** The apps of the trace's chain: a chip each, when there are two or more. */
  apps: readonly string[];
  /** Each app's runtime label: the mark on its chip. */
  runtimes?: ReadonlyMap<string, string | undefined> | undefined;
  start: number;
  /** The time the scope covers. */
  window: [number, number];
  traceId: string;
  links?: TraceLinks | undefined;
  scope: SpanScope | null;
  onScope: (scope: SpanScope | null) => void;
  /** The call tree's row a record was logged in, if it has one; and what opens the tree at it. */
  rowOf?: ((log: ScopedLog) => string | undefined) | undefined;
  onShowRow?: ((row: string) => void) | undefined;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [picks, setPicks] = useState<Picks>(NO_PICKS);
  const inApp = useMemo(() => picked(logs, { ...NO_PICKS, app: picks.app }), [logs, picks.app]);
  const shown = useMemo(() => picked(inApp, picks), [inApp, picks]);
  const keys = useRecordKeys(logs);
  const several = apps.length > 1;
  const appCounts = useMemo(() => countBy(logs, (log) => log.app), [logs]);
  const openFirstError = (log: ScopedLog) => {
    setPicks({ ...picks, level: null, logger: null });
    setOpen(keys.get(log) ?? null);
  };
  return (
    <>
      <ScopeHeader
        scope={scope}
        onScope={onScope}
        apps={{ apps, runtimes, counts: appCounts, picked: picks.app, onPick: (app) => setPicks({ ...picks, app }) }}
        summary={recordCount(shown.length, logs.length)}
        end={<OpenInLogs traceId={traceId} links={links} />}
        filtersLabel="What the records add up to"
        filters={
          <LogAggregates
            logs={inApp}
            picks={picks}
            onPick={setPicks}
            window={window}
            start={start}
            onOpenFirstError={openFirstError}
          />
        }
      />
      <Records
        logs={shown}
        empty={`No log records ${scope ? "under this" : "in this request"}.`}
        keys={keys}
        app={several ? appColumn(runtimes) : undefined}
        start={start}
        open={open}
        onOpen={setOpen}
        action={(log) => <ShowRow row={rowOf?.(log)} onShowRow={onShowRow} />}
      />
    </>
  );
}

/** The records shown, a line each, or what says there are none. */
function Records({
  logs,
  empty,
  keys,
  app,
  start,
  open,
  onOpen,
  action,
}: {
  logs: readonly ScopedLog[];
  empty: string;
  keys: ReadonlyMap<ScopedLog, string>;
  /** The app's column, with records of more than one app. */
  app: LogColumn<ScopedLog> | undefined;
  start: number;
  open: string | null;
  onOpen: (key: string | null) => void;
  action: (log: ScopedLog) => ReactNode;
}) {
  if (logs.length === 0) return <p className="dt-note">{empty}</p>;
  return (
    <LogTable
      table="trace-logs"
      logs={logs}
      keyOf={(log) => keys.get(log) ?? ""}
      columns={app ? [app] : []}
      start={start}
      open={open}
      onOpen={onOpen}
      details={(log) => <LogRecordDetails log={log} />}
      action={action}
    />
  );
}

/** The call tree opened at the row a record was logged in, when there is one. */
function ShowRow({ row, onShowRow }: { row: string | undefined; onShowRow?: ((row: string) => void) | undefined }) {
  if (!(onShowRow && row)) return null;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground"
      aria-label="In the call tree"
      title="In the call tree"
      onClick={() => onShowRow(row)}
    >
      <ListTreeIcon />
    </Button>
  );
}

/** The call tree's row a record was logged in: its span's, else its trace's row (a call's trace), if any. */
function rowOf(members: readonly Member[], log: ScopedLog): string | undefined {
  const member = members.find((each) => each.id === log.traceId);
  if (log.span_id !== null && member?.trace.spans.some((span) => span.id === log.span_id)) return log.span_id;
  return member && member !== members[0] ? `call:${member.id}` : undefined;
}

/** The Logs tab: the records of the trace's scope, its chain or what is under a row of the call tree. */
export function LogsPane({
  open,
  chain,
  trace,
  links,
  onShowRow,
}: {
  open: boolean;
  chain: TraceScope;
  trace: Trace;
  links: TraceLinks | undefined;
  onShowRow: (row: string) => void;
}) {
  const { apps, runtimes } = useChainApps(chain.members);
  if (!open) return null;
  const { scope } = chain;
  return (
    <LogList
      key={scope ? `${scope.targets.join(",")}:${scope.only}` : "chain"}
      logs={chain.scoped}
      apps={apps}
      runtimes={runtimes}
      start={trace.start}
      window={scopeWindow(chain.members, scope)}
      traceId={trace.id}
      links={links}
      scope={scope}
      onScope={chain.setScope}
      rowOf={(log) => rowOf(chain.members, log)}
      onShowRow={onShowRow}
    />
  );
}
