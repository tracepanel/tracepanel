import {
  type DataSource,
  Empty,
  type KnownValues,
  type SearchResource,
  type SearchSpec,
  type TraceSummary,
} from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useLatch, usePaged, useSearch } from "./data";
import { EmptyPage, PageShell } from "./EmptyPage";
import { usePaintWhen } from "./firstPaint";
import { useNewIds } from "./hooks";
import { type Now, NowStrip, useNow } from "./LiveTasks";
import { LIVE_MS, RefreshControl, useRefresh } from "./refresh";
import { type EntrySection, type EntryView, go, href, traceHref } from "./routes";
import { SearchBar } from "./SearchBar";
import { ENTRY } from "./sections";
import {
  GRAPHQL_OPERATIONS,
  HTTP_REQUESTS,
  JOB_RUNS,
  type OverviewScope,
  PAGE_VIEWS,
  RPC_CALLS,
  TASK_RUNS,
  TracesOverview,
  WEBSOCKET_EVENTS,
} from "./TracesOverview";
import {
  EndpointsTable,
  GraphqlTable,
  JobsTable,
  PagesTable,
  RpcTable,
  TasksTable,
  TracesTable,
  WebsocketsTable,
} from "./tables";
import { Loading, LoadMore, PageHeader, Reveal } from "./ui";

const SCOPES: Record<EntrySection, OverviewScope> = {
  endpoints: HTTP_REQUESTS,
  graphql: GRAPHQL_OPERATIONS,
  tasks: TASK_RUNS,
  websockets: WEBSOCKET_EVENTS,
  jobs: JOB_RUNS,
  rpc: RPC_CALLS,
  pages: PAGE_VIEWS,
};

const GRAPHQL_TYPES = ["query", "mutation", "subscription"] as const;

/** Replaces the terms of the given keys in a query, keeps the rest. */
// A page of calls is cut by their start.
const startOf = (trace: { start: number }) => trace.start;

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
  rpc: "method",
  pages: "page",
};

/** The section's list, grouped: endpoints, operations, tasks, consumers, jobs or RPC methods. */
function listGroups(source: DataSource, section: EntrySection, query: string): Promise<readonly unknown[]> {
  const lists: Record<EntrySection, (q: string) => Promise<readonly unknown[]>> = {
    endpoints: (q) => source.listEndpoints(q),
    graphql: (q) => source.listGraphql(q),
    tasks: (q) => source.listTasks(q),
    websockets: (q) => source.listWebsockets(q),
    jobs: (q) => source.listJobs(q),
    rpc: (q) => source.listRpcs(q),
    pages: (q) => source.listPages(q),
  };
  return lists[section](query);
}

interface EntryPageProps {
  section: EntrySection;
  q: string;
  view: EntryView;
  source: DataSource;
  spec: SearchSpec | null;
  /** Undefined until loaded. */
  known: KnownValues | undefined;
  /** An old link to Tasks' Live (`view=live`): the page with Live on. */
  live?: boolean | undefined;
}

/** An old link to Tasks' Live, a list of its own once: Live chosen, at the page's own address. */
function useLiveLink(section: EntrySection, q: string, live: boolean | undefined): void {
  const { setInterval } = useRefresh();
  useEffect(() => {
    if (!live) return;
    setInterval(LIVE_MS);
    go({ name: section, q }, true);
  }, [live, section, q, setInterval]);
}

/** The lists of every entry point: its groups, every call. */
const VIEWS: readonly EntryView[] = ["overview", "calls"];

function viewLabel(section: EntrySection, view: EntryView): string {
  return view === "overview" ? `By ${GROUP_NOUN[section]}` : `All ${ENTRY[section].calls.toLowerCase()}`;
}

/** The search fields of a resource; null before the search spec loads, when every term goes along. */
function searchKeys(spec: SearchSpec | null, resource: SearchResource): ReadonlySet<string> | null {
  return spec ? new Set(Object.keys(spec[resource] ?? {})) : null;
}

/** The search a list's link takes along: its own as it is, the other list's in that list's words. */
function viewQuery(section: EntrySection, from: EntryView, to: EntryView, q: string, spec: SearchSpec | null): string {
  if (from === to) return q;
  const calls = to === "calls";
  return carryQuery(q, searchKeys(spec, calls ? "traces" : section), calls);
}

/** The switch between an entry point's lists: By task / All runs / Live. */
function ListNav({
  section,
  view,
  q,
  spec,
}: {
  section: EntrySection;
  view: EntryView;
  q: string;
  spec: SearchSpec | null;
}) {
  return (
    <nav className="mb-3 flex w-fit gap-1 rounded-lg border bg-card p-1" aria-label="List">
      {VIEWS.map((item) => (
        <a
          key={item}
          href={href({
            name: section,
            view: item === "overview" ? undefined : item,
            q: viewQuery(section, view, item, q, spec),
          })}
          aria-current={view === item ? "page" : undefined}
          className={cn(
            "rounded-md px-3.5 py-1.5 text-md font-medium text-text-2 no-underline hover:bg-accent hover:text-foreground",
            view === item && "bg-brand-soft text-brand hover:bg-brand-soft hover:text-brand",
          )}
        >
          {viewLabel(section, item)}
        </a>
      ))}
    </nav>
  );
}

/**
 * One entry point, the same shape for all: an overview (monitoring and its groups: endpoints, operations, tasks,
 * consumers, jobs) and its calls (traces of this kind only, newest first). Every row opens a group page or a trace.
 * Tasks have Now besides, what is in flight, above the overview, and Live in the header's auto-refresh, as on Logs.
 */
export function EntryPage(props: EntryPageProps) {
  const { section, q, view, source, live } = props;
  useLiveLink(section, q, live);
  const data = useEntryData(source, section, view, q);
  const now = useNow(source, section === "tasks");
  // Whether the page has answered once: from then on another list loads under the page, not instead of it.
  const answered = useLatch(settled(data.loaded) && now.settled);
  usePaintWhen(answered);
  const entry = ENTRY[section];
  if (!(q || answered)) return <PageShell title={entry.title} description={entry.description} />;
  if (nothingStored(q, data.loaded, now)) return <EntryEmpty section={section} />;
  return <EntryScreen {...props} data={data} now={now} />;
}

type EntryData = ReturnType<typeof useEntryData>;

/** Whether a list has answered: its rows, or why it has none. */
function settled(loaded: EntryData["loaded"]): boolean {
  return loaded.size !== undefined || loaded.error !== null;
}

/**
 * Nothing stored for this entry point at all (not a search that matched nothing): no search or overview to show.
 * Tasks in flight are something: the page shows them, and its runs once they end.
 */
function nothingStored(q: string, loaded: EntryData["loaded"], now: Now): boolean {
  return !q && loaded.size === 0 && !now.shown;
}

function EntryEmpty({ section }: { section: EntrySection }) {
  const entry = ENTRY[section];
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

/** The page: its header, search and filters, then Now, the overview, the switch and the list, shown together. */
function EntryScreen({
  section,
  q,
  view,
  source,
  spec,
  known,
  data,
  now,
}: EntryPageProps & { data: EntryData; now: Now }) {
  const entry = ENTRY[section];
  // Typing replaces the entry, so Back skips the letters; a chip or a menu adds one, so Back undoes it.
  const setQuery = (next: string, typed?: boolean) => go({ name: section, q: next, view }, typed);
  const refine = (terms: Record<string, string>) => go({ name: section, q: refineQuery(q, terms), view });
  const [scrolled, setScrolled] = useState(false);
  const [overviewSettled, settleOverview] = useState(false);
  // Now, the overview, the switch and the list show together, once all have answered: none pushes the others down.
  const ready = useLatch(overviewSettled && settled(data.loaded) && now.settled);
  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-background">
      <PageHeader title={entry.title} description={entry.description} actions={<EntryActions reading={scrolled} />} />
      <EntrySearch {...{ section, q, view, spec, known, refine }} loaded={data.loaded} onChange={setQuery} />
      <section
        className="min-h-0 flex-1 overflow-y-auto px-10 pb-10"
        aria-label={entry.title}
        data-scroll=""
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 40)}
      >
        <Reveal ready={ready}>
          {/* One page: Now (tasks), the overview (folded with its chevron), then the list, grouped or every call;
              all share the search. */}
          <NowStrip now={now} />
          <TracesOverview
            q={carryQuery(q, searchKeys(spec, "traces"), true)}
            scope={SCOPES[section]}
            source={source}
            onRefine={refine}
            onSettled={() => settleOverview(true)}
          />
          <ListNav section={section} view={view} q={q} spec={spec} />
          <EntryList section={section} q={q} view={view} data={data} />
        </Reveal>
      </section>
    </main>
  );
}

/** The search of the view on screen: the groups' own, or the calls' (the traces' search, this kind only). */
function EntrySearch({
  section,
  q,
  view,
  spec,
  known,
  loaded,
  refine,
  onChange,
}: Pick<EntryPageProps, "section" | "q" | "view" | "spec" | "known"> & {
  loaded: EntryData["loaded"];
  refine: (terms: Record<string, string>) => void;
  onChange: (q: string, typed?: boolean) => void;
}) {
  const calls = view === "calls";
  return (
    <>
      {section === "graphql" ? <GraphqlTypes q={q} view={view} refine={refine} /> : null}
      <SearchBar
        section={calls ? "traces" : section}
        callsOf={calls ? section : undefined}
        q={q}
        spec={spec}
        error={loaded.error}
        known={known}
        count={loaded.size}
        onChange={onChange}
      />
    </>
  );
}

/** The list under the switch; By task ↔ All runs keeps the rows on screen, dimmed, until the other list's arrive. */
function EntryList({ section, q, view, data }: { section: EntrySection; q: string; view: EntryView; data: EntryData }) {
  return (
    <Held ready={settled(data.loaded)}>
      {view === "calls" ? (
        <CallsList key={q} calls={data.calls} section={section} q={q} />
      ) : (
        <GroupsList groups={data.groups.data} section={section} q={q} />
      )}
    </Held>
  );
}

/** The last rows shown, dimmed, while the next ones load: a list never empties to fill again. */
function Held({ ready, children }: { ready: boolean; children: ReactNode }) {
  const [last, setLast] = useState<ReactNode>(null);
  if (ready && last !== children) setLast(children);
  if (ready) return children;
  return <Dimmed held={last}>{children}</Dimmed>;
}

/** The rows held while others load, dimmed; before there were any, what loads (its bar). */
function Dimmed({ held, children }: { held: ReactNode; children: ReactNode }) {
  if (held === null) return children;
  return (
    <div className="pointer-events-none opacity-50 transition-opacity" aria-busy>
      {held}
    </div>
  );
}

const NO_CALLS = { items: [], next: null };

/** The page's lists, loaded for the view on screen only: its groups, or its calls a page at a time. */
function useEntryData(source: DataSource, section: EntrySection, view: EntryView, q: string) {
  const scope = ENTRY[section].scope;
  const groups = useSearch(
    useCallback(
      (query: string): Promise<readonly unknown[]> =>
        view === "calls" ? Promise.resolve([]) : listGroups(source, section, query),
      [source, section, view],
    ),
    q,
  );
  const calls = usePaged(
    useCallback(
      (query: string, before: number | null) =>
        view === "calls" ? source.searchTraces([scope, query].join(" ").trim(), before) : Promise.resolve(NO_CALLS),
      [source, scope, view],
    ),
    q,
    startOf,
  );
  const loaded =
    view === "calls"
      ? { size: calls.items?.length, error: calls.error }
      : { size: groups.data?.length, error: groups.error };
  return { groups, calls, loaded };
}

/** The header's controls: refresh and auto-refresh, held while the list is scrolled down (as on Logs). */
function EntryActions({ reading }: { reading: boolean }) {
  return <RefreshControl paused={reading} />;
}

/** What an empty list says: Tasks' runs come once a task in flight ends. */
function nothingYet(section: EntrySection, q: string): [title: string, text: string] {
  if (q) return ["Nothing matches", "Try a broader search."];
  if (section === "tasks") return ["No runs yet", "Runs show up here when tasks finish."];
  return [`No ${ENTRY[section].label} traffic yet`, "It shows up after the first call."];
}

/** A list's rows; while they load, a bar, and with none, what will show up. */
function rowsOr<T>(
  items: readonly T[] | undefined,
  section: EntrySection,
  q: string,
  render: (items: readonly T[]) => ReactNode,
): ReactNode {
  if (!items) return <Loading />;
  if (items.length === 0) {
    const [title, text] = nothingYet(section, q);
    return <Empty title={title}>{text}</Empty>;
  }
  return render(items);
}

const idsOf = (items: readonly TraceSummary[] | undefined) => (items ?? []).map((trace) => trace.id);

type Calls = ReturnType<typeof usePaged<TraceSummary>>;

/** Every call, newest first; the ones that came in since the last refresh are highlighted for a moment. */
function CallsList({ calls, section, q }: { calls: Calls; section: EntrySection; q: string }) {
  const fresh = useNewIds(idsOf(calls.items), true);
  return rowsOr(calls.items, section, q, (items) => (
    <>
      <TracesTable items={items} selectedId={null} hrefFor={traceHref} newIds={fresh} />
      {calls.hasMore ? <LoadMore label="Load older" loading={calls.loading} onMore={calls.more} /> : null}
    </>
  ));
}

/** The groups' table of each entry point. */
const GROUP_TABLES: Record<EntrySection, (items: readonly unknown[]) => ReactNode> = {
  endpoints: (items) => <EndpointsTable items={items as Parameters<typeof EndpointsTable>[0]["items"]} />,
  graphql: (items) => <GraphqlTable items={items as Parameters<typeof GraphqlTable>[0]["items"]} />,
  tasks: (items) => <TasksTable items={items as Parameters<typeof TasksTable>[0]["items"]} />,
  websockets: (items) => <WebsocketsTable items={items as Parameters<typeof WebsocketsTable>[0]["items"]} />,
  jobs: (items) => <JobsTable items={items as Parameters<typeof JobsTable>[0]["items"]} />,
  rpc: (items) => <RpcTable items={items as Parameters<typeof RpcTable>[0]["items"]} />,
  pages: (items) => <PagesTable items={items as Parameters<typeof PagesTable>[0]["items"]} />,
};

function GroupsList({
  groups,
  section,
  q,
}: {
  groups: readonly unknown[] | undefined;
  section: EntrySection;
  q: string;
}) {
  return rowsOr(groups, section, q, GROUP_TABLES[section]);
}

/** GraphQL's operation types above the search: `type:` on the overview, `operation:…*` on calls. */
function GraphqlTypes({
  q,
  view,
  refine,
}: {
  q: string;
  view: EntryView;
  refine: (terms: Record<string, string>) => void;
}) {
  const calls = view === "calls";
  return (
    <nav className="flex items-center gap-1 px-10 pt-4" aria-label="Operation type">
      <TypeFilter
        q={q}
        calls={calls}
        onChange={(type) => (calls ? refine({ operation: type ? `${type}*` : "" }) : refine({ type }))}
      />
    </nav>
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
