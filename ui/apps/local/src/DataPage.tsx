import {
  type CallRow,
  type DataSource,
  Empty,
  type KnownValues,
  type LogBucket,
  LogsChart,
  type SearchSpec,
} from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import type { Family } from "@tracepanel/ui/lib/systems";
import { type ReactNode, useCallback, useState } from "react";
import { SystemTiles, useCallsSummary } from "./CallsTiles";
import { useLatch, usePaged, useSearch } from "./data";
import { EmptyPage, PageShell } from "./EmptyPage";
import { refineQuery } from "./EntryPage";
import { usePaintWhen } from "./firstPaint";
import { Figure, OverviewNumbers, OverviewRange, OverviewSection, useOverviewOpen } from "./Overview";
import { RefreshControl } from "./refresh";
import { type CallsSection, type EntrySection, go, type Section, systemOfSection, traceHref } from "./routes";
import { SearchBar } from "./SearchBar";
import { ServicesView } from "./ServicesView";
import { useScope } from "./scope";
import { pageMeta } from "./sections";
import { byProject } from "./services";
import { CallsTable, IssuesTable, LogsTable, MailsTable, TracesTable } from "./tables";
import { rangeTerms } from "./time";
import { Loading, LoadMore, PageHeader, Reveal } from "./ui";

type DataSection = Exclude<Section, EntrySection>;

interface DataPageProps {
  section: DataSection;
  q: string;
  /** The row the list has open, from the URL. */
  open?: string | undefined;
  source: DataSource;
  spec: SearchSpec | null;
  /** Undefined until loaded. */
  known: KnownValues | undefined;
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
  list: { items: T[] | undefined; error: string | null; hasMore: boolean; loading: boolean; more: () => void },
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
    list.error,
  );
}

/**
 * A list's body: loading, its rows, or what to say when nothing matches. With nothing loaded and an `error` (a search
 * the store refused), no endless loading: the search box above says what is wrong.
 */
function listBody<T>(
  data: T[] | undefined,
  rows: (items: T[]) => ReactNode,
  empty: ReactNode,
  error: string | null = null,
): ReactNode {
  if (data === undefined)
    return error ? <Empty title="Nothing to show">Fix the search above to see results.</Empty> : <Loading />;
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

/** The Logs page: the records over time, above their list or what to do when nothing matches. */
function logsBody(page: BodyContext): ReactNode {
  return (
    // One column no wider than the page: a table with more columns than room fits them in, rather than widening it.
    // The Overview keeps its own room below it, as on an entry point's page.
    <div className="grid grid-cols-[minmax(0,1fr)]">
      <LogsOverview series={page.data.logSeries.data} q={page.q} onRefine={page.refine} />
      {pagedBody(
        page.data.logs,
        "Load older logs",
        (items) => (
          <LogsTable
            items={items}
            onFilter={page.refine}
            open={page.open ?? null}
            onOpen={page.setOpen}
            highlight={freeText(page.q)}
          />
        ),
        <Empty
          title="No log records match"
          action={
            page.q ? (
              <Button variant="outline" size="sm" onClick={page.clear}>
                Clear the search
              </Button>
            ) : null
          }
        >
          A wider time range or fewer filters may find some.
        </Empty>,
      )}
    </div>
  );
}

/** A search's own words, not its filters: `"Kafka producer" level:info boot` → Kafka producer, boot. */
function freeText(q: string): string[] {
  return [...q.matchAll(/"([^"]+)"|(\S+)/g)]
    .map(([, quoted, word]) => quoted ?? word ?? "")
    .filter((word) => !/^-|[:<>=]/.test(word));
}

const LEVELS = ["debug", "info", "warning", "error", "critical"];

/** The levels a search has: `level:warning,error` → warning, error; `level>=warning` → warning and every one above. */
function levelsOf(q: string): string[] {
  const term = q.split(/\s+/).find((token) => /^level(:|>=)/.test(token));
  if (!term) return [];
  if (!term.startsWith("level>=")) return term.slice("level:".length).split(",").filter(Boolean);
  return LEVELS.slice(Math.max(LEVELS.indexOf(term.slice("level>=".length).toLowerCase()), 0));
}

/**
 * The search's level filter for the levels the legend leaves shown: a level and every one above it as `level>=`, as
 * the Level menu says it, any other pick as a list.
 */
function levelTerm(levels: readonly string[]): string {
  const from = levels[0] ?? "";
  return isRange(levels, from) ? `>=${from}` : levels.join(",");
}

/** Whether the levels are `from` and every one above it, more than one. */
function isRange(levels: readonly string[], from: string): boolean {
  const above = LEVELS.slice(LEVELS.indexOf(from));
  return levels.length > 1 && above.length === levels.length && above.every((level) => levels.includes(level));
}

/** Whether a search has a time range: the chart stays then, empty, to show the range and drag another. */
const ranged = (q: string) => /(^|\s)(since|until):/.test(q);

/** A slice's records of some levels. */
const countOf = (bucket: LogBucket, levels: readonly string[]) =>
  levels.reduce((sum, level) => sum + (bucket.levels[level] ?? 0), 0);

/** "1,204 records", in the tone of what they are when there are any. */
function Counted({ count, noun, tone = "plain" }: { count: number; noun: string; tone?: "error" | "warn" | "plain" }) {
  return (
    <Figure value={count.toLocaleString()} label={count === 1 ? noun : `${noun}s`} tone={count > 0 ? tone : "plain"} />
  );
}

/** The Overview folded: how many records, errors and warnings the search finds, on one line. */
function LogNumbers({ series }: { series: readonly LogBucket[] }) {
  const sum = (levels: readonly string[]) => series.reduce((total, bucket) => total + countOf(bucket, levels), 0);
  return (
    <OverviewNumbers>
      <Counted count={sum(LEVELS)} noun="record" />
      <Counted count={sum(["error", "critical"])} noun="error" tone="error" />
      <Counted count={sum(["warning"])} noun="warning" tone="warn" />
    </OverviewNumbers>
  );
}

/** The time the series covers: its first slice's start to its last one's end. */
function SeriesRange({ series }: { series: readonly LogBucket[] }) {
  const from = Math.min(...series.map((bucket) => bucket.start));
  const to = Math.max(...series.map((bucket) => bucket.end));
  return <OverviewRange from={from} to={to} />;
}

/**
 * The Logs page's Overview, as an entry point's: its records over time, a drag across them narrowing the search to
 * that time, the legend to those levels; folded, their numbers. None while loading, or when nothing matches outside a
 * time range.
 */
function LogsOverview({
  series,
  q,
  onRefine,
}: {
  series: LogBucket[] | undefined;
  q: string;
  onRefine: (terms: Record<string, string>) => void;
}) {
  const [open, toggle] = useOverviewOpen();
  if (!series || !(ranged(q) || series.some((bucket) => bucket.count > 0))) return null;
  return (
    <OverviewSection
      open={open}
      onToggle={toggle}
      range={<SeriesRange series={series} />}
      numbers={<LogNumbers series={series} />}
    >
      <LogsChart
        series={series}
        onSelect={(start, end) => onRefine(rangeTerms(start, end))}
        levels={{ chosen: levelsOf(q), onChoose: (levels) => onRefine({ level: levelTerm(levels) }) }}
      />
    </OverviewSection>
  );
}

/** How many records the search finds in all: the chart's counts, over every page of the list. */
function seriesTotal(series: readonly LogBucket[] | undefined): number | undefined {
  return series?.reduce((sum, bucket) => sum + bucket.count, 0);
}

/** How many are shown: "14 of 1,204" while older pages hold more. */
function shownOf(size: number | undefined, total: number | undefined): number | string | undefined {
  return size !== undefined && total !== undefined && total > size ? `${size} of ${total.toLocaleString()}` : size;
}

// What each list's pages are cut by: a trace's start, a record's or a mail's time.
const startOf = (trace: { start: number }) => trace.start;
const timeOf = (row: { time: number }) => row.time;

/** Everything a page loads: each list only on its own page (the others resolve empty at once). */
function usePageData(section: Section, system: string | null, source: DataSource, q: string) {
  const traces = usePaged(
    useCallback(
      (query: string, before: number | null) =>
        section === "traces" ? source.searchTraces(query, before) : Promise.resolve({ items: [], next: null }),
      [source, section],
    ),
    q,
    startOf,
  );
  const logs = usePaged(
    useCallback(
      (query: string, before: number | null) =>
        section === "logs" ? source.searchLogs(query, before) : Promise.resolve({ items: [], next: null }),
      [source, section],
    ),
    q,
    timeOf,
  );
  const logSeries = useLogSeries(source, section === "logs", q);
  const mails = usePaged(
    useCallback(
      (query: string, before: number | null) =>
        section === "mails" ? source.searchMails(query, before) : Promise.resolve({ items: [], next: null }),
      [source, section],
    ),
    q,
    timeOf,
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
  const summary = useCallsSummary(source, system, q);
  return { traces, logs, logSeries, mails, services, stats, issues, summary };
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
  /** The search emptied: every record again. */
  clear: () => void;
  setOpen: (key: string | null) => void;
  setService: (service: string) => void;
}

/** The body of each page that has its own; the others list calls (a system's page) or issues. */
const BODIES: Partial<Record<Section, (page: BodyContext) => ReactNode>> = {
  traces: (page) =>
    pagedBody(
      page.data.traces,
      "Load older",
      (items) => <TracesTable table="traces" items={items} selectedId={null} hrefFor={traceHref} />,
      <Empty title="No traces match">
        Search names and paths, or filter: status&gt;=500, task:send_*, kind:command.
      </Empty>,
    ),
  logs: logsBody,
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

function callsBody({ source, data, open, setOpen, refine, noun }: BodyContext) {
  return (
    <>
      <SystemTiles summary={data.summary.data} onFailed={() => refine({ failed: "true" })} />
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
  if (page.system) return callsBody(page);
  return listBody(
    page.data.issues.data,
    (items) => <IssuesTable items={items} />,
    <Empty title={`No ${page.section} match`}>Try a broader search.</Empty>,
  );
}

const answered = (loaded: { data?: unknown; error: string | null }) =>
  loaded.data !== undefined || loaded.error !== null;

/** Whether a list has answered: its rows, or why it has none. */
function listAnswered(loaded: Loaded): boolean {
  return loaded.size !== undefined || loaded.error !== null;
}

/** Whether all a page shows has answered: its list, and the Logs' chart or a system's tiles above it. */
function bodySettled(section: Section, system: string | null, data: PageData, loaded: Loaded): boolean {
  const chart = section !== "logs" || answered(data.logSeries);
  const tiles = system === null || answered(data.summary);
  return [listAnswered(loaded), chart, tiles].every(Boolean);
}

/**
 * The header's controls: refresh and auto-refresh, held (`reading`) while a record is open or the list is scrolled
 * down. Services and Database are summaries: they change slowly, so they refresh on demand only.
 */
function headerActions(section: DataSection, reading: boolean): ReactNode {
  return <RefreshControl live={!isSummary(section)} paused={reading} />;
}

export function DataPage(props: DataPageProps) {
  const { section, q, source, systems } = props;
  const page = pageOfSection(section, systems);
  const data = usePageData(section, page.system, source, q);
  const loaded = loadedOf(section, data);
  const answered = useLatch(listAnswered(loaded));
  usePaintWhen(answered);
  const { meta, pristine } = page;
  // Before its first answer a page that may turn out empty shows its title only, then the page or its empty state.
  if (pristine && !(q || answered)) return <PageShell title={meta.label} description={meta.description} />;
  // Nothing stored yet (not a search that matched nothing): no search, filters or refresh to show.
  if (pristine && !q && loaded.size === 0) {
    return (
      <EmptyPage section={section} title={meta.label} description={meta.description} empty={pristine.title}>
        {pristine.text}
      </EmptyPage>
    );
  }
  return <DataScreen {...props} page={page} data={data} loaded={loaded} />;
}

/** The page: its header, search and filters, then what it lists (with its chart or tiles), shown together. */
function DataScreen({
  section,
  q,
  open,
  source,
  spec,
  known,
  page,
  data,
  loaded,
}: DataPageProps & { page: ReturnType<typeof pageOfSection>; data: PageData; loaded: Loaded }) {
  const { setService } = useScope();
  const { system, family, meta } = page;
  // Opening a row replaces the entry: it is no step to go Back through, but it survives leaving and coming back.
  const setOpen = (key: string | null) => go({ name: section, q, open: key ?? undefined }, true);
  // Typing replaces the entry, so Back skips the letters; a chip or a menu adds one, so Back undoes it.
  const setQuery = (next: string, typed?: boolean) => go({ name: section, q: next }, typed);
  const refine = (terms: Record<string, string>) => go({ name: section, q: refineQuery(q, terms) });
  const [scrolled, setScrolled] = useState(false);
  // The list, the chart above it (Logs) and the tiles (a system's page) show together, once all have answered.
  const ready = useLatch(bodySettled(section, system, data, loaded));
  usePaintWhen(ready);
  const clear = () => go({ name: section, q: "" });
  const body = pageBody({
    section,
    system,
    q,
    open,
    source,
    noun: meta.noun,
    data,
    refine,
    clear,
    setOpen,
    setService,
  });

  // Services and Database are summaries: they change slowly, so they refresh on demand, not on a timer.
  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-background">
      <PageHeader
        title={section === "traces" ? "Search" : meta.label}
        description={meta.description}
        actions={headerActions(section, open !== undefined || scrolled)}
      />
      <SearchBar
        section={section}
        family={family}
        q={q}
        spec={spec}
        error={loaded.error}
        known={known}
        count={pageCount(section, loaded, data)}
        onChange={setQuery}
      />
      <section
        className="min-h-0 flex-1 overflow-y-auto px-10 pb-10"
        aria-label={meta.label}
        data-scroll=""
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 40)}
      >
        <Reveal ready={ready}>{body}</Reveal>
      </section>
    </main>
  );
}

/** How many the search shows: on Logs, of how many the chart counts. */
function pageCount(section: Section, loaded: Loaded, data: PageData): number | string | undefined {
  return shownOf(loaded.size, section === "logs" ? seriesTotal(data.logSeries.data) : undefined);
}
