import {
  ArrowLeftIcon,
  ClearIcon,
  DockBottomIcon,
  DockRightIcon,
  FILTERS,
  filterColor,
  Hint,
  KindBadge,
  PageName,
  type TabId,
  TaskName,
  TraceBadge,
  type TraceLinks,
  type TraceRow,
  type TraceSummary,
} from "@tracepanel/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@tracepanel/ui/components/ui/popover";
import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import { cn } from "@tracepanel/ui/lib/utils";
import { ListFilterIcon, LocateFixedIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ProfileToggle } from "./ProfileToggle";
import { goBackInPanel, openLinked, type PanelView } from "./panelBack";
import { tellWidget } from "./panelLayout";
import { base, source } from "./panelSource";
import { consoleLinks } from "./routes";
import { graphqlOperation, requestPath } from "./sections";

/** Follow new: open each request as it arrives. */
function FollowToggle({ follow, onFollow }: { follow: boolean; onFollow: (value: boolean) => void }) {
  return (
    <Hint title={follow ? "Following new requests" : "Follow new requests"} detail="Opens each request as it arrives.">
      <button
        type="button"
        className={cn("icon-button", follow && "text-brand hover:text-brand")}
        aria-label="Follow new"
        aria-pressed={follow}
        onClick={() => onFollow(!follow)}
      >
        <LocateFixedIcon className="size-4" />
      </button>
    </Hint>
  );
}

/** What acts on the list itself, beside its filter: follow the new requests, clear them. */
export function ListTools({
  follow,
  onFollow,
  onClear,
  clearLabel,
}: {
  follow: boolean;
  onFollow: (value: boolean) => void;
  onClear: () => void;
  clearLabel: string;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <FollowToggle follow={follow} onFollow={onFollow} />
      <ClearButton onClear={onClear} label={clearLabel} />
    </span>
  );
}

/** Profile the next requests: what the panel records, not what the list shows. */
export function PanelProfile() {
  return <ProfileToggle source={source} />;
}

/** Clear, where the requests are listed, as in the browser's Network tab. */
function ClearButton({ onClear, label = "Clear requests" }: { onClear: () => void; label?: string | undefined }) {
  return (
    <Hint title={label} detail="Empties this tab's list. The requests stay in the console.">
      <button type="button" className="icon-button" aria-label={label} onClick={onClear}>
        <ClearIcon />
      </button>
    </Hint>
  );
}

/** A trace as the panel names it in one line: a request by its method and path, a task or a job by its kind and name. */
function TraceName({ trace }: { trace: TraceSummary }) {
  // A view or an action as the list names it ("VIEW /authors"), not by the request line its trace may carry.
  if (trace.kind === "page") return <PageName name={trace.name} />;
  if (trace.kind === "http") return <RequestName trace={trace} />;
  return <KindAndName trace={trace} />;
}

/** A request by its method (GQL for a GraphQL operation) and its path. */
function RequestName({ trace }: { trace: TraceSummary }) {
  const operation = graphqlOperation(trace);
  return (
    <>
      <TraceBadge word={operation ? "GQL" : trace.method} htmx={trace.htmx} />
      <span className="switcher-path">{operation ?? requestPath(trace)}</span>
    </>
  );
}

/** A task, a job, a WebSocket event: its kind's badge and its name, a task's cut at its start. */
function KindAndName({ trace }: { trace: TraceSummary }) {
  return (
    <>
      <KindBadge kind={trace.kind} />
      {trace.kind === "task" ? (
        <TaskName name={trace.name} className="switcher-path" />
      ) : (
        <span className="switcher-path">{trace.name}</span>
      )}
    </>
  );
}

/** A trace's summary: from the list's rows when it is one of them, else as the agent lists it. */
function useNamed(id: string, rows: readonly TraceRow[]): TraceSummary | undefined {
  const known = rows.find((row) => row.trace.id === id)?.trace;
  const loaded = useSummary(known ? null : id);
  return known ?? loaded;
}

/** A trace's summary, as the agent lists it: the panel names the trace a linked one was opened from. */
function useSummary(id: string | null): TraceSummary | undefined {
  const [found, setFound] = useState<TraceSummary>();
  useEffect(() => {
    if (id === null) return;
    let current = true;
    source.listTraces({ ids: [id], limit: 1 }).then(
      ([trace]) => current && setFound(trace),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [id]);
  return found?.id === id ? found : undefined;
}

/** A tab as the Back button names it: where it goes. */
const TAB_NAMES: Record<TabId, string> = {
  request: "Request",
  app: "App",
  tree: "Call tree",
  issues: "Issues",
  sql: "DB",
  cache: "Cache",
  http: "HTTP calls",
  logs: "Logs",
  error: "Error",
  profile: "Profile",
};

// The first tab is named after the trace's kind, as its tab bar names it.
const KIND_TABS: Record<string, string> = { task: "Task", command: "Job", websocket: "WebSocket", page: "View" };

function tabName(tab: TabId | undefined, trace: TraceSummary | undefined): string {
  if (tab === "request") return KIND_TABS[trace?.kind ?? ""] ?? TAB_NAMES.request;
  return tab ? TAB_NAMES[tab] : "Trace";
}

/**
 * The way back to the view a linked trace was opened from, named for where it goes: that trace's tab and the trace,
 * as the list names it ("← Call tree · GQL query Books"). Esc goes there too. `bare` (docked right, the tabs need the
 * room): the arrow alone, its name in its label and tooltip.
 */
export function BackTo({ view, rows, bare }: { view: PanelView | null; rows: readonly TraceRow[]; bare: boolean }) {
  return view ? <BackButton view={view} rows={rows} bare={bare} /> : null;
}

function BackButton({ view, rows, bare }: { view: PanelView; rows: readonly TraceRow[]; bare: boolean }) {
  const trace = useNamed(view.route.id, rows);
  const tab = tabName(view.tab, trace);
  const name = trace ? (graphqlOperation(trace) ?? trace.name) : "the trace";
  return (
    <Hint title={`Back to ${tab} · ${name}`} detail="Where you opened this trace from, as you left it." keys="Esc">
      <button
        type="button"
        className="panel-back"
        data-bare={bare || undefined}
        aria-label={`Back to ${tab} · ${name}`}
        onClick={() => goBackInPanel(currentTrace())}
      >
        <ArrowLeftIcon />
        {bare ? null : (
          <>
            <span className="panel-back-tab">{tab}</span>
            {trace ? (
              <>
                <span aria-hidden="true" className="panel-back-dot">
                  ·
                </span>
                <TraceName trace={trace} />
              </>
            ) : null}
          </>
        )}
      </button>
    </Hint>
  );
}

/** The trace on screen, by the panel's route. */
function currentTrace(): string | null {
  const match = /^#\/t\/([^?]+)/.exec(location.hash);
  return match?.[1] ?? null;
}

/**
 * Where a trace's parts lead from the panel: to the console in a new tab, but a linked trace (a task it enqueued, the
 * trace a call reached) opens here, with the way back to the view on screen.
 */
export const PANEL_LINKS: TraceLinks = {
  ...consoleLinks(base, true),
  openTrace: openLinked,
};

/** The console list a request of this kind belongs to: the way back from its trace page there. */
export function sectionFor(kind: string | undefined): string | undefined {
  const section = {
    http: "endpoints",
    task: "tasks",
    command: "jobs",
    websocket: "websockets",
    rpc: "rpc",
    page: "pages",
  }[kind ?? ""];
  return section ? `#/${section}` : undefined;
}

// Per tab: on in every new one, whatever was switched off elsewhere.
const FOLLOW_KEY = "tracepanel:follow-tab";

/** On unless turned off: the newest request is usually the one to look at, as in the browser's Network tab. */
export function readFollow(): boolean {
  return readItem(FOLLOW_KEY, "sessionStorage") !== "0";
}

export function writeFollow(value: boolean): void {
  writeItem(FOLLOW_KEY, value ? "1" : "0", "sessionStorage");
}

/** Moves the panel to the other side: the bottom or the right. */
export function DockButton({ dock }: { dock: string }) {
  const label = dock === "right" ? "Dock to bottom" : "Dock to right";
  return (
    <Hint title={label} detail="The panel remembers where you put it.">
      <button type="button" className="icon-button" aria-label={label} onClick={() => tellWidget("tracepanel:dock")}>
        {dock === "right" ? <DockBottomIcon /> : <DockRightIcon />}
      </button>
    </Hint>
  );
}

const KINDS_KEY = "tracepanel:panel-kinds";

/** The kinds of calls the panel shows (none: all), remembered: the Show menu's. */
export function useShownKinds(): [readonly string[], (kinds: readonly string[]) => void] {
  const [kinds, setKinds] = useState<readonly string[]>(() => {
    try {
      const stored = JSON.parse(readItem(KINDS_KEY) ?? "[]");
      return Array.isArray(stored) ? stored.filter((each) => typeof each === "string") : [];
    } catch {
      return [];
    }
  });
  const keep = (next: readonly string[]) => {
    setKinds(next);
    writeItem(KINDS_KEY, next.length > 0 ? JSON.stringify(next) : null);
  };
  return [kinds, keep];
}

/** Logs as a kind the menu offers: a record's log rows (warnings and errors, as the tree shows them). */
const LOGS = { id: "log", label: "Logs", kinds: ["log"] } as const;

type Shown = (typeof FILTERS)[number] | typeof LOGS;

/** A filter's own: what ran down a record's chain (its counts' span_kinds) has it. */
function hasFilter(present: ReadonlySet<string>, filter: Shown): boolean {
  return present.has(filter.id) || filter.kinds.some((kind) => present.has(kind));
}

/** Whether a record has any of the kinds picked (none picked: every record). */
export function showsKinds(spanKinds: readonly string[] | undefined, kinds: readonly string[]): boolean {
  if (kinds.length === 0) return true;
  const present = new Set(spanKinds ?? []);
  return [...FILTERS, LOGS].some((filter) => kinds.includes(filter.id) && hasFilter(present, filter));
}

/** The kinds the list's records have, the ones picked kept: what the Show menu offers. */
export function offeredKinds(spanKinds: readonly (readonly string[] | undefined)[], kinds: readonly string[]) {
  const present = new Set(spanKinds.flatMap((each) => each ?? []));
  return [...FILTERS, LOGS].filter((filter) => kinds.includes(filter.id) || hasFilter(present, filter));
}

/** The kinds offered first: what a request's calls mostly are. The rest follow. */
const FIRST: readonly string[] = ["sql", "http", "graphql", "function", "cache", "redis", "messaging", "task"];

/**
 * Beside the filter: which kinds of calls the tree shows, every record's (only SQL, only GraphQL…). Its icon is
 * raised while some are picked.
 */
export function KindsMenu({
  kinds,
  offered: present,
  onKinds,
}: {
  kinds: readonly string[];
  offered: readonly Shown[];
  onKinds: (kinds: readonly string[]) => void;
}) {
  const offered = [
    ...present.filter((filter) => FIRST.includes(filter.id)),
    ...present.filter((filter) => !FIRST.includes(filter.id)),
  ];
  const [open, setOpen] = useState(false);
  if (offered.length === 0) return null;
  const label = kinds.length > 0 ? `Showing ${kinds.length === 1 ? "1 kind" : `${kinds.length} kinds`}` : "Show";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint title={kinds.length > 0 ? label : "Show only some kinds"} off={open}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn("icon-button", kinds.length > 0 && "text-brand hover:text-brand")}
            aria-label={label}
            aria-pressed={kinds.length > 0}
          >
            <ListFilterIcon size={16} />
          </button>
        </PopoverTrigger>
      </Hint>
      {/* The time legend's own chips: a kind's swatch and name, pressed while picked. */}
      <PopoverContent align="start" className="tp-kinds-menu w-72 p-2">
        <div className="flex flex-wrap gap-1.5">
          {offered.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className="tp-map-filter"
              aria-pressed={kinds.includes(filter.id)}
              onClick={() =>
                onKinds(kinds.includes(filter.id) ? kinds.filter((each) => each !== filter.id) : [...kinds, filter.id])
              }
            >
              <span className="tp-swatch" style={{ background: `var(--tp-k-${filterColor(filter.id)})` }} />
              {filter.label}
            </button>
          ))}
          {kinds.length > 0 ? (
            <button type="button" className="tp-map-filter-clear" onClick={() => onKinds([])}>
              Show all
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
