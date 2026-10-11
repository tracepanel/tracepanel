import { type DataSource, Empty, type KnownValues, type SearchResource, type SearchSpec } from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { type ReactNode, useCallback } from "react";
import { usePaged, useSearch } from "./data";
import { EmptyPage } from "./EmptyPage";
import { RefreshControl } from "./refresh";
import { type EntrySection, type EntryView, go, href, traceHref } from "./routes";
import { SearchBar } from "./SearchBar";
import { ENTRY } from "./sections";
import {
  GRAPHQL_OPERATIONS,
  HTTP_REQUESTS,
  JOB_RUNS,
  type OverviewScope,
  TASK_RUNS,
  TracesOverview,
  WEBSOCKET_EVENTS,
} from "./TracesOverview";
import { EndpointsTable, GraphqlTable, JobsTable, TasksTable, TracesTable, WebsocketsTable } from "./tables";
import { Loading, LoadMore, PageHeader } from "./ui";

const SCOPES: Record<EntrySection, OverviewScope> = {
  endpoints: HTTP_REQUESTS,
  graphql: GRAPHQL_OPERATIONS,
  tasks: TASK_RUNS,
  websockets: WEBSOCKET_EVENTS,
  jobs: JOB_RUNS,
};

const GRAPHQL_TYPES = ["query", "mutation", "subscription"] as const;

/** Replaces the terms of the given keys in a query, keeps the rest. */
export function refineQuery(q: string, terms: Record<string, string>): string {
  const keys = Object.keys(terms);
  const kept = q
    .split(/\s+/)
    .filter((token) => token && !keys.some((key) => new RegExp(`^${key}(:|>|<|!)`).test(token)));
  const added = Object.entries(terms)
    .filter(([, value]) => value)
    .map(([key, value]) => (/^[<>!]/.test(value) ? `${key}${value}` : `${key}:${value}`));
  return [...kept, ...added].join(" ");
}

const TERM = /^([a-z][\w.]*)(:|>=|<=|!=|>|<)/;

/**
 * The search of one view for the other: the overview of groups and the list of calls speak different filter
 * languages (`type:mutation` vs `operation:mutation*`), so a term goes along when the other view knows its key, in
 * that view's words. Time, free text and shared filters carry over: a range picked on the overview stays.
 */
export function carryQuery(q: string, target: ReadonlySet<string> | null, toCalls: boolean): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (toCalls) return token.replace(/^type:(\w+)$/, "operation:$1*");
      return token.replace(/^operation:(\w+)\*$/, "type:$1");
    })
    .filter((token) => {
      const key = TERM.exec(token)?.[1];
      return key === undefined || target === null || target.has(key);
    })
    .join(" ");
}

/** What one row of the grouped list is: "By task". */
const GROUP_NOUN: Record<EntrySection, string> = {
  endpoints: "endpoint",
  graphql: "operation",
  tasks: "task",
  websockets: "consumer",
  jobs: "job",
};

interface EntryPageProps {
  section: EntrySection;
  q: string;
  view: EntryView;
  source: DataSource;
  spec: SearchSpec | null;
  known: KnownValues;
}

/**
 * One entry point, the same shape for all: an overview (monitoring and its groups: endpoints, operations, tasks,
 * consumers, jobs) and its calls (traces of this kind only, newest first). Every row opens a group page or a trace.
 */
export function EntryPage({ section, q, view, source, spec, known }: EntryPageProps) {
  const entry = ENTRY[section];
  // Before the search spec loads, every term goes along.
  const keysOf = (resource: SearchResource) => (spec ? new Set(Object.keys(spec[resource] ?? {})) : null);
  // Typing replaces the entry, so Back skips the letters; a chip or a menu adds one, so Back undoes it.
  const setQuery = (next: string, typed = false) => go({ name: section, q: next, view }, typed);
  const refine = (terms: Record<string, string>) => go({ name: section, q: refineQuery(q, terms), view });

  const groups = useSearch(
    useCallback(
      (query: string): Promise<readonly unknown[]> => {
        if (view === "calls") return Promise.resolve([]);
        if (section === "endpoints") return source.listEndpoints(query);
        if (section === "graphql") return source.listGraphql(query);
        if (section === "tasks") return source.listTasks(query);
        if (section === "websockets") return source.listWebsockets(query);
        return source.listJobs(query);
      },
      [source, section, view],
    ),
    q,
  );
  const calls = usePaged(
    useCallback(
      (query: string, before: number | null) =>
        view === "calls"
          ? source.searchTraces([entry.scope, query].join(" ").trim(), before)
          : Promise.resolve({ items: [], next: null }),
      [source, entry.scope, view],
    ),
    q,
  );

  const loaded =
    view === "calls"
      ? { size: calls.items?.length, error: calls.error }
      : { size: groups.data?.length, error: groups.error };

  // Nothing stored for this entry point at all (not a search that matched nothing): no search or overview to show.
  if (!q && loaded.size === 0) {
    return (
      <EmptyPage
        section={section}
        title={entry.title}
        description={entry.description}
        empty={`No ${entry.label} traffic yet`}
      >
        {entry.calls} show up here as your app handles them.
      </EmptyPage>
    );
  }

  let list: ReactNode;
  if (view === "calls") {
    list = calls.items ? (
      calls.items.length ? (
        <>
          <TracesTable items={calls.items} selectedId={null} hrefFor={traceHref} />
          {calls.hasMore ? <LoadMore label="Load older" loading={calls.loading} onMore={calls.more} /> : null}
        </>
      ) : (
        <Empty title={q ? "Nothing matches" : `No ${entry.calls.toLowerCase()} yet`}>Try a broader search.</Empty>
      )
    ) : (
      <Loading />
    );
  } else if (!groups.data) {
    list = <Loading />;
  } else if (groups.data.length === 0) {
    list = (
      <Empty title={q ? "Nothing matches" : `No ${entry.label} traffic yet`}>It shows up after the first call.</Empty>
    );
  } else {
    list = {
      endpoints: () => <EndpointsTable items={groups.data as Parameters<typeof EndpointsTable>[0]["items"]} />,
      graphql: () => <GraphqlTable items={groups.data as Parameters<typeof GraphqlTable>[0]["items"]} />,
      tasks: () => <TasksTable items={groups.data as Parameters<typeof TasksTable>[0]["items"]} />,
      websockets: () => <WebsocketsTable items={groups.data as Parameters<typeof WebsocketsTable>[0]["items"]} />,
      jobs: () => <JobsTable items={groups.data as Parameters<typeof JobsTable>[0]["items"]} />,
    }[section]();
  }
  // One page: the overview (folded with its chevron), then the list, grouped or every call; both share the search.
  const body = (
    <>
      <TracesOverview
        q={carryQuery(q, keysOf("traces"), true)}
        scope={SCOPES[section]}
        source={source}
        onRefine={refine}
      />
      <nav className="mb-3 flex w-fit gap-1 rounded-lg border bg-card p-1" aria-label="List">
        {(["overview", "calls"] as const).map((item) => (
          <a
            key={item}
            href={href({
              name: section,
              view: item === "calls" ? "calls" : undefined,
              q: item === view ? q : carryQuery(q, keysOf(item === "calls" ? "traces" : section), item === "calls"),
            })}
            aria-current={view === item ? "page" : undefined}
            className={cn(
              "rounded-md px-3.5 py-1.5 text-md font-medium text-text-2 no-underline hover:bg-accent hover:text-foreground",
              view === item && "bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand",
            )}
          >
            {item === "overview" ? `By ${GROUP_NOUN[section]}` : `All ${entry.calls.toLowerCase()}`}
          </a>
        ))}
      </nav>
      {list}
    </>
  );

  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-background">
      <PageHeader title={entry.title} description={entry.description} actions={<RefreshControl />} />
      {section === "graphql" ? (
        <nav className="flex items-center gap-1 px-10 pt-4" aria-label="Operation type">
          <TypeFilter
            q={q}
            calls={view === "calls"}
            onChange={(type) => (view === "calls" ? refine({ operation: type ? `${type}*` : "" }) : refine({ type }))}
          />
        </nav>
      ) : null}
      <SearchBar
        section={view === "calls" ? "traces" : section}
        callsOf={view === "calls" ? section : undefined}
        q={q}
        spec={spec}
        error={loaded.error}
        known={known}
        count={loaded.size}
        onChange={setQuery}
      />
      <section className="min-h-0 flex-1 overflow-y-auto px-10 pb-10" aria-label={entry.title} data-scroll="">
        {body}
      </section>
    </main>
  );
}

/** All / Query / Mutation / Subscription for GraphQL operations: `type:` on the overview, `operation:…*` on calls. */
function TypeFilter({ q, calls, onChange }: { q: string; calls: boolean; onChange: (type: string) => void }) {
  const current = (calls ? /\boperation:(\w+)\*/ : /\btype:(\w+)/).exec(q)?.[1] ?? "";
  return (
    <fieldset className="ml-auto m-0 flex items-center gap-1 rounded-lg border p-0.5" aria-label="Operation type">
      {["", ...GRAPHQL_TYPES].map((type) => (
        <button
          key={type || "all"}
          type="button"
          aria-pressed={current === type}
          onClick={() => onChange(type)}
          className={cn(
            "rounded-md px-2.5 py-1 text-base text-muted-foreground capitalize hover:bg-accent",
            current === type && "bg-brand-soft font-medium text-brand",
          )}
        >
          {type || "All"}
        </button>
      ))}
    </fieldset>
  );
}
