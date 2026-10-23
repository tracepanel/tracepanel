import {
  CallsChart,
  type DataColumn,
  type DataSource,
  DataTable,
  duration,
  Empty,
  type GraphqlDetail,
  Histogram,
  IssueGroupList,
  LatencyChart,
  MethodBadge,
  percent,
  RoutePath,
  Stat,
  StatGrid,
  TaskName,
  TraceBadge,
  type TraceGroup,
} from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import { ArrowRightIcon, SearchXIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { PeriodChip } from "./PeriodChip";
import { RefreshControl, track, useRefresh } from "./refresh";
import { type EntrySection, go, href, issueRoute, periodOf, traceHref, withPeriod } from "./routes";
import { ENTRY } from "./sections";
import { TimeRange } from "./TimeRange";
import { TracesTable } from "./tables";
import { rangeTerms } from "./time";
import { CrumbBar, Loading, Meter, Mono, Tr } from "./ui";

type Group = TraceGroup | GraphqlDetail;

/** A group over another period: since:/until: in its address. */
function goPeriod(section: EntrySection, key: string, since: string | undefined, until: string | undefined): void {
  const period = [since ? `since:${since}` : "", until ? `until:${until}` : ""].filter(Boolean).join(" ");
  go({ name: "group", section, key, q: period || undefined });
}

/** Drag on the calls chart to look at that stretch; none where the group has no period (a GraphQL operation). */
function zoom(section: EntrySection, key: string) {
  if (section === "graphql") return undefined;
  return (start: number, end: number) => {
    const { since, until } = rangeTerms(start, end);
    goPeriod(section, key, since, until);
  };
}

/** The period the page looks at, to pick another one: the same presets and range as a list's Time. */
function GroupPeriod({ section, groupKey, period }: { section: EntrySection; groupKey: string; period: string }) {
  const [open, setOpen] = useState(false);
  if (section === "graphql") {
    return (
      <PeriodChip
        period={period}
        allTime={href({ name: "group", section, key: groupKey })}
        unsupported="an operation's detail has no period, so this shows all time"
      />
    );
  }
  const bound = (key: string) =>
    periodOf(period)
      .split(/\s+/)
      .find((term) => term.startsWith(`${key}:`))
      ?.slice(key.length + 1);
  return (
    <TimeRange
      since={bound("since")}
      until={bound("until")}
      open={open}
      onOpenChange={setOpen}
      onChange={(since, until) => goPeriod(section, groupKey, since, until)}
    />
  );
}

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
      <TraceBadge word={badge} />
      {section === "tasks" ? <TaskName name={groupKey} /> : <span className="truncate">{groupKey}</span>}
    </>
  );
}

/** The group's crumb, in the crumbs' own type: a task's name cut where it is everywhere. */
function crumb(section: EntrySection, groupKey: string): ReactNode {
  return section === "tasks" ? <TaskName name={groupKey} className="font-sans" /> : groupKey;
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
        icon={SearchXIcon}
        page={true}
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
        <CrumbBar
          items={[
            { label: entry.label, href: href({ name: section, q: period }) },
            { label: crumb(section, groupKey) },
          ]}
          actions={<RefreshControl />}
        />
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
        {/* Its own size, at the start of the line: the header's grid would stretch it across the page. */}
        <div className="flex">
          <GroupPeriod section={section} groupKey={groupKey} period={period} />
        </div>
      </header>

      <StatGrid label="Summary">
        <Stat
          label="Calls"
          value={String(s.calls)}
          sub={`since ${new Date(s.first_seen / 1000).toLocaleTimeString([], { hour12: false })}`}
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
      </StatGrid>

      <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1 [&>:first-child]:col-span-full">
        <LatencyChart series={group.series} />
        <CallsChart series={group.series} onSelect={zoom(section, groupKey)} />
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
          <TracesTable table="group:slowest" items={group.slowest} selectedId={null} hrefFor={traceHref} />
        </section>
        <section>
          <h2 className="mb-2.5 text-xl font-semibold">Recent calls</h2>
          <TracesTable table="group:recent" items={group.recent} selectedId={null} hrefFor={traceHref} />
        </section>
      </div>
    </div>
  );
}

type Resolver = GraphqlDetail["resolvers"][number];

function resolverColumns(slowest: number): DataColumn<Resolver>[] {
  return [
    { id: "field", label: "Field", required: true, cell: (row) => <Mono>{row.field}</Mono> },
    {
      id: "runs",
      label: "Runs / call",
      width: 8,
      num: true,
      className: (row) => (row.per_call > 1 ? "font-semibold" : undefined),
      cell: (row) => row.per_call,
    },
    {
      id: "queries",
      label: "Queries / call",
      width: 9,
      num: true,
      className: (row) => (row.queries_per_call > 1 ? "font-semibold text-warn" : undefined),
      cell: (row) => row.queries_per_call,
    },
    {
      id: "total",
      label: "Total time",
      width: 8.5,
      cell: (row) => (
        <Meter value={row.total} max={slowest}>
          {duration(row.total)}
        </Meter>
      ),
    },
    { id: "p95", label: "p95", width: 6.5, num: true, cell: (row) => duration(row.p95) },
  ];
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
        <DataTable table="resolvers" columns={resolverColumns(slowest)}>
          {({ cells }) =>
            operation.resolvers.map((row) => (
              <Tr key={row.field} tone={row.queries_per_call > row.per_call && row.per_call > 1 ? "warn" : undefined}>
                {cells(row)}
              </Tr>
            ))
          }
        </DataTable>
      ) : (
        <p className="text-muted-foreground">Only fields that read attributes: no resolvers of yours ran.</p>
      )}
    </section>
  );
}
