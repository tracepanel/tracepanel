import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ClearIcon,
  DockBottomIcon,
  DockRightIcon,
  FILTERS,
  Hint,
  KindBadge,
  LayersIcon,
  type ListChains,
  PageName,
  type TabId,
  TaskName,
  TraceBadge,
  type TraceLinks,
  TraceList,
  type TraceRow,
  type TraceSummary,
} from "@tracepanel/ui";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@tracepanel/ui/components/ui/dropdown-menu";
import { useCloseOnBlur } from "@tracepanel/ui/hooks/useCloseOnBlur";
import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import { cn } from "@tracepanel/ui/lib/utils";
import { ListFilterIcon, LocateFixedIcon } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNewIds } from "./hooks";
import { ProfileToggle } from "./ProfileToggle";
import { goBackInPanel, openLinked, type PanelView } from "./panelBack";
import { tellWidget } from "./panelLayout";
import { manyApps, requestCount } from "./panelRows";
import { base, source } from "./panelSource";
import { consoleLinks, go } from "./routes";
import { graphqlOperation, requestPath } from "./sections";

/** The panel as one waterfall; the older one stays behind this for now. */
export const PANEL_V2 = readItem("tracepanel:panel-v1") !== "1";

/** Follow new: open each request as it arrives. */
function FollowToggle({ follow, onFollow }: { follow: boolean; onFollow: (value: boolean) => void }) {
  const byPointer = useRef(false);
  if (PANEL_V2) {
    return (
      <Hint
        title={follow ? "Following new requests" : "Follow new requests"}
        detail="Opens each request as it arrives."
      >
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
  return (
    <label
      className="toggle"
      title="Open each new request as it arrives"
      onPointerDown={() => (byPointer.current = true)}
    >
      <input
        type="checkbox"
        checked={follow}
        onChange={(event) => {
          onFollow(event.target.checked);
          // A click on the label focuses the hidden box, and Chrome then rings it: a mouse doesn't need the ring.
          if (byPointer.current) event.target.blur();
          byPointer.current = false;
        }}
      />
      <span className="toggle-track" aria-hidden="true" />
      {/* In a narrow list's toolbar row, the switch alone: its name stays for screen readers and in the title. */}
      <span className="@max-[21rem]/brand:sr-only">Follow new</span>
    </label>
  );
}

/** The list's count and its two controls: in the list's head, or in the dock's toolbar row over the list. */
function ListControls({
  count,
  follow,
  onFollow,
  onClear,
}: {
  count: ReactNode;
  follow: boolean;
  onFollow: (value: boolean) => void;
  onClear: () => void;
}) {
  return (
    <>
      <span className="list-count">{count}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <ListToggles follow={follow} onFollow={onFollow} onClear={onClear} />
      </span>
    </>
  );
}

/** Follow new, Profile and Clear: one tight group wherever the list's controls sit. */
export function ListToggles({
  follow,
  onFollow,
  onClear,
  clearLabel,
}: {
  follow: boolean;
  onFollow: (value: boolean) => void;
  onClear: () => void;
  clearLabel?: string | undefined;
}) {
  return (
    <>
      <FollowToggle follow={follow} onFollow={onFollow} />
      <ProfileToggle source={source} />
      <ClearButton onClear={onClear} label={clearLabel} />
    </>
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

/** As on the pill: a stack and the number of this page's requests. */
function RequestCount({ count }: { count: number }) {
  return (
    <span className="switcher-count" title={`${count} ${count === 1 ? "request" : "requests"} on this page`}>
      <LayersIcon />
      {count}
    </span>
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

/** What a trace's row says it opens on, in its tooltip: the tab last picked (NAVIGATION.md, rule 3). */
type OpensOn = ((trace: TraceSummary) => string | undefined) | undefined;

/** The tab last picked, said on the rows a click opens fresh; nothing to say for the call tree, where they open anyway. */
export function opensOnTab(tab: TabId | undefined): OpensOn {
  if (!tab || tab === "tree") return undefined;
  return (trace) => `Opens on ${tabName(tab, trace)}, the tab you used last (the call tree where it has none)`;
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

/** The trace on screen in the panel, as its address says. */
export function currentTrace(): string | null {
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

export function RequestSwitcher({
  rows,
  pageCount,
  selectedId,
  currentId,
  opensOn,
  onClear,
}: {
  rows: readonly TraceRow[];
  /** This page's requests, as the pill counts them. */
  pageCount: number;
  selectedId: string | null;
  currentId: string | null;
  opensOn: OpensOn;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = rows.find((row) => row.trace.id === selectedId)?.trace;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // This Esc closes the list, not the panel.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const closeList = useCallback(() => setOpen(false), []);
  useCloseOnBlur(open, closeList);

  return (
    <div className="switcher" ref={root}>
      <button
        type="button"
        className="switcher-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {selected ? <TraceName trace={selected} /> : <span className="switcher-path">Requests</span>}
        <RequestCount count={pageCount} />
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="switcher-popover">
          <div className="switcher-caption">
            Pages and requests in this browser tab
            <ClearButton
              onClear={() => {
                setOpen(false);
                onClear();
              }}
            />
          </div>
          <TraceList
            rows={rows}
            services={manyApps(rows)}
            selectedId={selectedId}
            currentId={currentId}
            opensOn={opensOn}
            onSelect={(id) => {
              setOpen(false);
              go({ name: "trace", id });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

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

/** Close enough to the end to count as reading the newest requests. */
const BOTTOM_SLACK = 24;

/**
 * New requests arrive at the bottom, as in a terminal: a list scrolled to its end stays there (and Follow always
 * scrolls), while a list scrolled up to read something stays put and counts what arrived below, for "↓ N new".
 */
function useStickToBottom(
  list: RefObject<HTMLElement | null>,
  count: number,
  follow: boolean,
): { unseen: number; jump: () => void } {
  const seen = useRef(count);
  // The list's height before the latest rows: was it scrolled to the end then? Measured, not tracked through
  // scroll events, which a hidden tab delivers late.
  const height = useRef(0);
  const [unseen, setUnseen] = useState(0);

  const jump = useCallback(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
    setUnseen(0);
  }, [list]);

  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const onScroll = () => {
      if (element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK) setUnseen(0);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [list]);

  // Before paint: the list never shows a frame scrolled away from its end.
  useLayoutEffect(() => {
    const element = list.current;
    const added = count - seen.current;
    seen.current = count;
    const wasAtEnd =
      !element || height.current === 0 || height.current - element.scrollTop - element.clientHeight <= BOTTOM_SLACK;
    if (wasAtEnd || follow) {
      if (element) element.scrollTop = endKeepingSelected(element);
      setUnseen(0);
    } else if (added > 0) setUnseen((value) => value + added);
    height.current = element?.scrollHeight ?? 0;
  }, [count, follow, list]);

  return { unseen, jump };
}

/**
 * Where a list kept at its end scrolls to as rows arrive: its end, unless that would take the selected row up under
 * its sticky head (a view whose calls all came at once): then as far as keeps that row in sight, below the head.
 */
function endKeepingSelected(element: HTMLElement): number {
  const end = element.scrollHeight - element.clientHeight;
  const selected = element.querySelector<HTMLElement>('.dt-request-row[aria-current="true"]');
  if (!selected) return end;
  const head = element.querySelector<HTMLElement>(".page-requests-head")?.offsetHeight ?? 0;
  const top = selected.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
  return Math.max(0, Math.min(end, top - head));
}

/** The list of this page's requests, or the browser tab's: its class, its accessible name, its head's name. */
const LIST_SCOPES = {
  page: { className: "page-requests", label: "Requests made by this page", name: "This page" },
  tab: { className: "page-requests panel-list", label: "Pages and requests in this browser tab", name: "This tab" },
} as const;

/**
 * The current page and every fetch/XHR it made, above the trace; docked at the bottom, every page and request of the
 * browser tab, beside the trace (`scope="tab"`).
 */
export function PageRequests({
  scope = "page",
  head = true,
  rows,
  selectedId,
  currentId = null,
  follow,
  onFollow,
  onClear,
  chains,
  opensOn,
}: {
  scope?: "page" | "tab";
  /** false where the dock's toolbar row carries the count and the controls. */
  head?: boolean;
  rows: readonly TraceRow[];
  selectedId: string | null;
  currentId?: string | null;
  follow: boolean;
  onFollow: (value: boolean) => void;
  onClear: () => void;
  /** Under the rows that called other apps: those apps' traces. */
  chains?: ListChains | undefined;
  opensOn: OpensOn;
}) {
  const fresh = useNewIds(rows.map((row) => row.key ?? row.trace.id));
  const list = useRef<HTMLElement>(null);
  const { unseen, jump } = useStickToBottom(list, rows.length, follow);
  // Requests only, as the pill counts them: not the runs under them, not the browser's views and actions.
  const requests = requestCount(rows);
  const count = `· ${requests} ${requests === 1 ? "request" : "requests"}`;
  const look = LIST_SCOPES[scope];
  return (
    <section ref={list} className={look.className} aria-label={look.label}>
      {head ? (
        <div className="page-requests-head">
          <ListControls
            count={
              <>
                {look.name} <span className="page-requests-count">{count}</span>
              </>
            }
            follow={follow}
            onFollow={onFollow}
            onClear={onClear}
          />
        </div>
      ) : null}
      <TraceList
        compact={true}
        services={manyApps(rows)}
        rows={rows}
        selectedId={selectedId}
        currentId={currentId}
        newIds={fresh}
        chains={chains}
        opensOn={opensOn}
        onSelect={(id) => go({ name: "trace", id })}
      />
      {unseen > 0 ? (
        <button type="button" className="new-requests" onClick={jump}>
          ↓ {unseen} new
        </button>
      ) : null}
    </section>
  );
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

/** A kind's colour, the bars' own: the closest share where a kind has none of its own (GraphQL, functions: code). */
function filterColor(id: string): string {
  const own: Record<string, string> = {
    sql: "sql",
    redis: "redis",
    cache: "cache",
    datastore: "datastore",
    messaging: "messaging",
    http: "http",
    rpc: "http",
    storage: "storage",
    llm: "llm",
    migration: "migration",
    signal: "signal",
    template: "template",
    mail: "mail",
    task: "messaging",
    channels: "messaging",
    transaction: "sql",
    error: "log",
    log: "log",
  };
  return own[id] ?? "view";
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
  if (offered.length === 0) return null;
  const label = kinds.length > 0 ? `Showing ${kinds.length === 1 ? "1 kind" : `${kinds.length} kinds`}` : "Show";
  return (
    <DropdownMenu>
      <Hint title={label} detail="Which calls the tree shows: only SQL, only GraphQL… The rest are hidden.">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn("icon-button", kinds.length > 0 && "text-brand hover:text-brand")}
            aria-label={label}
            aria-pressed={kinds.length > 0}
          >
            <ListFilterIcon size={16} />
          </button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="start" className="dt-kinds-menu max-h-96 w-44 overflow-y-auto">
        {offered.map((filter) => (
          <DropdownMenuCheckboxItem
            key={filter.id}
            checked={kinds.includes(filter.id)}
            onCheckedChange={(checked) =>
              onKinds(checked ? [...kinds, filter.id] : kinds.filter((each) => each !== filter.id))
            }
            onSelect={(event) => event.preventDefault()}
            className="gap-2"
          >
            {/* Its colour, as the bars and the time's legend have it. */}
            <span className="dt-kind-dot" style={{ background: `var(--dt-k-${filterColor(filter.id)})` }} />
            {filter.label}
          </DropdownMenuCheckboxItem>
        ))}
        {kinds.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onKinds([])}>Show all</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
