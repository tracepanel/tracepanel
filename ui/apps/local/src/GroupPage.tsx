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
import { latencyTiles } from "./Overview";
import { PeriodChip } from "./PeriodChip";
import { RefreshControl, track, useRefresh } from "./refresh";
import { type EntrySection, go, href, issueRoute, periodOf, traceHref, withPeriod } from "./routes";
import { ENTRY } from "./sections";
import { type Noun, shareText, slowerText } from "./slower";
import { TimeRange } from "./TimeRange";
import { TracesTable } from "./tables";
import { rangeTerms } from "./time";
import { CrumbBar, Loading, Meter, Mono, Tr } from "./ui";

type Group = TraceGroup | GraphqlDetail;

/** What the page looks at besides the group: its period (since:/until:) and its list's Slower than terms. */
interface Scope {
  period: string;
  /** `duration>500ms`, `call:… call_duration>100ms`, or empty (see slowerTermsOf). */
  slower: string;
}

/** A group's page with these terms in its address. */
function groupHref(section: EntrySection, key: string, ...terms: string[]): string {
  const q = terms.filter(Boolean).join(" ");
  return href({ name: "group", section, key, q: q || undefined });
}

/** A group over another period, its Slower than kept: since:/until: in its address. */
function goPeriod(section: EntrySection, key: string, slower: string, since?: string, until?: string): void {
  const period = [since ? `since:${since}` : "", until ? `until:${until}` : ""].filter(Boolean).join(" ");
  const q = [period, slower].filter(Boolean).join(" ");
  go({ name: "group", section, key, q: q || undefined });
}

/** Drag on the calls chart to look at that stretch; none where the group has no period (a GraphQL operation). */
function zoom(section: EntrySection, key: string, slower: string) {
  if (section === "graphql") return undefined;
  return (start: number, end: number) => {
    const { since, until } = rangeTerms(start, end);
    goPeriod(section, key, slower, since, until);
  };
}

/** The period the page looks at, to pick another one: the same presets and range as a list's Time. */
function GroupPeriod({ section, groupKey, scope }: { section: EntrySection; groupKey: string; scope: Scope }) {
  const { period, slower } = scope;
  const [open, setOpen] = useState(false);
  if (section === "graphql") {
    return (
      <PeriodChip
        period={period}
        allTime={groupHref(section, groupKey, slower)}
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
      onChange={(since, until) => goPeriod(section, groupKey, slower, since, until)}
    />
  );
}

/** A group's data, and with Slower than on, how many calls it has in all (the "of 340"). */
interface Loaded {
  group: Group | null;
  all: number | null;
}

/**
 * The data of one group over a period: a GraphQL operation has its own endpoint (with resolvers, no period and no
 * Slower than), the rest is a search; with Slower than, of the slow calls, and how many it has in all beside.
 */
async function load(source: DataSource, section: EntrySection, key: string, scope: Scope): Promise<Loaded> {
  if (section === "graphql") return { group: await source.getGraphqlOperation(key), all: null };
  const search = (...terms: string[]) => source.summarizeTraces([ENTRY[section].group(key), ...terms].join(" ").trim());
  if (!scope.slower) return { group: await search(scope.period), all: null };
  const [group, all] = await Promise.all([search(scope.period, scope.slower), search(scope.period)]);
  return { group, all: all?.summary?.calls ?? 0 };
}

/** What the list a group's row is in calls its calls, as the row's "12 of 340 requests over 500 ms" says. */
const NOUNS: Partial<Record<EntrySection, Noun>> = {
  endpoints: ["request", "requests"],
  tasks: ["run", "runs"],
  websockets: ["connection", "connections"],
};

/**
 * The list's Slower than, kept: how many of the group's calls it keeps ("12 of 340 calls over 500 ms"), as the list's
 * row said, and the way to all of them. A GraphQL operation's page can't keep them: it says so.
 */
function SlowerChip({
  section,
  groupKey,
  scope,
  calls,
  all,
}: {
  section: EntrySection;
  groupKey: string;
  scope: Scope;
  calls: number;
  all: number | null;
}) {
  const over = slowerText(scope.slower);
  if (!over) return null;
  if (section === "graphql") {
    return (
      <p className="text-sm text-muted-foreground">
        {over} on the list: an operation's detail can't keep only those, so this shows all of its calls.
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="rounded-md border px-2 py-0.5 font-medium text-foreground">
        {shareText(calls, all, NOUNS[section] ?? ["call", "calls"], over)}
      </span>
      <a href={groupHref(section, groupKey, scope.period)} className="font-medium text-brand hover:underline">
        All calls
      </a>
    </p>
  );
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

/** A group with none of its calls in the page's scope: none stored yet, or none as slow as the list kept. */
function NoCalls({ section, groupKey, scope }: { section: EntrySection; groupKey: string; scope: Scope }) {
  const over = section === "graphql" ? null : slowerText(scope.slower);
  if (over) {
    return (
      <Empty
        title={`No calls of ${groupKey} ${over}`}
        action={<a href={groupHref(section, groupKey, scope.period)}>All its calls</a>}
        icon={SearchXIcon}
        page={true}
      >
        None of its calls in this period took that long.
      </Empty>
    );
  }
  return (
    <Empty
      title={`No calls of ${groupKey}`}
      action={<a href={href({ name: section, q: scope.period })}>All {ENTRY[section].label}</a>}
      icon={SearchXIcon}
      page={true}
    >
      It has no stored traces yet.
    </Empty>
  );
}

/** A group's data over its scope, reloaded by the refresh control; undefined while it loads. */
function useGroup(source: DataSource, section: EntrySection, groupKey: string, scope: Scope): Loaded | undefined {
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const { cycle, tick } = useRefresh();
  const { period, slower } = scope;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reloads on "refresh now", `cycle` on the clock.
  useEffect(() => {
    let cancelled = false;
    track(load(source, section, groupKey, { period, slower })).then(
      (result) => !cancelled && setLoaded(result),
      () => !cancelled && setLoaded({ group: null, all: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [section, groupKey, period, slower, source, cycle, tick]);
  return loaded;
}

/** The group's crumbs, its name, the way to its calls in the list, and what it looks at: its period, Slower than. */
function GroupHeader({
  section,
  groupKey,
  scope,
  calls,
  all,
}: {
  section: EntrySection;
  groupKey: string;
  scope: Scope;
  calls: number;
  all: number | null;
}) {
  const entry = ENTRY[section];
  const kept = section === "graphql" ? "" : scope.slower;
  const own = [entry.group(groupKey).replace(entry.scope, "").trim(), kept].join(" ").trim();
  return (
    <header className="grid gap-2">
      <CrumbBar
        items={[
          { label: entry.label, href: href({ name: section, q: scope.period }) },
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
          onClick={() => go({ name: section, q: withPeriod(own, scope.period), view: "calls" })}
        >
          {calls === 1 ? "View the call" : `View all ${calls} calls`}
          <ArrowRightIcon />
        </Button>
      </div>
      {/* Its own size, at the start of the line: the header's grid would stretch it across the page. */}
      <div className="flex flex-wrap items-center gap-3">
        <GroupPeriod section={section} groupKey={groupKey} scope={scope} />
        <SlowerChip section={section} groupKey={groupKey} scope={scope} calls={calls} all={all} />
      </div>
    </header>
  );
}

export function GroupPage({
  section,
  groupKey,
  period,
  slower,
  source,
}: {
  section: EntrySection;
  groupKey: string;
  /** The since:/until: of the list it was opened from, if any. */
  period: string;
  /** The list's Slower than terms (`duration>500ms`), if any: the page is of those calls (see slowerTermsOf). */
  slower: string;
  source: DataSource;
}) {
  const scope = { period, slower };
  const loaded = useGroup(source, section, groupKey, scope);
  if (loaded === undefined) return <Loading />;
  const { group, all } = loaded;
  if (group === null || group.summary === null) return <NoCalls section={section} groupKey={groupKey} scope={scope} />;
  const s = group.summary;
  const errors = group.issues.filter((issue) => issue.kind === "error");
  const findings = group.issues.filter((issue) => issue.kind !== "error");
  const graphql = "resolvers" in group ? group : null;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-9 px-10 pt-7 pb-16 *:min-w-0">
      {/* One column no wider than the page: a long error message or SQL wraps instead of widening it. */}
      <GroupHeader section={section} groupKey={groupKey} scope={scope} calls={s.calls} all={all} />

      {/* The tiles an entry point's Overview has, the same seven in the same order: one look for a summary. */}
      <StatGrid label="Summary">
        <Stat label="Calls" value={String(s.calls)} sub={`${s.with_issues} with issues`} />
        <Stat
          label="Errors"
          value={percent(s.errors, s.calls)}
          sub={`${s.errors} of ${s.calls}`}
          tone={s.errors > 0 ? "error" : undefined}
        />
        <Stat
          label="Slow ≥ 500 ms"
          value={String(s.slow)}
          sub={percent(s.slow, s.calls)}
          tone={s.slow ? "warn" : undefined}
        />
        {latencyTiles(s)}
      </StatGrid>

      <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1 [&>:first-child]:col-span-full">
        <LatencyChart series={group.series} />
        <CallsChart series={group.series} onSelect={zoom(section, groupKey, slower)} />
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
