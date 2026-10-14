import {
  type DataSource,
  duration,
  Empty,
  type GraphqlDetail,
  IssueGroupList,
  MethodBadge,
  percent,
  RoutePath,
  type TraceGroup,
} from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import { ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { CallsChart, Histogram, LatencyChart, Stat } from "./Charts";
import { PeriodChip } from "./PeriodChip";
import { RefreshControl, track, useRefresh } from "./refresh";
import { type EntrySection, go, href, issueRoute, traceHref, withPeriod } from "./routes";
import { ENTRY } from "./sections";
import { TracesTable } from "./tables";
import { Breadcrumbs, DataTable, Loading, Meter, Mono, Td, Th, Tr } from "./ui";

type Group = TraceGroup | GraphqlDetail;

/**
 * The data of one group over a period: a GraphQL operation has its own endpoint (with resolvers, and no period),
 * the rest is a search.
 */
function load(source: DataSource, section: EntrySection, key: string, period: string): Promise<Group | null> {
  if (section === "graphql") return source.getGraphqlOperation(key);
  return source.summarizeTraces(`${ENTRY[section].group(key)} ${period}`.trim());
}

function Title({ section, groupKey }: { section: EntrySection; groupKey: string }) {
  if (section === "endpoints") {
    const [method = "GET", ...route] = groupKey.split(" ");
    return (
      <>
        <MethodBadge method={method} />
        <RoutePath path={route.join(" ")} />
      </>
    );
  }
  const badge = { graphql: "GQL", tasks: "TASK", websockets: "WS", jobs: "JOB", rpc: "RPC", pages: "PAGE" }[section];
  return (
    <>
      <MethodBadge method={badge} />
      <span className="truncate">{groupKey}</span>
    </>
  );
}

export function GroupPage({
  section,
  groupKey,
  period,
  source,
}: {
  section: EntrySection;
  groupKey: string;
  /** The since:/until: of the list it was opened from, if any. */
  period: string;
  source: DataSource;
}) {
  const [group, setGroup] = useState<Group | null | undefined>(undefined);
  const { cycle, tick } = useRefresh();
  const entry = ENTRY[section];
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reloads on "refresh now", `cycle` on the clock.
  useEffect(() => {
    let cancelled = false;
    track(load(source, section, groupKey, period)).then(
      (result) => !cancelled && setGroup(result),
      () => !cancelled && setGroup(null),
    );
    return () => {
      cancelled = true;
    };
  }, [section, groupKey, period, source, cycle, tick]);

  if (group === undefined) return <Loading />;
  if (group === null || group.summary === null) {
    return (
      <Empty
        title={`No calls of ${groupKey}`}
        action={<a href={href({ name: section, q: period })}>All {ENTRY[section].label}</a>}
      >
        It has no stored traces yet.
      </Empty>
    );
  }
  const s = group.summary;
  const errors = group.issues.filter((issue) => issue.kind === "error");
  const findings = group.issues.filter((issue) => issue.kind !== "error");
  const graphql = "resolvers" in group ? group : null;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-9 px-10 pt-7 pb-16 *:min-w-0">
      {/* One column no wider than the page: a long error message or SQL wraps instead of widening it. */}
      <header className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <Breadcrumbs
            items={[{ label: entry.label, href: href({ name: section, q: period }) }, { label: groupKey }]}
          />
          <RefreshControl />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex min-w-0 flex-1 items-center gap-3 font-mono text-2xl font-semibold">
            <Title section={section} groupKey={groupKey} />
          </h1>
          <Button
            variant="outline"
            onClick={() =>
              go({
                name: section,
                q: withPeriod(entry.group(groupKey).replace(entry.scope, "").trim(), period),
                view: "calls",
              })
            }
          >
            {s.calls === 1 ? "View the call" : `View all ${s.calls} calls`}
            <ArrowRightIcon />
          </Button>
        </div>
        <PeriodChip
          period={period}
          allTime={href({ name: "group", section, key: groupKey })}
          unsupported={
            section === "graphql" ? "an operation's detail has no period, so this shows all time" : undefined
          }
        />
      </header>

      <section className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2.5" aria-label="Summary">
        <Stat
          label="Calls"
          value={String(s.calls)}
          sub={`since ${new Date(s.first_seen / 1000).toLocaleTimeString()}`}
        />
        <Stat
          label="Errors"
          value={percent(s.errors, s.calls)}
          sub={`${s.errors} of ${s.calls}`}
          tone={s.errors > 0 ? "error" : undefined}
        />
        <Stat label="p50" value={duration(s.p50)} />
        <Stat label="p75" value={duration(s.p75)} />
        <Stat label="p90" value={duration(s.p90)} />
        <Stat label="p95" value={duration(s.p95)} tone={s.p95 > 500_000 ? "warn" : undefined} />
        <Stat label="p99" value={duration(s.p99)} sub={`max ${duration(s.max)}`} />
        <Stat label="Avg queries" value={String(s.avg_queries)} sub={`DB ${duration(s.avg_db_time)} avg`} />
      </section>

      <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1 [&>:first-child]:col-span-full">
        <LatencyChart series={group.series} />
        <CallsChart series={group.series} />
        <Histogram histogram={group.histogram} p50={s.p50} p95={s.p95} />
      </div>

      {graphql ? <Resolvers operation={graphql} /> : null}

      {/* What failed, then what could be better: the same split as the menu's Errors and Issues. */}
      {errors.length > 0 ? (
        <section>
          <h2 className="mb-2.5 text-xl font-semibold">
            Errors{" "}
            <span className="font-normal text-muted-foreground">
              · in {s.errors} of {s.calls} calls
            </span>
          </h2>
          <IssueGroupList
            issues={errors.map((issue) => ({ ...issue, occurrences: issue.calls }))}
            hrefFor={(issue) => href(issueRoute(issue.fingerprint, issue.kind))}
          />
        </section>
      ) : null}
      {findings.length > 0 ? (
        <section>
          <h2 className="mb-2.5 text-xl font-semibold">
            Issues{" "}
            <span className="font-normal text-muted-foreground">
              · in {s.with_issues} of {s.calls} calls
            </span>
          </h2>
          <IssueGroupList
            issues={findings.map((issue) => ({ ...issue, occurrences: issue.calls }))}
            hrefFor={(issue) => href(issueRoute(issue.fingerprint, issue.kind))}
          />
        </section>
      ) : null}

      <div className="grid gap-7">
        <section>
          <h2 className="mb-2.5 text-xl font-semibold">Slowest calls</h2>
          <TracesTable items={group.slowest} selectedId={null} hrefFor={traceHref} />
        </section>
        <section>
          <h2 className="mb-2.5 text-xl font-semibold">Recent calls</h2>
          <TracesTable items={group.recent} selectedId={null} hrefFor={traceHref} />
        </section>
      </div>
    </div>
  );
}

/** Where a GraphQL operation spends its time: each resolver, how often it runs per call, its SQL per call. */
function Resolvers({ operation }: { operation: GraphqlDetail }) {
  const slowest = Math.max(...operation.resolvers.map((row) => row.total), 1);
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
      <h2 className="text-xl font-semibold">
        Resolvers{" "}
        <span className="font-normal text-muted-foreground">· your resolvers in this operation, most time first</span>
      </h2>
      {operation.document ? (
        <pre className="m-0 overflow-auto rounded-md border bg-muted/60 px-4 py-3 font-mono text-sm whitespace-pre-wrap">
          {operation.document}
        </pre>
      ) : null}
      {operation.resolvers.length > 0 ? (
        <DataTable
          head={
            <>
              <Th>Field</Th>
              <Th num>Runs / call</Th>
              <Th num>Queries / call</Th>
              <Th>Total time</Th>
              <Th num>p95</Th>
            </>
          }
        >
          {operation.resolvers.map((row) => (
            <Tr key={row.field} tone={row.queries_per_call > row.per_call && row.per_call > 1 ? "warn" : undefined}>
              <Td>
                <Mono>{row.field}</Mono>
              </Td>
              <Td num className={row.per_call > 1 ? "font-semibold" : ""}>
                {row.per_call}
              </Td>
              <Td num className={row.queries_per_call > 1 ? "font-semibold text-warn" : ""}>
                {row.queries_per_call}
              </Td>
              <Td>
                <Meter value={row.total} max={slowest}>
                  {duration(row.total)}
                </Meter>
              </Td>
              <Td num>{duration(row.p95)}</Td>
            </Tr>
          ))}
        </DataTable>
      ) : (
        <p className="text-muted-foreground">Only fields that read attributes: no resolvers of yours ran.</p>
      )}
    </section>
  );
}
