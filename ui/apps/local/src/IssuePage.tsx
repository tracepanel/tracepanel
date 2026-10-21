import { ago, CallsChart, type DataSource, Empty, IssueChip, type IssueDetail, RichText } from "@tracepanel/ui";
import { Card } from "@tracepanel/ui/components/ui/card";
import { LightbulbIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { exploreFor } from "./explore";
import { PeriodChip } from "./PeriodChip";
import { consoleLinks, href, traceHref } from "./routes";
import { TraceScreen } from "./TraceScreen";
import { TracesTable } from "./tables";
import { Breadcrumbs, Loading, Mono, Reveal } from "./ui";

/** One issue, Sentry-style: what and where, how often, its latest occurrence, and every request it happened in. */
export function IssuePage({
  fingerprint,
  period,
  source,
}: {
  fingerprint: string;
  /** The since:/until: of the list it was opened from: its chart and requests keep to it. */
  period: string;
  source: DataSource;
}) {
  const [issue, setIssue] = useState<IssueDetail | null | undefined>(undefined);
  // The latest occurrence loads its own trace: the page shows once it has, so the requests under it don't move down.
  const [occurrence, setOccurrence] = useState(false);
  // Loaded once: an issue is read, not watched (the Issues list refreshes; opening the issue again shows what is new).
  useEffect(() => {
    let cancelled = false;
    source.getIssue(fingerprint, period).then(
      (result) => !cancelled && setIssue(result),
      () => !cancelled && setIssue(null),
    );
    return () => {
      cancelled = true;
    };
  }, [fingerprint, period, source]);

  if (issue === undefined) return <Loading />;
  if (issue === null) {
    return (
      <Empty title="Issue not found" action={<a href={href({ name: "issues", q: "" })}>Back to issues</a>}>
        It may have been dropped with old traces.
      </Empty>
    );
  }

  const error = issue.kind === "error";
  const [type, ...message] = issue.title.split(": ");
  return (
    <Reveal ready={occurrence}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-9 px-10 pt-7 pb-16 *:min-w-0">
        {/* One column no wider than the page: a long error message or SQL wraps instead of widening it. */}
        <header className="grid grid-cols-[minmax(0,1fr)] gap-3 *:min-w-0">
          <Breadcrumbs
            items={[
              error
                ? { label: "Errors", href: href({ name: "errors", q: period }) }
                : { label: "Issues", href: href({ name: "issues", q: period }) },
              { label: issue.title },
            ]}
          />
          <div className="flex items-center gap-2.5">
            <IssueChip kind={issue.kind} />
            <span className="text-base text-muted-foreground">
              {issue.occurrences} {issue.occurrences === 1 ? "event" : "events"} · in {issue.traces.length} stored{" "}
              {issue.traces.length === 1 ? "request" : "requests"} · first seen {ago(issue.first_seen)} · last seen{" "}
              {ago(issue.last_seen)}
            </span>
          </div>
          {/* Long messages (a driver's, with every connection attempt) stop at three lines: the error below has it all. */}
          <h1
            className="line-clamp-3 text-2xl leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]"
            title={issue.title}
          >
            {error ? (
              <>
                <span className="text-error">{type}</span>
                {message.length ? <span className="font-normal">: {message.join(": ")}</span> : null}
              </>
            ) : (
              issue.title
            )}
          </h1>
          {issue.culprit ? <Mono className="text-sm text-muted-foreground">{issue.culprit}</Mono> : null}
          {issue.hint ? (
            <Card className="flex-row items-start gap-3 border-brand/30 bg-brand-soft px-4 py-3 text-sm shadow-none">
              <LightbulbIcon className="mt-0.5 size-4 shrink-0 text-brand" />
              <span>
                <RichText text={issue.hint} />
              </span>
            </Card>
          ) : null}
          <PeriodChip period={period} allTime={href({ name: "issue", fingerprint, error: issue.kind === "error" })} />
        </header>

        {/* How often over time; next to it, the endpoints it happens on (left out when it isn't tied to a route). */}
        <div
          className={
            issue.endpoints.length
              ? "grid grid-cols-[minmax(0,2fr)_minmax(260px,1fr)] gap-4 max-[1100px]:grid-cols-1"
              : "grid grid-cols-[minmax(0,1fr)]"
          }
        >
          <CallsChart series={issue.series} title="Events over time" noun="event" errors={error} />
          {issue.endpoints.length ? (
            <Card className="gap-2 px-4 py-3.5 shadow-none">
              <h2 className="text-md font-semibold">Endpoints</h2>
              <ul className="grid gap-0.5">
                {issue.endpoints.map((endpoint) => (
                  <li key={endpoint}>
                    <a
                      href={href({ name: "group", section: "endpoints", key: endpoint })}
                      className="block w-full rounded-md px-1.5 py-1.5 text-left font-mono text-base hover:bg-accent"
                    >
                      {endpoint}
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        <LatestOccurrence issue={issue} error={error} source={source} onLoaded={() => setOccurrence(true)} />

        <section className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
          <h2 className="text-xl font-semibold">
            Requests <span className="font-normal text-muted-foreground">· newest first</span>
          </h2>
          <TracesTable table="issue:calls" items={issue.traces} selectedId={null} hrefFor={traceHref} />
        </section>
      </div>
    </Reveal>
  );
}

/**
 * The newest of its requests, opened; with none left (every one rotated out of the store, the issue still counting
 * them), what happened to them.
 */
function LatestOccurrence({
  issue,
  error,
  source,
  onLoaded,
}: {
  issue: IssueDetail;
  error: boolean;
  source: DataSource;
  onLoaded: () => void;
}) {
  if (issue.traces.length === 0) return <RotatedOut occurrences={issue.occurrences} onShown={onLoaded} />;
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
      <h2 className="flex items-baseline gap-3 text-xl font-semibold">
        Latest occurrence
        <a
          href={traceHref(issue.last_trace_id, error ? "error" : "issues")}
          className="text-base font-medium text-brand hover:underline"
        >
          Open request →
        </a>
      </h2>
      <Card className="p-0 shadow-none">
        <TraceScreen
          id={issue.last_trace_id}
          source={source}
          explore={(trace) => exploreFor(trace, href)}
          links={consoleLinks()}
          initialTab={error ? "error" : "issues"}
          onLoaded={onLoaded}
        />
      </Card>
    </section>
  );
}

/** No trace to load: shown at once, which it says (`onShown`) for the page around it. */
function RotatedOut({ occurrences, onShown }: { occurrences: number; onShown: () => void }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: said once, as it shows.
  useEffect(onShown, []);
  return (
    <Empty title="Its requests were rotated out">
      The store keeps the newest traces: the requests of its {occurrences}{" "}
      {occurrences === 1 ? "occurrence" : "occurrences"} are gone. It shows here again the next time it happens.
    </Empty>
  );
}
