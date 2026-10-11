import { type DataSource, Empty, type KnownValues, type SearchSpec } from "@tracepanel/ui";
import { type ReactNode, useCallback } from "react";
import { usePaged, useSearch } from "./data";
import { EmptyPage } from "./EmptyPage";
import { refineQuery } from "./EntryPage";
import { RefreshControl } from "./refresh";
import { type EntrySection, go, type Section, traceHref } from "./routes";
import { SearchBar } from "./SearchBar";
import { ServicesView } from "./ServicesView";
import { DATA_LABELS } from "./sections";
import { IssuesTable, LogsTable, MailsTable, QueriesTable, TracesTable } from "./tables";
import { Loading, LoadMore, PageHeader } from "./ui";

type DataSection = Exclude<Section, EntrySection>;

interface DataPageProps {
  section: DataSection;
  q: string;
  source: DataSource;
  spec: SearchSpec | null;
  known: KnownValues;
}

/** What the work touched (services, SQL, emails, logs), what went wrong (issues), and ⌘K's search results. */
const SUMMARIES: ReadonlySet<string> = new Set(["services", "queries"]);

/** What each section says before anything is stored. Search results (traces) always keep their search bar. */
const PRISTINE: Partial<Record<DataSection, { title: string; text: string }>> = {
  services: {
    title: "No services yet",
    text: "Databases, caches, mail servers and brokers appear here after the first call that uses them.",
  },
  queries: { title: "No queries yet", text: "SQL from requests, tasks and jobs is aggregated here." },
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

export function DataPage({ section, q, source, spec, known }: DataPageProps) {
  const setQuery = (next: string) => go({ name: section, q: next }, true);
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
  const queries = useSearch(
    useCallback(
      (query: string) => (section === "queries" ? source.listQueries(query) : Promise.resolve([])),
      [source, section],
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

  const loaded = {
    traces: { size: traces.items?.length, error: traces.error },
    logs: { size: logs.items?.length, error: logs.error },
    mails: { size: mails.items?.length, error: mails.error },
    services: {
      size: services.data ? services.data.apps.length + services.data.services.length : undefined,
      error: services.error,
    },
    queries: { size: queries.data?.length, error: queries.error },
    errors: { size: issues.data?.length, error: issues.error },
    issues: { size: issues.data?.length, error: issues.error },
  }[section];

  const meta = DATA_LABELS[section];
  // Nothing stored yet (not a search that matched nothing): no search, filters or refresh to show.
  const pristine = PRISTINE[section];
  if (!q && loaded.size === 0 && pristine) {
    return (
      <EmptyPage section={section} title={meta.label} description={meta.description} empty={pristine.title}>
        {pristine.text}
      </EmptyPage>
    );
  }

  let body: ReactNode;
  if (section === "traces") {
    body = traces.items ? (
      traces.items.length ? (
        <>
          <TracesTable items={traces.items} selectedId={null} hrefFor={traceHref} />
          {traces.hasMore ? <LoadMore label="Load older" loading={traces.loading} onMore={traces.more} /> : null}
        </>
      ) : (
        <Empty title="No traces match">
          Search names and paths, or filter: status&gt;=500, task:send_*, kind:command.
        </Empty>
      )
    ) : (
      <Loading />
    );
  } else if (section === "logs") {
    body = logs.items ? (
      logs.items.length ? (
        <>
          <LogsTable items={logs.items} onFilter={refine} />
          {logs.hasMore ? <LoadMore label="Load older logs" loading={logs.loading} onMore={logs.more} /> : null}
        </>
      ) : (
        <Empty title="No log records match">Records from requests, tasks and jobs are searchable here.</Empty>
      )
    ) : (
      <Loading />
    );
  } else if (section === "mails") {
    body = mails.items ? (
      mails.items.length ? (
        <>
          <MailsTable items={mails.items} source={source} />
          {mails.hasMore ? <LoadMore label="Load older emails" loading={mails.loading} onMore={mails.more} /> : null}
        </>
      ) : (
        <Empty title={q ? "No emails match" : "No emails yet"}>Emails your app sends show up here.</Empty>
      )
    ) : (
      <Loading />
    );
  } else if (section === "services") {
    body = services.data ? (
      services.data.apps.length + services.data.services.length ? (
        <ServicesView map={services.data} />
      ) : (
        <Empty title={q ? "No services match" : "No services yet"}>
          Databases, caches, mail servers and brokers appear here after the first call that uses them.
        </Empty>
      )
    ) : (
      <Loading />
    );
  } else if (section === "queries") {
    body = queries.data ? (
      queries.data.length ? (
        <QueriesTable items={queries.data} source={source} />
      ) : (
        <Empty title="No queries match">SQL from stored traces is aggregated here.</Empty>
      )
    ) : (
      <Loading />
    );
  } else {
    body = issues.data ? (
      issues.data.length ? (
        <IssuesTable items={issues.data} />
      ) : (
        <Empty title={section === "errors" ? "No errors match" : "No issues match"}>Try a broader search.</Empty>
      )
    ) : (
      <Loading />
    );
  }

  // Services and Database are summaries: they change slowly, so they refresh on demand, not on a timer.
  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-background">
      <PageHeader
        title={section === "traces" ? "Search" : meta.label}
        description={meta.description}
        actions={<RefreshControl live={!SUMMARIES.has(section)} />}
      />
      <SearchBar
        section={section}
        q={q}
        spec={spec}
        error={loaded.error}
        known={known}
        count={loaded.size}
        onChange={setQuery}
      />
      <section className="min-h-0 flex-1 overflow-y-auto px-10 pb-10" aria-label={meta.label}>
        {body}
      </section>
    </main>
  );
}
