import type { DataSource, ExploreItem, TabId, Trace, TraceLinks } from "@tracepanel/ui";
import { exploreFor } from "./explore";
import { useEscapeTo } from "./keyboard";
import { consoleLinks, ENTRY_SECTIONS, follow, go, href, parse, type Route } from "./routes";
import { crumbsFor } from "./sections";
import { TraceScreen } from "./TraceScreen";
import { CrumbBar } from "./ui";

const TABS: TabId[] = ["request", "tree", "issues", "sql", "cache", "http", "logs", "error", "profile"];

/** The tab a link asks for (`?tab=issues`), if it is one. */
export function tabOf(value: string | undefined): TabId | undefined {
  return TABS.find((item) => item === value);
}

/**
 * The tab a trace opens on when its link names none: what it was, from an entry point's lists (HTTP, Tasks, Jobs…)
 * or a group's page, where the reader picked a request or a run; its call tree from anywhere else (Traces, a search).
 * An error still comes first: the trace view opens its Error tab before this one.
 */
export function openingTab(from: string | undefined): TabId | undefined {
  if (!from) return undefined;
  return fromEntryPoint(parse(from)) ? "request" : undefined;
}

function fromEntryPoint(route: Route): boolean {
  return route.name === "group" || (ENTRY_SECTIONS as string[]).includes(route.name);
}

/**
 * Where a trace's page leads: anywhere in the console, or in a snapshot only to its other traces (the rest isn't in
 * the file: no Explore, no issue pages, no lists of calls or logs).
 */
function leadsTo(inSnapshot: boolean): { links: TraceLinks; explore?: (trace: Trace) => ExploreItem[] } {
  if (inSnapshot) return { links: { trace: consoleLinks().trace } };
  return { links: consoleLinks(), explore: (trace) => exploreFor(trace, href) };
}

/** The page's padding: the full page's, or a narrow screen's (a snapshot opened on a phone). */
const PADDING = { full: "px-6 pt-7 pb-12", compact: "px-1 pt-3 pb-8" };

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
  inSnapshot,
  variant = "full",
}: {
  id: string;
  from?: string | undefined;
  tab?: string | undefined;
  /** A span to open in the call tree (from a log record). */
  span?: string | undefined;
  source: DataSource;
  /** Opened from a snapshot file: it leads only to the file's other traces. */
  inSnapshot?: boolean | undefined;
  /** `compact` on a narrow screen: the trace as the panel shows it. */
  variant?: "full" | "compact" | undefined;
}) {
  const leads = leadsTo(inSnapshot === true);
  const back = from ? crumbsFor(parse(from), from) : [];
  useEscapeTo(from, follow);
  const initialTab = tabOf(tab);
  return (
    <main className="min-h-0 min-w-0 overflow-y-auto bg-background" data-scroll="">
      {/* The trace's own header is inset 16px: the page pads 16px less so the crumbs line up with it. */}
      <div className={`w-full ${PADDING[variant]}`}>
        {/* A stored trace never changes: no refresh control here. */}
        <div className="px-4">
          <CrumbBar
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
          id={id}
          source={source}
          initialTab={initialTab}
          preferredTab={openingTab(from)}
          onTabChange={(next) => go({ name: "trace", id, from, tab: next }, true)}
          explore={leads.explore}
          links={leads.links}
          initialSpan={span}
          variant={variant}
          shareable
          back={
            <a href={from ?? href({ name: "endpoints", q: "" })}>
              {from ? `Back to ${back.at(-1)?.label ?? "the list"}` : "All HTTP requests"}
            </a>
          }
        />
      </div>
    </main>
  );
}
