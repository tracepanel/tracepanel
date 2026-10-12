import { type CallRow, type DataSource, Empty, type KnownValues, type SearchSpec } from "@tracepanel/ui";
import type { Family } from "@tracepanel/ui/lib/systems";
import { type ReactNode, useCallback } from "react";
import { SystemTiles } from "./CallsTiles";
import { usePaged, useSearch } from "./data";
import { EmptyPage } from "./EmptyPage";
import { refineQuery } from "./EntryPage";
import { RefreshControl } from "./refresh";
import { type CallsSection, type EntrySection, go, type Section, systemOfSection, traceHref } from "./routes";
import { SearchBar } from "./SearchBar";
import { byProject, ServicesView } from "./ServicesView";
import { useScope } from "./scope";
import { pageMeta } from "./sections";
import { CallsTable, IssuesTable, LogsTable, MailsTable, TracesTable } from "./tables";
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

export function DataPage({ section, q, open, source, spec, known, systems }: DataPageProps) {
  const { setService } = useScope();
  const { system, family, meta, pristine } = pageOfSection(section, systems);
  // Opening a row replaces the entry: it is no step to go Back through, but it survives leaving and coming back.
  const setOpen = (key: string | null) => go({ name: section, q, open: key ?? undefined }, true);
  // Typing replaces the entry, so Back skips the letters; a chip or a menu adds one, so Back undoes it.
  const setQuery = (next: string, typed = false) => go({ name: section, q: next }, typed);
  const refine = (terms: Record<string, string>) => go({ name: section, q: refineQuery(q, terms) });

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
  const issues = useSearch(
    useCallback(
      (query: string) =>
        // One list of issue groups, split in two: what failed, and what could be better.
        section === "errors"
          ? source.listIssues(`kind:error ${query}`.trim())
          : section === "issues"
            ? source.listIssues(`kind!=error ${query}`.trim())
            : Promise.resolve([]),
      [source, section],
    ),
    q,
  );

  const loaded =
    {
      traces: { size: traces.items?.length, error: traces.error },
      logs: { size: logs.items?.length, error: logs.error },
      mails: { size: mails.items?.length, error: mails.error },
      services: {
        size: services.data ? byProject(services.data.apps).length + services.data.services.length : undefined,
        error: services.error,
      },
      errors: { size: issues.data?.length, error: issues.error },
      issues: { size: issues.data?.length, error: issues.error },
    }[section as string] ?? listed(stats);

  // Nothing stored yet (not a search that matched nothing): no search, filters or refresh to show.
  if (!q && loaded.size === 0 && pristine) {
    return (
      <EmptyPage section={section} title={meta.label} description={meta.description} empty={pristine.title}>
        {pristine.text}
      </EmptyPage>
    );
  }

  let body: ReactNode;
  if (section === "traces") {
    body = pagedBody(
      traces,
      "Load older",
      (items) => <TracesTable items={items} selectedId={null} hrefFor={traceHref} />,
      <Empty title="No traces match">
        Search names and paths, or filter: status&gt;=500, task:send_*, kind:command.
      </Empty>,
    );
  } else if (section === "logs") {
    body = pagedBody(
      logs,
      "Load older logs",
      (items) => <LogsTable items={items} onFilter={refine} open={open ?? null} onOpen={setOpen} />,
      <Empty title="No log records match">Records from requests, tasks and jobs are searchable here.</Empty>,
    );
  } else if (section === "mails") {
    body = pagedBody(
      mails,
      "Load older emails",
      (items) => <MailsTable items={items} source={source} open={open ?? null} onOpen={setOpen} />,
      <Empty title={q ? "No emails match" : "No emails yet"}>Emails your app sends show up here.</Empty>,
    );
  } else if (section === "services") {
    body = services.data ? (
      services.data.apps.length + services.data.services.length ? (
        <ServicesView map={services.data} onApp={setService} />
      ) : (
        <Empty title={q ? "No services match" : "No services yet"}>
          Databases, caches, mail servers and brokers appear here after the first call that uses them.
        </Empty>
      )
    ) : (
      <Loading />
    );
  } else if (system) {
    body = (
      <>
        <SystemTiles system={system} q={q} source={source} onFailed={() => refine({ failed: "true" })} />
        {listBody(
          stats.data,
          (items) => (
            <CallsTable items={items} source={source} open={open ?? null} onOpen={setOpen} />
          ),
          <Empty title={`No ${meta.noun ?? "operations"} match`}>Try a broader search, or another filter.</Empty>,
        )}
      </>
    );
  } else {
    body = listBody(
      issues.data,
      (items) => <IssuesTable items={items} />,
      <Empty title={`No ${section} match`}>Try a broader search.</Empty>,
    );
  }

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
