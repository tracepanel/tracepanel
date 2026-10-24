import type { ReactNode } from "react";
import { duration } from "./format";
import { type TraceLinks, traceLinkProps } from "./links";
import type { PropRow } from "./PropTable";
import { KindBadge, StateBadge, StatusBadge, TaskName } from "./primitives";
import { RunChips } from "./RunChips";
import type { TraceSummary } from "./types";

/** Traces of the same kind and name as one: 36 deliveries to one listener, the first standing for them. */
export interface Group {
  first: TraceSummary;
  count: number;
  failed: number;
}

/** What a linked trace is, in the grey kind box the call tree's rows have: a request, a task, a job, a page. */
const LINK_KINDS: Record<string, string> = { http: "request", command: "job" };

function LinkBadge({ trace }: { trace: TraceSummary }) {
  return <KindBadge kind={LINK_KINDS[trace.kind] ?? trace.kind} muted={true} />;
}

/** One alone: how it ended, as its own rows say it: a request's status, a task run's state, or that it failed. */
function Outcome({ trace }: { trace: TraceSummary }) {
  if (typeof trace.http_status === "number") return <StatusBadge status={trace.http_status} />;
  if (trace.task_state) return <StateBadge state={trace.task_state} />;
  return trace.status === "error" ? <span className="text-sm text-error">failed</span> : null;
}

/** How many it stands for and how many failed; one alone, how it ended, what it found, and how long it took. */
function Tally({ group: { first, count, failed } }: { group: Group }) {
  if (count > 1) {
    return (
      <>
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">×{count}</span>
        {failed > 0 ? <span className="text-sm text-error">{failed} failed</span> : null}
      </>
    );
  }
  return (
    <>
      <Outcome trace={first} />
      <RunChips trace={first} />
      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{duration(first.duration)}</span>
    </>
  );
}

/**
 * A linked trace's name, as the call tree's rows say theirs: a request's method and path, else its name, a task's
 * cut at its start.
 */
function LinkedName({ trace }: { trace: TraceSummary }) {
  if (trace.kind === "task") return <TaskName name={trace.name} className="font-mono text-sm" />;
  return <span className="truncate font-mono text-sm">{requestName(trace) ?? trace.name}</span>;
}

/** "POST /api/reports/sales": a request's method and path, when it has a path. */
function requestName(trace: TraceSummary): string | null {
  if (!trace.path) return null;
  return trace.method ? `${trace.method} ${trace.path}` : trace.path;
}

/** A linked trace (or a group of them) on one line, a link to it where the host gives one; `note` after its name. */
export function LinkedTrace({
  group,
  links,
  note,
}: {
  group: Group;
  links?: TraceLinks | undefined;
  note?: ReactNode | undefined;
}) {
  const trace = group.first;
  const body = (
    <span className="flex min-w-0 items-center gap-2">
      <LinkBadge trace={trace} />
      <LinkedName trace={trace} />
      {note}
      <Tally group={group} />
    </span>
  );
  if (!links?.trace) return body;
  return (
    <a className="block w-full rounded-md py-0.5 text-left hover:bg-accent" {...traceLinkProps(links, trace.id)}>
      {body}
    </a>
  );
}

function groupKey(trace: TraceSummary): string {
  return `${trace.kind} ${trace.path ?? trace.name}`;
}

/** Traces of the same kind and name as one row: 36 deliveries to one listener. */
export function grouped(traces: readonly TraceSummary[]): Group[] {
  const groups = new Map<string, Group>();
  for (const trace of traces) {
    const group = groups.get(groupKey(trace)) ?? { first: trace, count: 0, failed: 0 };
    group.count += 1;
    group.failed += Number(trace.status === "error");
    groups.set(groupKey(trace), group);
  }
  return [...groups.values()];
}

/** Each trace on its own line, unless grouped. */
export function single(trace: TraceSummary): Group {
  return { first: trace, count: 1, failed: Number(trace.status === "error") };
}

/** Traces under one label, those of one name folded into one line: one alone, or several with their count. */
export function tracesRow(
  one: string,
  plural: string,
  traces: readonly TraceSummary[],
  links: TraceLinks | undefined,
  note?: (trace: TraceSummary) => ReactNode,
): PropRow[] {
  if (traces.length === 0) return [];
  const value = (
    // One column no wider than the value's: a long name is cut, it doesn't push the row past the panel's edge.
    <span className="grid w-full grid-cols-[minmax(0,1fr)] gap-0.5">
      {grouped(traces).map((group) => (
        <LinkedTrace key={group.first.id} group={group} links={links} note={note?.(group.first)} />
      ))}
    </span>
  );
  return [{ label: traces.length === 1 ? one : `${plural} (${traces.length})`, value }];
}
