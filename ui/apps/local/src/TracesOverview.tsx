import {
  CallsChart,
  type DataSource,
  duration,
  LatencyChart,
  MethodBadge,
  type OperationStats,
  type TracesOverview as Overview,
  percent,
  RoutePath,
  SearchError,
  Stat,
  StatGrid,
} from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { Card } from "@tracepanel/ui/components/ui/card";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { track, useRefresh } from "./refresh";
import { currentPeriod, endpointGroup, groupRoute, href, withPeriod } from "./routes";
import { BY_NAME } from "./sections";
import { rangeTerms } from "./time";

const STORAGE_KEY = "tracepanel:overview";

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "closed";
  } catch {
    return true;
  }
}

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

const KIND_BADGES: Record<string, string> = { command: "job", websocket: "ws" };

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
}

/** Monitoring over every request the current search matches: volume, errors, latency, worst endpoints. */
export function TracesOverview({
  q,
  scope = ALL_TRACES,
  variant = "dashboard",
  source,
  onRefine,
}: TracesOverviewProps) {
  const query = [scope.filter, q].filter(Boolean).join(" ");
  const nouns = `${scope.noun}s`;
  const [overview, setOverview] = useState<Overview | null>(null);
  // A search the overview can't run: said, not hidden behind the last result.
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(readOpen);

  const { cycle, tick } = useRefresh();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reloads on "refresh now", `cycle` on the clock.
  useEffect(() => {
    let cancelled = false;
    // A rejected search is the query's fault, not a failed refresh.
    track(source.tracesOverview(query, scope.groupBy), (error) => !(error instanceof SearchError)).then(
      (result) => {
        if (cancelled) return;
        setOverview(result);
        setFailed(null);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setOverview(null);
        setFailed(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [query, scope.groupBy, source, cycle, tick]);

  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(STORAGE_KEY, open ? "closed" : "open");
    } catch {
      // Private mode: the choice lasts until reload.
    }
  };

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
        {overview.kinds.length > 1 ? (
          <div className="flex flex-wrap gap-2">
            {overview.kinds.map((kind) => (
              <button
                key={kind.kind}
                type="button"
                className="flex items-center gap-2 rounded-full border bg-card px-3.5 py-1.5 text-sm hover:bg-accent"
                onClick={() => onRefine({ kind: kind.kind })}
              >
                <span className="font-medium">{KIND_LABEL[kind.kind] ?? kind.kind}</span>
                <span className="text-muted-foreground tabular-nums">{kind.calls}</span>
              </button>
            ))}
          </div>
        ) : null}
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
    <section className="grid gap-5 pb-8" aria-label="Overview">
      <header>
        <button
          type="button"
          className="group/overview flex w-full items-center gap-3 rounded-md py-1 text-left"
          onClick={toggle}
          aria-expanded={open}
        >
          <ChevronRightIcon
            className={`size-5 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
          />
          <h2 className="text-xl font-semibold">Overview</h2>
          {open ? (
            <span className="text-base text-muted-foreground">
              {new Date(s.first_seen / 1000).toLocaleString()} – {new Date(s.last_seen / 1000).toLocaleTimeString()}
            </span>
          ) : (
            // Folded: the numbers that matter, on one line.
            <span className="flex flex-wrap gap-x-4 text-md text-text-2 tabular-nums">
              <span>
                {s.calls} {s.calls === 1 ? scope.noun : nouns}
              </span>
              <span className={s.errors ? "text-error" : ""}>{percent(s.errors, s.calls)} errors</span>
              <span>p95 {duration(s.p95)}</span>
              {s.slow ? <span className="text-warn">{s.slow} slow</span> : null}
            </span>
          )}
        </button>
      </header>
      {open ? (
        <>
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
            <Stat label="p50" value={duration(s.p50)} />
            <Stat label="p95" value={duration(s.p95)} />
            <Stat label="p99" value={duration(s.p99)} sub={`max ${duration(s.max)}`} />
            <Stat label="Avg queries" value={String(s.avg_queries)} sub={`DB ${duration(s.avg_db_time)} avg`} />
          </StatGrid>
          {scope.filter === "" && overview.kinds.length > 1 ? (
            <div className="flex flex-wrap gap-2">
              {overview.kinds.map((kind) => (
                <button
                  key={kind.kind}
                  type="button"
                  className="flex items-center gap-2 rounded-full border bg-card px-3.5 py-1.5 text-sm hover:bg-accent"
                  onClick={() => onRefine({ kind: kind.kind })}
                >
                  <span className="font-medium">{KIND_LABEL[kind.kind] ?? kind.kind}</span>
                  <span className="text-muted-foreground tabular-nums">{kind.calls}</span>
                  {kind.errors ? <span className="text-error tabular-nums">· {kind.errors} failed</span> : null}
                </button>
              ))}
            </div>
          ) : null}
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
        </>
      ) : null}
    </section>
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
      <ul className="grid">
        {items.map((item) => (
          <li key={`${item.kind} ${item.name}`}>
            <a
              href={operationHref(item)}
              className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-2 text-left text-sm hover:bg-accent"
            >
              {item.kind === "http" && item.name.startsWith("GraphQL ") ? (
                <>
                  <MethodBadge method="GQL" />
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
                  <Badge variant="outline" className="font-mono text-2xs uppercase">
                    {KIND_BADGES[item.kind] ?? item.kind}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
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
