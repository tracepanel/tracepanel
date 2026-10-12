import type { DataSource, TabId } from "@tracepanel/ui";
import { exploreFor } from "./explore";
import { useEscapeTo } from "./keyboard";
import { consoleLinks, follow, go, href, parse } from "./routes";
import { crumbsFor } from "./sections";
import { TraceScreen } from "./TraceScreen";
import { Breadcrumbs } from "./ui";

const TABS: TabId[] = ["request", "tree", "issues", "sql", "cache", "http", "logs", "mail", "error"];

/** The tab a link asks for (`?tab=issues`), if it is one. */
export function tabOf(value: string | undefined): TabId | undefined {
  return TABS.find((item) => item === value);
}

/**
 * A trace, the same page wherever it was opened from: the crumbs lead back there (`from`), the open tab is in the
 * URL (a link to its call tree stays a link to its call tree), Explore leads to its group, issues and nearby logs.
 */
export function TracePage({
  id,
  from,
  tab,
  span,
  source,
}: {
  id: string;
  from?: string | undefined;
  tab?: string | undefined;
  /** A span to open in the call tree (from a log record). */
  span?: string | undefined;
  source: DataSource;
}) {
  const back = from ? crumbsFor(parse(from), from) : [];
  useEscapeTo(from, follow);
  const initialTab = tabOf(tab);
  return (
    <main className="min-h-0 min-w-0 overflow-y-auto bg-background" data-scroll="">
      {/* The trace's own header is inset 16px: the page pads 16px less so the crumbs line up with it. */}
      <div className="w-full px-6 pt-5 pb-12">
        {/* A stored trace never changes: no refresh control here. */}
        <div className="px-4">
          <Breadcrumbs
            items={[
              ...back,
              {
                // The request is the page's headline; its id is on the Request tab.
                label: "Trace",
              },
            ]}
          />
        </div>
        <TraceScreen
          key={id}
          id={id}
          source={source}
          initialTab={initialTab}
          onTabChange={(next) => go({ name: "trace", id, from, tab: next }, true)}
          explore={(trace) => exploreFor(trace, href)}
          links={consoleLinks()}
          initialSpan={span}
          back={
            <a href={from ?? href({ name: "endpoints", q: "" })}>
              {from ? `Back to ${back.at(-1)?.label ?? "the list"}` : "All HTTP endpoints"}
            </a>
          }
        />
      </div>
    </main>
  );
}
