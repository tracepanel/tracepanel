import type { ReactNode } from "react";
import { Badge } from "./components/ui/badge";
import { duration } from "./format";
import { linkProps, type TraceLinks } from "./links";
import type { PropRow } from "./PropTable";
import { MethodBadge } from "./primitives";
import type { TraceSummary } from "./types";

/** A task run's outcome, as its badge colours it. */
const STATE_TONE: Record<string, string> = {
  success: "border-ok/30 bg-ok-soft text-ok",
  failure: "border-error/30 bg-error-soft text-error",
  retry: "border-warn/30 bg-warn-soft text-warn",
};

/** How a task run ended: success, failure, retry. */
export function StateBadge({ state }: { state: string }) {
  const shown = state.toLowerCase();
  return (
    <Badge variant="outline" className={STATE_TONE[shown] ?? ""}>
      {shown}
    </Badge>
  );
}

/** Traces of the same kind and name as one: 36 deliveries to one listener, the first standing for them. */
export interface Group {
  first: TraceSummary;
  count: number;
  failed: number;
}

function TraceBadge({ trace }: { trace: TraceSummary }) {
  if (trace.kind === "http") return <MethodBadge method={trace.method} />;
  return (
    <Badge variant="outline" className="font-mono text-2xs uppercase">
      {trace.kind}
    </Badge>
  );
}

/** One alone: how a task run ended, or whether it failed. */
function Outcome({ trace }: { trace: TraceSummary }) {
  if (trace.task_state) return <StateBadge state={trace.task_state} />;
  return trace.status === "error" ? <span className="text-sm text-error">failed</span> : null;
}

/** How many it stands for and how many failed; one alone, how it ended and how long it took. */
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
      <span className="ml-auto shrink-0 text-sm text-muted-foreground tabular-nums">{duration(first.duration)}</span>
    </>
  );
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
      <TraceBadge trace={trace} />
      <span className="truncate font-mono text-base">{trace.path ?? trace.name}</span>
      {note}
      <Tally group={group} />
    </span>
  );
  if (!links?.trace) return body;
  return (
    <a
      className="block w-full rounded-md py-0.5 text-left hover:bg-accent"
      {...linkProps(links, links.trace(trace.id))}
    >
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
    <span className="grid w-full gap-0.5">
      {grouped(traces).map((group) => (
        <LinkedTrace key={group.first.id} group={group} links={links} note={note?.(group.first)} />
      ))}
    </span>
  );
  return [{ label: traces.length === 1 ? one : `${plural} (${traces.length})`, value }];
}
