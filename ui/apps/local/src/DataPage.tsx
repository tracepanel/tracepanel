import {
  type CallRow,
  type DataSource,
  Empty,
  type KnownValues,
  type LogBucket,
  type LogRow,
  LogsChart,
  type SearchSpec,
} from "@tracepanel/ui";
import type { Family } from "@tracepanel/ui/lib/systems";
import { type ReactNode, useCallback } from "react";
import { SystemTiles } from "./CallsTiles";
import { usePaged, useSearch } from "./data";
import { EmptyPage } from "./EmptyPage";
import { refineQuery } from "./EntryPage";
import { RefreshControl } from "./refresh";
import { type CallsSection, type EntrySection, go, type Section, systemOfSection, traceHref } from "./routes";
import { SearchBar } from "./SearchBar";
import { ServicesView } from "./ServicesView";
import { useScope } from "./scope";
import { pageMeta } from "./sections";
import { byProject } from "./services";
import { CallsTable, IssuesTable, LogsTable, MailsTable, TracesTable } from "./tables";
import { rangeTerms } from "./time";
import { Loading, LoadMore, PageHeader } from "./ui";

type DataSection = Exclude<Section, EntrySection>;

interface DataPageProps {
  section: DataSection;
  q: string;
  /** The row the list has open, from the URL. */
  open?: string | undefined;
  source: DataSource;
  spec: SearchSpec | null;
  known: KnownValues;
  /** The systems in the store and their families (the agent's counts): a system's page takes its family's words. */
  systems?: readonly { system: string; family: Family; label: string }[] | undefined;
}

/** What the work touched (services, SQL, emails, logs), what went wrong (issues), and ⌘K's search results. */
const SUMMARIES: ReadonlySet<string> = new Set(["services"]);

/** What each section says before anything is stored. Search results (traces) always keep their search bar. */
const PRISTINE: Partial<Record<Exclude<DataSection, CallsSection>, { title: string; text: string }>> = {
  services: {
    title: "No services yet",
    text: "Databases, caches, mail servers and brokers appear here after the first call that uses them.",
  },
  mails: { title: "No emails yet", text: "Emails your app sends show up here." },
  logs: { title: "No log records yet", text: "Records from requests, tasks and jobs show up here." },
  errors: {
    title: "No errors yet",
    text: "Exceptions from requests, tasks and jobs show up here, grouped by where they happen.",
  },
  issues: {
    title: "No issues found",
    text: "N+1 queries, duplicate and slow SQL, transaction and htmx mistakes show up here.",
  },
};

/** A data page: its system (a system's page), the system's family, its name and words, what it says when empty. */
function pageOfSection(section: DataSection, systems: DataPageProps["systems"]) {
  const system = systemOfSection(section);
  const entry = systems?.find((each) => each.system === system);
  const family = entry?.family;
  const meta = pageMeta(section, family, entry?.label);
  const pristine = system ? systemPristine(meta.noun) : PRISTINE[section as keyof typeof PRISTINE];
  return { system, family, meta, pristine };
}

/** How many rows a list has, and its error. */
function listed<E>(list: { data?: readonly unknown[] | undefined; error: E }) {
  return { size: list.data?.length, error: list.error };
}

/** Services and the systems' pages are summaries: they change slowly, and refresh on demand. */
function isSummary(section: DataSection): boolean {
  return SUMMARIES.has(section) || systemOfSection(section) !== null;
}

/** What a system's page says before anything is stored. */
function systemPristine(noun = "operations"): { title: string; text: string } {
  return {
    title: `No ${noun} yet`,
    text: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} your app makes show up here.`,
  };
}

/** A paged list's body: loading, its rows with "Load older" while there are more, or what to say when it is empty. */
function pagedBody<T>(
  list: { items: T[] | undefined; hasMore: boolean; loading: boolean; more: () => void },
  moreLabel: string,
  rows: (items: T[]) => ReactNode,
  empty: ReactNode,
): ReactNode {
  return listBody(
    list.items,
    (items) => (
      <>
        {rows(items)}
        {list.hasMore ? <LoadMore label={moreLabel} loading={list.loading} onMore={list.more} /> : null}
      </>
    ),
    empty,
  );
}

/** A list's body: loading, its rows, or what to say when nothing matches. */
function listBody<T>(data: T[] | undefined, rows: (items: T[]) => ReactNode, empty: ReactNode): ReactNode {
  if (data === undefined) return <Loading />;
  return data.length > 0 ? rows(data) : empty;
}

/** The logs' chart data: how many records the search finds over time, by level; none off the Logs page. */
function useLogSeries(source: DataSource, logs: boolean, q: string) {
  const load = useCallback(
    (query: string) => (logs && source.logSeries ? source.logSeries(query) : Promise.resolve(undefined)),
    [source, logs],
  );
  return useSearch(load, q, 0);
}

/** The Logs page's list: the records over time above them. */
function logsBody(
  items: LogRow[],
  series: LogBucket[] | undefined,
  refine: (terms: Record<string, string>) => void,
  open: string | undefined,
  setOpen: (key: string | null) => void,
): ReactNode {
  return (
    <div className="grid gap-3">
      <LogsOverTime series={series} onRefine={refine} />
      <LogsTable items={items} onFilter={refine} open={open ?? null} onOpen={setOpen} />
    </div>
  );
}

/** The logs' records over time; a drag across it narrows the search to that time. None while loading or empty. */
function LogsOverTime({
  series,
  onRefine,
}: {
  series: LogBucket[] | undefined;
  onRefine: (terms: Record<string, string>) => void;
}) {
  if (!series?.some((bucket) => bucket.count > 0)) return null;
  return <LogsChart series={series} onSelect={(start, end) => onRefine(rangeTerms(start, end))} />;
}

/** Everything a page loads: each list only on its own page (the others resolve empty at once). */
function usePageData(section: Section, system: string | null, source: DataSource, q: string) {
  const traces = usePaged(
    useCallback(
      (query: string, before: number | null) =>
        section === "traces" ? source.searchTraces(query, before) : Promise.resolve({ items: [], next: null }),
      [source, section],
    ),
    q,
  );
  const logs = usePaged(
    useCallback(
      (query: string, before: number | null) =>
        section === "logs" ? source.searchLogs(query, before) : Promise.resolve({ items: [], next: null }),
      [source, section],
    ),
    q,
  );
  const logSeries = useLogSeries(source, section === "logs", q);
  const mails = usePaged(
    useCallback(
      (query: string, before: number | null) =>
        section === "mails" ? source.searchMails(query, before) : Promise.resolve({ items: [], next: null }),
      [source, section],
    ),
    q,
  );
  const services = useSearch(
    useCallback(
      (query: string) => (section === "services" ? source.listServices(query) : Promise.resolve(undefined)),
      [source, section],
    ),
    q,
    0,
  );
  const stats = useSearch(
    useCallback(
      (query: string): Promise<CallRow[]> => (system ? source.listCalls(system, query) : Promise.resolve([])),
      [source, system],
    ),
    q,
    0,
  );
  const issues = useIssues(source, section, q);
  return { traces, logs, logSeries, mails, services, stats, issues };
}

/** One list of issue groups, split in two: what failed (Errors), and what could be better (Issues). */
function useIssues(source: DataSource, section: Section, q: string) {
  return useSearch(
    useCallback(
      (query: string) =>
        section === "errors"
          ? source.listIssues(`kind:error ${query}`.trim())
          : section === "issues"
            ? source.listIssues(`kind!=error ${query}`.trim())
            : Promise.resolve([]),
      [source, section],
    ),
    q,
  );
}

type PageData = ReturnType<typeof usePageData>;

type Loaded = { size: number | undefined; error: string | null };

function paged(list: { items?: readonly unknown[] | undefined; error: string | null }): Loaded {
  return { size: list.items?.length, error: list.error };
}

function servicesLoaded({ services }: PageData): Loaded {
  const map = services.data;
  return { size: map ? byProject(map.apps).length + map.services.length : undefined, error: services.error };
}

/** How many rows each page has, and its search's error: the search bar shows them. A system's page, its calls. */
const LOADED: Partial<Record<Section, (data: PageData) => Loaded>> = {
  traces: (data) => paged(data.traces),
  logs: (data) => paged(data.logs),
  mails: (data) => paged(data.mails),
  services: servicesLoaded,
  errors: (data) => listed(data.issues),
  issues: (data) => listed(data.issues),
};

function loadedOf(section: Section, data: PageData): Loaded {
  return (LOADED[section] ?? ((page: PageData) => listed(page.stats)))(data);
}

/** What a page's body needs: its section and search, what it loaded, and what its rows do. */
interface BodyContext {
  section: Section;
  system: string | null;
  q: string;
  open: string | undefined;
  source: DataSource;
  noun: string | undefined;
  data: PageData;
  refine: (terms: Record<string, string>) => void;
  setOpen: (key: string | null) => void;
  setService: (service: string) => void;
}

/** The body of each page that has its own; the others list calls (a system's page) or issues. */
const BODIES: Partial<Record<Section, (page: BodyContext) => ReactNode>> = {
  traces: (page) =>
    pagedBody(
      page.data.traces,
      "Load older",
      (items) => <TracesTable items={items} selectedId={null} hrefFor={traceHref} />,
      <Empty title="No traces match">
        Search names and paths, or filter: status&gt;=500, task:send_*, kind:command.
      </Empty>,
    ),
  logs: (page) =>
    pagedBody(
      page.data.logs,
      "Load older logs",
      (items) => logsBody(items, page.data.logSeries.data, page.refine, page.open, page.setOpen),
      <Empty title="No log records match">Records from requests, tasks and jobs are searchable here.</Empty>,
    ),
  mails: (page) =>
    pagedBody(
      page.data.mails,
      "Load older emails",
      (items) => <MailsTable items={items} source={page.source} open={page.open ?? null} onOpen={page.setOpen} />,
      <Empty title={page.q ? "No emails match" : "No emails yet"}>Emails your app sends show up here.</Empty>,
    ),
  services: servicesBody,
};

function servicesBody({ data, q, setService }: BodyContext): ReactNode {
  const map = data.services.data;
  if (!map) return <Loading />;
  if (map.apps.length + map.services.length > 0) return <ServicesView map={map} onApp={setService} />;
  return (
    <Empty title={q ? "No services match" : "No services yet"}>
      Databases, caches, mail servers and brokers appear here after the first call that uses them.
    </Empty>
  );
}

function callsBody({ system, q, source, data, open, setOpen, refine, noun }: BodyContext & { system: string }) {
  return (
    <>
      <SystemTiles system={system} q={q} source={source} onFailed={() => refine({ failed: "true" })} />
      {listBody(
        data.stats.data,
        (items) => (
          <CallsTable items={items} source={source} open={open ?? null} onOpen={setOpen} />
        ),
        <Empty title={`No ${noun ?? "operations"} match`}>Try a broader search, or another filter.</Empty>,
      )}
    </>
  );
}

function pageBody(page: BodyContext): ReactNode {
  const own = BODIES[page.section];
  if (own) return own(page);
  if (page.system) return callsBody({ ...page, system: page.system });
  return listBody(
    page.data.issues.data,
    (items) => <IssuesTable items={items} />,
    <Empty title={`No ${page.section} match`}>Try a broader search.</Empty>,
  );
}

export function DataPage({ section, q, open, source, spec, known, systems }: DataPageProps) {
  const { setService } = useScope();
  const { system, family, meta, pristine } = pageOfSection(section, systems);
  // Opening a row replaces the entry: it is no step to go Back through, but it survives leaving and coming back.
  const setOpen = (key: string | null) => go({ name: section, q, open: key ?? undefined }, true);
  // Typing replaces the entry, so Back skips the letters; a chip or a menu adds one, so Back undoes it.
  const setQuery = (next: string, typed = false) => go({ name: section, q: next }, typed);
  const refine = (terms: Record<string, string>) => go({ name: section, q: refineQuery(q, terms) });
  const data = usePageData(section, system, source, q);
  const loaded = loadedOf(section, data);

  // Nothing stored yet (not a search that matched nothing): no search, filters or refresh to show.
  if (!q && loaded.size === 0 && pristine) {
    return (
      <EmptyPage section={section} title={meta.label} description={meta.description} empty={pristine.title}>
        {pristine.text}
      </EmptyPage>
    );
  }
  const body = pageBody({ section, system, q, open, source, noun: meta.noun, data, refine, setOpen, setService });

  // Services and Database are summaries: they change slowly, so they refresh on demand, not on a timer.
  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-background">
      <PageHeader
        title={section === "traces" ? "Search" : meta.label}
        description={meta.description}
        actions={<RefreshControl live={!isSummary(section)} />}
      />
      <SearchBar
        section={section}
        family={family}
        q={q}
        spec={spec}
        error={loaded.error}
        known={known}
        count={loaded.size}
        onChange={setQuery}
      />
      <section className="min-h-0 flex-1 overflow-y-auto px-10 pb-10" aria-label={meta.label} data-scroll="">
        {body}
      </section>
    </main>
  );
}
