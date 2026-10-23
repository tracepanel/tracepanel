import {
  CallsChart,
  type DataSource,
  duration,
  KindBadge,
  LatencyChart,
  MethodBadge,
  type OperationStats,
  type TracesOverview as Overview,
  percent,
  RoutePath,
  SearchError,
  Stat,
  StatGrid,
  TaskName,
} from "@tracepanel/ui";
import { Card } from "@tracepanel/ui/components/ui/card";
import { useEffect, useState } from "react";
import {
  Figure,
  LatencyTiles,
  Measure,
  OverviewNumbers,
  OverviewRange,
  OverviewSection,
  useOverviewOpen,
} from "./Overview";
import { track, useRefresh } from "./refresh";
import { currentPeriod, endpointGroup, groupRoute, href, withPeriod } from "./routes";
import { BY_NAME } from "./sections";
import { rangeTerms } from "./time";

/** What the overview counts: every trace (Traces) or one kind of entry point (HTTP requests). */
export interface OverviewScope {
  /** Added to the search, e.g. "kind:http". */
  filter: string;
  /** Singular noun for one unit: "trace", "request". */
  noun: string;
  /** Heading of the operation lists: "operations", "endpoints". */
  group: string;
  /** How the lists group traces: by method + route for HTTP (GraphQL operations are one endpoint there). */
  groupBy?: "operation" | "endpoint";
}

export const ALL_TRACES: OverviewScope = { filter: "", noun: "trace", group: "operations" };
export const HTTP_REQUESTS: OverviewScope = {
  filter: "kind:http",
  noun: "request",
  group: "endpoints",
  groupBy: "endpoint",
};
export const TASK_RUNS: OverviewScope = { filter: "kind:task", noun: "run", group: "tasks" };
export const GRAPHQL_OPERATIONS: OverviewScope = { filter: "operation:*", noun: "operation", group: "operations" };
export const WEBSOCKET_EVENTS: OverviewScope = { filter: "kind:websocket", noun: "event", group: "events" };
export const JOB_RUNS: OverviewScope = { filter: "kind:command", noun: "run", group: "jobs" };
export const RPC_CALLS: OverviewScope = { filter: "kind:rpc", noun: "call", group: "methods" };
// A page's views and the actions on it together: events.
export const PAGE_VIEWS: OverviewScope = { filter: "kind:page", noun: "event", group: "pages" };

const KIND_LABEL: Record<string, string> = {
  http: "HTTP requests",
  task: "Tasks",
  command: "Jobs",
  websocket: "WebSocket events",
};

interface TracesOverviewProps {
  q: string;
  scope?: OverviewScope;
  /**
   * `dashboard`: monitoring for an entry point (stats, latency, worst operations), e.g. HTTP.
   * `activity`: just the volume over time to pick a range from, for the trace explorer.
   */
  variant?: "dashboard" | "activity";
  source: DataSource;
  /** Sets filters on the search: keys given here replace the same keys in the query. */
  onRefine: (terms: Record<string, string>) => void;
  /** Called once its first answer came, whatever it was: a page shows it and what is under it together. */
  onSettled?: (() => void) | undefined;
  /** Open until the reader folds it (the default), or folded until they open it. */
  openByDefault?: boolean | undefined;
}

/**
 * The overview of a search, reloaded with the console's clock; `onSettled` once its first answer came, whatever it
 * was. A search it can't run is said, not hidden behind the last result.
 */
function useOverview(
  source: DataSource,
  query: string,
  groupBy: OverviewScope["groupBy"],
  onSettled: (() => void) | undefined,
): { overview: Overview | null; failed: string | null } {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { cycle, tick } = useRefresh();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reloads on "refresh now", `cycle` on the clock; a new `onSettled` is no new search.
  useEffect(() => {
    let cancelled = false;
    const settle = (result: Overview | null, reason: string | null) => {
      if (cancelled) return;
      setOverview(result);
      setFailed(reason);
      onSettled?.();
    };
    // A rejected search is the query's fault, not a failed refresh.
    track(source.tracesOverview(query, groupBy), (error) => !(error instanceof SearchError)).then(
      (result) => settle(result, null),
      (reason: unknown) => settle(null, reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      cancelled = true;
    };
  }, [query, groupBy, source, cycle, tick]);
  return { overview, failed };
}

/** Monitoring over every request the current search matches: volume, errors, latency, worst endpoints. */
export function TracesOverview({
  q,
  scope = ALL_TRACES,
  variant = "dashboard",
  source,
  onRefine,
  onSettled,
  openByDefault = true,
}: TracesOverviewProps) {
  const query = [scope.filter, q].filter(Boolean).join(" ");
  const nouns = `${scope.noun}s`;
  const { overview, failed } = useOverview(source, query, scope.groupBy, onSettled);
  const [open, toggle] = useOverviewOpen(openByDefault);

  if (failed) {
    return (
      <p className="pb-6 text-sm text-error" role="alert">
        The overview can't use this search: {failed}
      </p>
    );
  }
  if (!overview || overview.series.length === 0) return null;
  const s = overview.summary;
  if (!s || variant === "activity") {
    // An empty window still shows its timeline, so a range can be widened again from the chart.
    return (
      <section className="grid gap-3 pb-6" aria-label="Activity">
        <KindChips kinds={overview.kinds} failures={false} onRefine={onRefine} />
        <CallsChart
          series={overview.series}
          title={`${capitalize(nouns)} over time`}
          noun={scope.noun}
          onSelect={(start, end) => onRefine(rangeTerms(start, end))}
        />
      </section>
    );
  }
  const threshold = duration(overview.slow_threshold);
  return (
    <OverviewSection
      open={open}
      onToggle={toggle}
      range={<OverviewRange from={s.first_seen} to={s.last_seen} />}
      numbers={
        // Folded: the numbers that matter, on one line.
        <TracesNumbers summary={s} scope={scope} />
      }
    >
      <StatGrid>
        <Stat label={capitalize(nouns)} value={String(s.calls)} sub={`${s.with_issues} with issues`} />
        <Stat
          label="Errors"
          value={percent(s.errors, s.calls)}
          sub={`${s.errors} of ${s.calls}`}
          tone={s.errors ? "error" : undefined}
          onClick={s.errors ? () => onRefine({ has: "error" }) : undefined}
        />
        <Stat
          label={`Slow ≥ ${threshold}`}
          value={String(s.slow)}
          sub={percent(s.slow, s.calls)}
          tone={s.slow ? "warn" : undefined}
          onClick={s.slow ? () => onRefine({ duration: `>${overview.slow_threshold / 1000}ms` }) : undefined}
        />
        <LatencyTiles summary={s} />
      </StatGrid>
      {scope.filter === "" ? <KindChips kinds={overview.kinds} failures={true} onRefine={onRefine} /> : null}
      <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
        <CallsChart
          series={overview.series}
          title={`${capitalize(nouns)} over time`}
          noun={scope.noun}
          onSelect={(start, end) => onRefine(rangeTerms(start, end))}
        />
        <LatencyChart series={overview.series} />
      </div>
      <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
        <OperationList
          title={`Slowest ${scope.group}`}
          empty={`No ${nouns} yet.`}
          items={overview.slowest}
          noun={scope.noun}
          metric={(item) => `p95 ${duration(item.p95)}`}
        />
        <OperationList
          title={`Failing ${scope.group}`}
          empty="No errors in this range."
          items={overview.failing}
          noun={scope.noun}
          metric={(item) => `${item.errors} ${item.errors === 1 ? "error" : "errors"}`}
          tone="error"
        />
      </div>
    </OverviewSection>
  );
}

/** The Overview folded: how many, how many failed, p95, and how many were slow when any were. */
function TracesNumbers({ summary: s, scope }: { summary: NonNullable<Overview["summary"]>; scope: OverviewScope }) {
  return (
    <OverviewNumbers>
      <Figure value={s.calls.toLocaleString()} label={s.calls === 1 ? scope.noun : `${scope.noun}s`} />
      <Figure value={percent(s.errors, s.calls)} label="errors" tone={s.errors ? "error" : "plain"} />
      <Measure label="p95" value={duration(s.p95)} />
      {s.slow ? <Figure value={s.slow.toLocaleString()} label="slow" tone="warn" /> : null}
    </OverviewNumbers>
  );
}

/** The kinds of traces the overview counts, each a chip that narrows to it (`failures`: how many of each failed). */
function KindChips({
  kinds,
  failures,
  onRefine,
}: {
  kinds: Overview["kinds"];
  failures: boolean;
  onRefine: (terms: Record<string, string>) => void;
}) {
  if (kinds.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {kinds.map((kind) => (
        <button
          key={kind.kind}
          type="button"
          className="flex items-center gap-2 rounded-full border bg-card px-3.5 py-1.5 text-sm hover:bg-accent"
          onClick={() => onRefine({ kind: kind.kind })}
        >
          <span className="font-medium">{KIND_LABEL[kind.kind] ?? kind.kind}</span>
          <span className="text-muted-foreground tabular-nums">{kind.calls}</span>
          {failures && kind.errors ? <span className="text-error tabular-nums">· {kind.errors} failed</span> : null}
        </button>
      ))}
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Where an operation opens: its group page (an endpoint, a GraphQL operation, a task, a job), else a search. */
function operationHref(item: OperationStats): string {
  const operation = item.kind === "http" && item.name.startsWith("GraphQL ") ? item.name.slice(8) : null;
  if (operation) return href(groupRoute("graphql", operation));
  if (item.kind === "http" && item.method && item.route) {
    return href(endpointGroup(item.method, item.route));
  }
  const named = BY_NAME[item.kind];
  if (named) return href(groupRoute(named, item.name));
  if (item.kind === "websocket" && item.view) return href(groupRoute("websockets", item.view));
  return href({ name: "traces", q: withPeriod(`kind:${item.kind} name:"${item.name}"`, currentPeriod()) });
}

/** An operation's name after its kind: a task's cut where a task's name is everywhere. */
function OperationName({ item }: { item: OperationStats }) {
  if (item.kind === "task") return <TaskName name={item.name} className="flex-1" />;
  return <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>;
}

function OperationList({
  title,
  empty,
  items,
  noun,
  metric,
  tone,
}: {
  title: string;
  empty: string;
  items: readonly OperationStats[];
  /** What one of its traces is: "request", "run", "event". */
  noun: string;
  metric: (item: OperationStats) => string;
  tone?: "error";
}) {
  return (
    <Card className="gap-2 px-4 py-3.5 shadow-none">
      <h3 className="text-md font-semibold">{title}</h3>
      {items.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : null}
      {/* One column no wider than the card: a long name is cut short, it doesn't widen the page. */}
      <ul className="grid grid-cols-[minmax(0,1fr)]">
        {items.map((item) => (
          <li key={`${item.kind} ${item.name}`}>
            <a
              href={operationHref(item)}
              className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-2 text-left text-sm hover:bg-accent"
            >
              {item.kind === "http" && item.name.startsWith("GraphQL ") ? (
                <>
                  <KindBadge kind="graphql" />
                  <span className="min-w-0 flex-1 truncate font-mono">{item.name.slice("GraphQL ".length)}</span>
                </>
              ) : item.kind === "http" ? (
                <>
                  <MethodBadge method={item.method} />
                  <span className="min-w-0 flex-1 truncate">
                    {/* No route (a 404): the name is "GET /path", and the badge already says GET. */}
                    <RoutePath path={item.route || item.name.replace(/^[A-Z]+ /, "")} />
                  </span>
                </>
              ) : (
                <>
                  <KindBadge kind={item.kind} />
                  <OperationName item={item} />
                </>
              )}
              <span className="text-base whitespace-nowrap text-muted-foreground">
                {item.calls} {item.calls === 1 ? noun : `${noun}s`}
              </span>
              <b
                className={`min-w-24 text-right font-semibold whitespace-nowrap tabular-nums ${tone === "error" ? "text-error" : ""}`}
              >
                {metric(item)}
              </b>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
