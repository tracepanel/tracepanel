import { CallsList } from "./CallsList";
import { duration } from "./format";
import { FAMILY_ORDER, type Family, systemOfSpan } from "./lib/systems";
import type { TraceLinks } from "./links";
import { type Explain, SqlList } from "./SqlList";
import type { IssueKind, Span, Trace } from "./types";

/** The request's calls to one system: its key ("sql", "redis", "neo4j"), what it is called, its spans. */
export interface SystemCalls {
  key: string;
  label: string;
  family: Family;
  spans: Span[];
  total: number;
}

/** The systems the request called, by family (as the sidebar lists them), then by name. */
export function systemCalls(trace: Trace): SystemCalls[] {
  const bySystem = new Map<string, SystemCalls>();
  for (const span of trace.spans) {
    const system = systemOfSpan(span);
    if (!system) continue;
    const calls = bySystem.get(system.kind) ?? {
      key: system.kind,
      label: system.label,
      family: system.family,
      spans: [],
      total: 0,
    };
    calls.spans.push(span);
    calls.total += span.duration;
    bySystem.set(system.kind, calls);
  }
  const rank = (calls: SystemCalls) => FAMILY_ORDER.indexOf(calls.family);
  return [...bySystem.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** The system a span's issue points at, to open the Calls tab on it. */
export function systemOfIssue(trace: Trace, spanId: string | undefined): string | undefined {
  const span = trace.spans.find((each) => each.id === spanId);
  return span ? systemOfSpan(span)?.kind : undefined;
}

/**
 * Every call the request made, one system at a time: SQL with its plans, the others grouped by what they repeat.
 * A switch picks the system; it opens on the one an issue points at, else the first.
 */
export function CallsTab({
  systems,
  system,
  onSystem,
  issueBySpan,
  focus,
  onExplain,
  links,
}: {
  systems: readonly SystemCalls[];
  system: string | undefined;
  onSystem: (system: string) => void;
  issueBySpan: ReadonlyMap<string, IssueKind>;
  focus: ReadonlySet<string> | undefined;
  onExplain?: Explain | undefined;
  links?: TraceLinks | undefined;
}) {
  const current = systems.find((each) => each.key === system) ?? systems[0];
  if (!current) return <p className="px-4 py-6 text-sm text-muted-foreground">No calls in this request.</p>;
  return (
    <div className="grid gap-1 pt-3">
      <div className="flex flex-wrap gap-1.5 px-4" role="tablist" aria-label="Systems">
        {systems.map((each) => (
          <button
            key={each.key}
            type="button"
            role="tab"
            aria-selected={each.key === current.key}
            onClick={() => onSystem(each.key)}
            className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm font-medium text-muted-foreground aria-selected:border-brand/40 aria-selected:bg-brand-soft aria-selected:text-foreground"
          >
            {each.label}
            <span className="font-mono tabular-nums">{each.spans.length}</span>
            <span className="text-xs tabular-nums">{duration(each.total)}</span>
          </button>
        ))}
      </div>
      {current.key === "sql" ? (
        <SqlList spans={current.spans} issueBySpan={issueBySpan} focus={focus} onExplain={onExplain} links={links} />
      ) : (
        <CallsList spans={current.spans} issueBySpan={issueBySpan} focus={focus} />
      )}
    </div>
  );
}
