import {
  ArrowUpRightIcon,
  BugIcon,
  CableIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CompassIcon,
  DatabaseIcon,
  FlameIcon,
  GlobeIcon,
  ListChecksIcon,
  ListIcon,
  ListTreeIcon,
  ScrollTextIcon,
  TerminalIcon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { type ComponentProps, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CallMap } from "./CallMap";
import { CallsList } from "./CallsList";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { ErrorView } from "./ErrorView";
import { duration } from "./format";
import { useCloseOnBlur } from "./hooks/useCloseOnBlur";
import { IssueList } from "./IssueList";
import { LogList } from "./LogList";
import { groupNoun } from "./lib/calls";
import { isTyping } from "./lib/keys";
import { pageParts } from "./lib/page";
import { linkProps, type TraceLinks } from "./links";
import { Metrics } from "./Metrics";
import { ProfileView } from "./ProfileView";
import { MethodBadge, RoutePath, StatusBadge } from "./primitives";
import { RequestInfo } from "./RequestInfo";
import { type Explain, SqlList } from "./SqlList";
import { type SystemCalls, systemCalls, systemOfIssue } from "./systemCalls";
import { Tabs } from "./Tabs";
import { Timeline } from "./Timeline";
import type { Issue, IssueKind, Related, Trace } from "./types";

export type TabId = "request" | "tree" | "issues" | "sql" | "cache" | "http" | "logs" | "error" | "profile";

/** A way out of this trace that the page itself doesn't show: its group, its issues, what ran around it. */
export interface ExploreItem {
  label: string;
  hint: string;
  icon: "group" | "issue" | "logs";
  /** Where it leads, as a link (Cmd-click opens a new tab); without it, `onSelect` acts. */
  href?: string | undefined;
  onSelect?: (() => void) | undefined;
}

const EXPLORE_ICONS = { group: ListIcon, issue: CircleAlertIcon, logs: ScrollTextIcon };

/** The badge and title of a trace, by kind: a GraphQL request is its operation, not POST /graphql/. */
function htmxOf(trace: Trace): "request" | "boosted" | null {
  if (!trace.attrs["htmx.request"]) return null;
  return trace.attrs["htmx.boosted"] ? "boosted" : "request";
}

/** A view or an action in the browser: VIEW /books, or CLICK "Save" · /books. */
function pageHeading(name: string): { badge: string; title: string } {
  const { badge, label, page } = pageParts(name);
  return { badge, title: page ? `${label} · ${page}` : label };
}

/** The heading of a trace that isn't a request, by its kind. */
const KIND_HEADINGS: Record<string, (name: string) => { badge: string; title: string }> = {
  task: (name) => ({ badge: "TASK", title: name }),
  command: (name) => ({ badge: "JOB", title: name }),
  websocket: (name) => ({ badge: "WS", title: name.replace(/^WS /, "") }),
  page: pageHeading,
};

function heading(trace: Trace): { badge: string; title: string } {
  const attrs = trace.attrs;
  const operation = attrs["graphql.operation"];
  if (typeof operation === "string") return { badge: "GQL", title: operation };
  const byKind = KIND_HEADINGS[trace.kind];
  if (byKind) return byKind(trace.name);
  const method = attrs["http.method"];
  const path = attrs["http.path"];
  return {
    badge: typeof method === "string" ? method : (trace.name.split(" ")[0] ?? ""),
    title: typeof path === "string" ? path : trace.name,
  };
}

/**
 * What could be better in the request (N+1, slow SQL, htmx…). Errors are kept with the issues for grouping, but a
 * trace shows its exception on the Error tab only.
 */
function findingsOf(trace: Trace): Trace["issues"] {
  return trace.issues.filter((issue) => issue.kind !== "error");
}

/**
 * The systems a request is most often opened for get a tab each: its SQL, its cache and its HTTP calls. The others
 * (Redis used directly, MongoDB, a broker…) are in the call tree, and the console has a page for each.
 */
type CallsTabId = "sql" | "cache" | "http";
const CALLS_TABS: readonly { id: CallsTabId; system: string; label: string; icon: typeof GlobeIcon }[] = [
  { id: "sql", system: "sql", label: "DB", icon: DatabaseIcon },
  { id: "cache", system: "cache", label: "Cache", icon: ZapIcon },
  // HTTP calls are spans of kind `http.client`.
  { id: "http", system: "http.client", label: "HTTP calls", icon: ArrowUpRightIcon },
];

function isCallsTab(tab: string | undefined): tab is CallsTabId {
  return CALLS_TABS.some((each) => each.id === tab);
}

/** The tab a system's calls are listed in, if it has one. */
function tabOfSystem(system: string | undefined): CallsTabId | undefined {
  return CALLS_TABS.find((each) => each.system === system)?.id;
}

/** The calls each of those tabs lists, by its id: only the systems the request called. */
function callsByTab(trace: Trace): Partial<Record<CallsTabId, SystemCalls>> {
  return Object.fromEntries(
    systemCalls(trace).flatMap((each) => {
      const tab = tabOfSystem(each.key);
      return tab ? [[tab, each]] : [];
    }),
  );
}

/** The tabs a trace shows only when it has something for them (issues, an error, SQL, the cache, HTTP calls). */
const OPTIONAL_TABS: Partial<Record<TabId, (trace: Trace) => boolean>> = {
  issues: (trace) => findingsOf(trace).length > 0,
  error: (trace) => trace.errors.length > 0,
  sql: (trace) => callsByTab(trace).sql !== undefined,
  cache: (trace) => callsByTab(trace).cache !== undefined,
  http: (trace) => callsByTab(trace).http !== undefined,
  profile: (trace) => trace.profile !== undefined,
};

function hasTab(trace: Trace, tab: TabId | undefined): tab is TabId {
  if (tab === undefined) return false;
  return OPTIONAL_TABS[tab]?.(trace) ?? true;
}

/** The tabs that list spans: SQL with its plans, the cache's and HTTP calls grouped by what they repeat. */
function SpanLists({
  active,
  calls,
  sql,
}: {
  active: TabId;
  calls: Partial<Record<CallsTabId, SystemCalls>>;
  sql: Omit<ComponentProps<typeof SqlList>, "spans">;
}) {
  if (!isCallsTab(active)) return null;
  return <SystemList system={active} calls={calls[active]} {...sql} />;
}

/** One system's calls: SQL with its plans, the others grouped by what they repeat. */
function SystemList({
  system,
  calls,
  ...props
}: Omit<ComponentProps<typeof SqlList>, "spans"> & { system: CallsTabId; calls: SystemCalls | undefined }) {
  const spans = calls?.spans ?? [];
  return system === "sql" ? (
    <SqlList spans={spans} {...props} />
  ) : (
    <CallsList spans={spans} issueBySpan={props.issueBySpan} focus={props.focus} />
  );
}

/** What an issue's spans are called on its Show button: "queries", "HTTP calls", by the kind of its first span. */
function nounsOf(trace: Trace): (issue: Issue) => string {
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  return (issue) => groupNoun(byId.get(String(issue.span_ids[0])), issue.count);
}

/** A tab for a list, when the list has anything. */
function tabIfAny<T>(items: readonly unknown[], tab: T): T[] {
  return items.length > 0 ? [tab] : [];
}

/** Where an issue's spans are listed: the tab of their system, if it has one, else the call tree. */
function tabOfSpans(trace: Trace, ids: readonly string[]): TabId {
  return tabOfSystem(systemOfIssue(trace, ids[0])) ?? "tree";
}

const KIND_ICONS: Record<string, typeof GlobeIcon> = {
  http: GlobeIcon,
  task: ListChecksIcon,
  command: TerminalIcon,
  websocket: CableIcon,
};

const KIND_LABELS: Record<string, string> = { task: "Task", command: "Command" };

/** A system's tab, when the request called it: how many calls, and how long they took together. */
function callsTabs(calls: Partial<Record<CallsTabId, SystemCalls>>) {
  return CALLS_TABS.flatMap(({ id, label, icon: Icon }) => {
    const of = calls[id];
    return of
      ? [{ id, label, icon: <Icon />, count: of.spans.length, detail: of.total > 0 ? duration(of.total) : undefined }]
      : [];
  });
}

/** The trace's tabs, in the order they show: each list's only when it has anything. */
function traceTabs({
  trace,
  outcome,
  findings,
  calls,
}: {
  trace: Trace;
  outcome: ReactNode;
  findings: readonly Issue[];
  calls: Partial<Record<CallsTabId, SystemCalls>>;
}) {
  const KindIcon = KIND_ICONS[trace.kind] ?? GlobeIcon;
  return [
    {
      id: "request" as const,
      label: KIND_LABELS[trace.kind] ?? "Request",
      icon: <KindIcon />,
      // How it went and how long it took, on the tab that describes it: no separate metrics line.
      badge: outcome,
      detail: duration(trace.duration),
    },
    // Second, but open by default: the call tree is where a slow or failing request is explained.
    { id: "tree" as const, label: "Call tree", icon: <ListTreeIcon /> },
    // What failed comes before what could be better.
    ...tabIfAny(trace.errors, {
      id: "error" as const,
      label: "Error",
      icon: <BugIcon />,
      count: trace.errors.length,
      tone: "error" as const,
    }),
    ...tabIfAny(findings, {
      id: "issues" as const,
      label: "Issues",
      icon: <TriangleAlertIcon />,
      count: findings.length,
      tone: "warn" as const,
    }),
    // What a request is most often opened for: its SQL, cache and HTTP calls, and its logs.
    ...callsTabs(calls),
    { id: "logs" as const, label: "Logs", icon: <ScrollTextIcon />, count: trace.logs.length },
    // Recorded only when asked for: where the time went in code.
    ...(trace.profile ? [{ id: "profile" as const, label: "Profile", icon: <FlameIcon /> }] : []),
  ];
}

// task.state is upper case (SUCCESS, FAILURE…): looked up lower-cased.
const STATE_TONES: Record<string, string> = { success: "ok", failure: "error", retry: "warn", skipped: "info" };

export interface TraceViewProps {
  trace: Trace;
  /**
   * `compact` for the in-page panel: no title (the switcher shows it), one-line metrics, no overview timeline.
   * `strip` for the panel docked at the bottom: tabs, Explore and `actions` in a single toolbar row.
   */
  variant?: "full" | "compact" | "strip" | undefined;
  /** The Explore menu; hidden when empty. */
  explore?: readonly ExploreItem[] | undefined;
  /** Called when another tab opens (the console keeps it in the URL). */
  onTabChange?: ((tab: TabId) => void) | undefined;
  /** Extra header buttons from the host page (open full page, close), shown after Explore. */
  actions?: ReactNode;
  /** Traces linked to this one (Celery enqueues). */
  related?: Related | undefined;
  /** Where linked traces, issues, statements and logs lead; each missing leaves its links out. */
  links?: TraceLinks | undefined;
  /** A span to open in the call tree, as a link to it asks. */
  initialSpan?: string | undefined;
  /** Tab to open first; by default Error for a failed request, else the call tree. */
  initialTab?: TabId | undefined;
  /** The tab to open when this trace has it and no error to show first (the panel remembers the last one). */
  preferredTab?: TabId | undefined;
  /** EXPLAIN for a query of this trace; the SQL tab shows an Explain button when given. */
  onExplain?: Explain | undefined;
}

export function TraceView({
  trace,
  explore = [],
  onTabChange,
  onExplain,
  initialTab,
  preferredTab,
  actions,
  related,
  links,
  initialSpan,
  variant = "full",
}: TraceViewProps) {
  const compact = variant === "compact" || variant === "strip";
  const findings = useMemo(() => findingsOf(trace), [trace]);
  const issueBySpan = useMemo(() => {
    const map = new Map<string, IssueKind>();
    for (const issue of trace.issues) for (const id of issue.span_ids) map.set(id, issue.kind);
    return map;
  }, [trace]);
  const [active, setActive] = useState<TabId>(
    // A tab the link asked for that this trace has not (an error tab without an error) falls back like no tab.
    () =>
      hasTab(trace, initialTab)
        ? initialTab
        : trace.errors.length > 0
          ? "error"
          : hasTab(trace, preferredTab)
            ? preferredTab
            : "tree",
  );
  const calls = useMemo(() => callsByTab(trace), [trace]);
  const spansNoun = useMemo(() => nounsOf(trace), [trace]);
  const [focus, setFocus] = useState<ReadonlySet<string> | undefined>(undefined);
  // A span to open in the call tree: from the link's `span`, or a log record's "in the call tree".
  const [treeSpan, setTreeSpan] = useState(initialSpan);

  const status = trace.attrs["http.status_code"];
  const state = trace.attrs["task.state"];
  const outcome =
    typeof status === "number" ? (
      <StatusBadge status={status} />
    ) : typeof state === "string" ? (
      <span className="dt-status" data-tone={STATE_TONES[state.toLowerCase()] ?? "info"}>
        {state.toLowerCase()}
      </span>
    ) : trace.status === "error" ? (
      <span className="dt-status" data-tone="error">
        failed
      </span>
    ) : null;
  const tabs = traceTabs({ trace, outcome, findings, calls });
  const head = heading(trace);
  const path = trace.attrs["http.path"];
  const route = trace.attrs["http.route"];

  const panel = (
    <div role="tabpanel" className="dt-tabpanel">
      {active === "request" ? <RequestInfo trace={trace} related={related} links={links} /> : null}
      {active === "tree" ? (
        <CallMap trace={trace} issueBySpan={issueBySpan} related={related} links={links} initialSpan={treeSpan} />
      ) : null}
      {active === "issues" ? (
        <IssueList
          issues={findings}
          onShowSpans={(ids) => {
            setFocus(new Set(ids));
            setTreeSpan(ids[0]);
            setActive(tabOfSpans(trace, ids));
          }}
          spansNoun={spansNoun}
          links={links}
        />
      ) : null}
      {active === "logs" ? (
        <LogList
          logs={trace.logs}
          start={trace.start}
          traceId={trace.id}
          links={links}
          onShowSpan={(span) => {
            setTreeSpan(span);
            setActive("tree");
          }}
        />
      ) : null}
      <SpanLists active={active} calls={calls} sql={{ issueBySpan, focus, onExplain, links }} />
      {active === "profile" && trace.profile ? <ProfileView profile={trace.profile} /> : null}
      {active === "error" ? (
        <ErrorView
          errors={trace.errors}
          issues={trace.issues.filter((issue) => issue.kind === "error")}
          links={links}
        />
      ) : null}
    </div>
  );
  // In the panel a click on the page doesn't reach the menu: it closes when the frame loses focus.
  const [exploreOpen, setExploreOpen] = useState(false);
  const closeExplore = useCallback(() => setExploreOpen(false), []);
  useCloseOnBlur(exploreOpen, closeExplore);
  const exploreMenu =
    explore.length > 0 ? (
      <DropdownMenu open={exploreOpen} onOpenChange={setExploreOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2.5 text-sm shadow-none"
            aria-label="Explore"
          >
            <CompassIcon />
            <span className="dt-explore-label">Explore</span>
            <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          {explore.map((item) => {
            const Icon = EXPLORE_ICONS[item.icon];
            const body = (
              <>
                <Icon className="mt-0.5" />
                {/* A long route breaks anywhere and stops at two lines; the tooltip has all of it. */}
                <span className="grid min-w-0 gap-0.5">
                  <span className="line-clamp-2 font-medium [overflow-wrap:anywhere]" title={item.label}>
                    {item.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.hint}</span>
                </span>
              </>
            );
            return item.href ? (
              <DropdownMenuItem key={item.label} className="items-start gap-3 py-2" asChild>
                <a {...linkProps(links, item.href)}>{body}</a>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={item.label} className="items-start gap-3 py-2" onSelect={() => item.onSelect?.()}>
                {body}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  const openTab = (id: TabId) => {
    setActive(id);
    setFocus(undefined);
    onTabChange?.(id);
  };
  // 1–7 open the tabs in the order they are shown; the latest list, without rebinding on every render.
  const shown = useRef({ tabs, openTab });
  shown.current = { tabs, openTab };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event)) return;
      const tab = shown.current.tabs[Number(event.key) - 1];
      if (!/^[1-9]$/.test(event.key) || tab === undefined) return;
      event.preventDefault();
      shown.current.openTab(tab.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tabsBar = <Tabs label="Trace details" tabs={tabs} active={active} onChange={openTab} />;

  // In the panel (either dock) the tabs carry the status and timings: one toolbar row, then the content.
  if (compact) {
    return (
      <article className="dt-trace" data-variant="strip">
        <header className="dt-trace-strip">
          {tabsBar}
          {/* No status or duration here: the request list beside the trace shows them on the selected row. */}
          <span className="flex-1" />
          {exploreMenu}
          {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
        </header>
        {panel}
      </article>
    );
  }

  return (
    <article className="dt-trace" data-variant={variant}>
      <header className="dt-trace-head">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="dt-trace-title" hidden={compact}>
              <MethodBadge method={head.badge} htmx={htmxOf(trace)} />
              <h2>{head.title}</h2>
              <StatusBadge status={typeof status === "number" ? status : null} />
              <span className="dt-trace-time">{duration(trace.duration)}</span>
            </div>
            {compact ? null : typeof route === "string" && route !== path ? (
              <p className="dt-trace-route">
                route <RoutePath path={route} />
              </p>
            ) : null}
          </div>
          {exploreMenu}
          {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
        </div>
      </header>
      {compact ? null : <Metrics trace={trace} />}
      {compact ? null : (
        <Timeline
          trace={trace}
          onSelect={(target) => {
            if (target.tab === "tree") setTreeSpan(target.span);
            openTab(target.tab);
          }}
        />
      )}
      {tabsBar}
      {panel}
    </article>
  );
}
