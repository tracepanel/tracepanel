import {
  type DataSource,
  type ExploreItem,
  memoryFromParams,
  parseSlice,
  sliceParams,
  type TabId,
  type Trace,
  type TraceLinks,
  type TraceSummary,
  type ViewMemory,
} from "@tracepanel/ui";
import { useState } from "react";
import { exploreFor } from "./explore";
import { useEscapeTo } from "./keyboard";
import { readLastTab, writeLastTab } from "./lastTab";
import { consoleLinks, type EntrySection, go, goBack, href, parse, type Route } from "./routes";
import { crumbsFor, ENTRY, entryOf, graphqlOperation } from "./sections";
import { useSummaries } from "./summaries";
import { TraceScreen } from "./TraceScreen";
import { CrumbBar } from "./ui";

const TABS: TabId[] = ["request", "tree", "issues", "sql", "cache", "http", "logs", "error", "profile"];

/** The tab a link asks for (`?tab=issues`), if it is one. */
export function tabOf(value: string | undefined): TabId | undefined {
  return TABS.find((item) => item === value);
}

/**
 * Where a trace's page leads: anywhere in the console, or in a snapshot only to its other traces (the rest isn't in
 * the file: no Explore, no issue pages, no lists of calls or logs).
 */
function leadsTo(inSnapshot: boolean): { links: TraceLinks; explore?: (trace: Trace) => ExploreItem[] } {
  if (inSnapshot) return { links: { trace: consoleLinks().trace } };
  return { links: consoleLinks(), explore: (trace) => exploreFor(trace, href) };
}

/** The trace's address as it is now: a tab opened and a slice picked one after the other both stay in it. */
function here(id: string): Extract<Route, { name: "trace" }> {
  const route = parse(location.hash);
  return route.name === "trace" ? route : { name: "trace", id };
}

/** The page's padding: the full page's, or a narrow screen's (a snapshot opened on a phone). */
const PADDING = { full: "px-6 pt-7 pb-12", compact: "px-1 pt-3 pb-8" };

type Crumb = { label: string; href?: string };

/**
 * The way a trace was reached, as the addresses its `from` holds: the page it was opened from, and, where that was
 * another trace (a linked one opened from it), the way that one was reached, back to the list it started at.
 */
function trail(from: string | undefined): { route: Route; hash: string }[] {
  const steps: { route: Route; hash: string }[] = [];
  for (let hash = from; hash && steps.length < MAX_STEPS; ) {
    const route = parse(hash);
    steps.unshift({ route, hash });
    hash = route.name === "trace" ? route.from : undefined;
  }
  return steps;
}

/** How many steps the crumbs follow back: a longer way starts at its last ones. */
const MAX_STEPS = 8;

/** A trace as its crumb names it: a request's method and path, an operation, a task's or a job's name. */
function crumbName(trace: TraceSummary | undefined): string {
  if (!trace) return "Trace";
  const operation = graphqlOperation(trace);
  if (operation) return operation;
  return trace.method && trace.path ? `${trace.method} ${trace.path}` : trace.name;
}

/**
 * The crumbs of the way a trace was reached: the list it started at, each trace opened on the way (a linked one's
 * crumb goes back to the trace it was opened from, as it was); opened directly (a link, the panel's Console), its
 * list, once its kind is known.
 */
function useBackCrumbs(from: string | undefined, source: DataSource): [Crumb[], (trace: Trace | null) => void] {
  const [entry, setEntry] = useState<EntrySection | null>(null);
  const onLoaded = (trace: Trace | null) => setEntry(trace ? entryOf(trace) : null);
  const steps = trail(from);
  const names = useSummaries(
    steps.flatMap((step) => (step.route.name === "trace" ? [step.route.id] : [])),
    source,
  );
  if (steps.length === 0) {
    return [entry ? [{ label: ENTRY[entry].label, href: href({ name: entry, q: "" }) }] : [], onLoaded];
  }
  const crumbs = steps.flatMap(({ route, hash }): Crumb[] =>
    route.name === "trace" ? [{ label: crumbName(names.get(route.id)), href: hash }] : crumbsFor(route, hash),
  );
  return [crumbs, onLoaded];
}

/** What the view remembers that its history entry holds (the rows folded), for the trace on screen. */
function entryMemory(id: string): ViewMemory {
  const state: unknown = history.state;
  if (!state || typeof state !== "object" || !("view" in state)) return {};
  const view = state.view as { id?: unknown; memory?: unknown } | null;
  return view?.id === id && view.memory && typeof view.memory === "object" ? (view.memory as ViewMemory) : {};
}

/**
 * Keeps what the view remembers: all of it in the history entry (Back returns to it), what a link carries in the
 * address too (a reload, a shared link).
 */
function keepMemory(id: string, memory: ViewMemory): void {
  const state = history.state && typeof history.state === "object" ? history.state : {};
  history.replaceState({ ...state, view: { id, memory } }, "");
  go(
    { ...here(id), span: memory["span"], profile: memory["profile"], frames: memory["frames"], at: memory["at"] },
    true,
  );
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
  part,
  range,
  logs,
  profile,
  frames,
  at,
  source,
  inSnapshot,
  variant = "full",
}: {
  id: string;
  from?: string | undefined;
  tab?: string | undefined;
  /** A span to open in the call tree (from a log record). */
  span?: string | undefined;
  /** The part of the time picked in the call tree: its kinds of calls and its stretch, as the URL says them. */
  part?: string | undefined;
  range?: string | undefined;
  /** `all` when every log record shows in the call tree. */
  logs?: string | undefined;
  /** The Profile tab's choices: Memory, the frames shown, the stretch it opened at. */
  profile?: string | undefined;
  frames?: string | undefined;
  at?: string | undefined;
  source: DataSource;
  /** Opened from a snapshot file: it leads only to the file's other traces. */
  inSnapshot?: boolean | undefined;
  /** `compact` on a narrow screen: the trace as the panel shows it. */
  variant?: "full" | "compact" | undefined;
}) {
  const leads = leadsTo(inSnapshot === true);
  const [back, onLoaded] = useBackCrumbs(from, source);
  useEscapeTo(from, goBack);
  const initialTab = tabOf(tab);
  // Read once, as the trace's view opens: Back to this entry brings its rows folded, the address the rest.
  const initialMemory = { ...entryMemory(id), ...memoryFromParams({ span, profile, frames, at }) };
  return (
    <main className="min-h-0 min-w-0 overflow-y-auto bg-background" data-scroll="">
      {/* The trace's own header is inset 16px: the page pads 16px less so the crumbs line up with it. */}
      <div className={`dt-trace-page w-full ${PADDING[variant]}`}>
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
          // Opened fresh, the tab last picked in a trace (here or in the panel), when it has it.
          preferredTab={readLastTab()}
          // The tab, the row selected and the part of the time picked are the page's URL: a link to it opens them again.
          onTabChange={(next) => {
            writeLastTab(next);
            go({ ...here(id), tab: next }, true);
          }}
          // The tab it opened on is the address's too: Back from a linked trace returns to it.
          onTabShown={(shown) => {
            if (here(id).tab !== shown) go({ ...here(id), tab: shown }, true);
          }}
          initialMemory={initialMemory}
          onMemoryChange={(memory) => keepMemory(id, memory)}
          initialSlice={parseSlice(part, range, logs)}
          onSliceChange={(next) => go({ ...here(id), ...sliceParams(next) }, true)}
          explore={leads.explore}
          links={leads.links}
          initialSpan={span}
          variant={variant}
          onLoaded={onLoaded}
          shareable
          back={
            <a
              href={from ?? href({ name: "endpoints", q: "" })}
              onClick={(event) => {
                if (!from || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                goBack(from);
              }}
            >
              {from ? `Back to ${back.at(-1)?.label ?? "the list"}` : "All HTTP requests"}
            </a>
          }
        />
      </div>
    </main>
  );
}
