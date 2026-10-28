import {
  ArrowUpRightIcon,
  BoxIcon,
  BugIcon,
  CableIcon,
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
import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AppDetails, appSaidAnything } from "./AppDetails";
import { appWarnings, warningsTone } from "./AppWarnings";
import { CallMap, type TraceProfileOpener } from "./CallMap";
import type { Explain } from "./CallTable";
import { ScopedCalls, ScopedIssues } from "./ChainTabs";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { ErrorView } from "./ErrorView";
import { duration } from "./format";
import { HeadFacts } from "./HeadFacts";
import { Hint } from "./Hint";
import { useMenuOpen } from "./hooks/useCloseOnBlur";
import { type TraceScope, useTraceScope } from "./hooks/useTraceChain";
import { IssueList } from "./IssueList";
import { LogsPane } from "./LogList";
import { groupNoun } from "./lib/calls";
import { isTyping } from "./lib/keys";
import { scopedIssues, scopedSpans } from "./lib/scope";
import type { Slice } from "./lib/slice";
import { linkProps, opensTraces, openTraceAt, type TraceLinks } from "./links";
import { ProfileTab } from "./ProfileView";
import { RoutePath, StatusBadge, TraceBadge } from "./primitives";
import { RequestInfo } from "./RequestInfo";
import { UnderThis, underCounts } from "./ScopeBar";
import { type SystemCalls, systemCalls, systemOfIssue } from "./systemCalls";
import { Tabs } from "./Tabs";
import { type MarkTarget, TimeStrip } from "./Timeline";
import { SliceScope } from "./TimeSlice";
import { HeadingTitle, heading, htmxOf, outcomeOf } from "./TraceHeading";
import type { App, Chain, Issue, IssueKind, Related, Trace } from "./types";

export type TabId = "request" | "app" | "tree" | "issues" | "sql" | "cache" | "http" | "logs" | "error" | "profile";

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
const OPTIONAL_TABS: Partial<Record<TabId, (trace: Trace, app?: App | null) => boolean>> = {
  // The app's own, in the panel: when it said anything about itself.
  app: (_trace, app) => appSaidAnything(app),
  issues: (trace) => findingsOf(trace).length > 0,
  error: (trace) => trace.errors.length > 0,
  sql: (trace) => callsByTab(trace).sql !== undefined,
  cache: (trace) => callsByTab(trace).cache !== undefined,
  http: (trace) => callsByTab(trace).http !== undefined,
  profile: (trace) => trace.profile !== undefined,
};

function hasTab(trace: Trace, tab: TabId | undefined, app?: App | null): tab is TabId {
  if (tab === undefined) return false;
  return OPTIONAL_TABS[tab]?.(trace, app) ?? true;
}

/** The App tab's content: the app's settings and versions, when it said them. */
function AppPane({ open, app, links }: { open: boolean; app: App | null | undefined; links: TraceLinks | undefined }) {
  if (!open || !appSaidAnything(app)) return null;
  return (
    <div className="@container p-4">
      <AppDetails app={app} links={links} />
    </div>
  );
}

/**
 * The tabs that list spans, over the trace's scope (its chain of calls, or what is under a row): SQL with its plans,
 * the cache's and HTTP calls grouped by what they repeat.
 */
function SpanLists({ active, ...props }: { active: TabId } & Omit<ComponentProps<typeof ScopedCalls>, "tab">) {
  if (!isCallsTab(active)) return null;
  return <ScopedCalls key={active} tab={active} {...props} />;
}

/** The Issues tab: the trace's own, or, over a chain of calls or under a row, the scope's with their apps. */
function IssuesPane({
  open,
  chain,
  findings,
  links,
  onShowSpans,
  onShowRow,
  spansNoun,
}: {
  open: boolean;
  chain: TraceScope;
  findings: readonly Issue[];
  links: TraceLinks | undefined;
  onShowSpans: (ids: readonly string[]) => void;
  onShowRow: (row: string) => void;
  spansNoun: (issue: Issue) => string;
}) {
  if (!open) return null;
  if (isAlone(chain)) {
    return <IssueList issues={findings} onShowSpans={onShowSpans} spansNoun={spansNoun} links={links} />;
  }
  return <ScopedIssues chain={chain} links={links} onShowRow={onShowRow} />;
}

/** A trace with no traces down its calls, and nothing under a row asked for: its tabs list its own. */
function isAlone(chain: TraceScope): boolean {
  return chain.members.length < 2 && chain.scope === null;
}

/** The issues of the trace's chain the Issues tab counts: what could be better, the chain's N+1 across apps too. */
function chainFindings(chain: TraceScope, findings: readonly Issue[]): readonly Issue[] {
  if (isAlone(chain)) return findings;
  return scopedIssues(chain.members, null, chain.chainIssues).filter((issue) => issue.kind !== "error");
}

/** Each issue's kind by its spans, in every trace of the chain: the lists mark the calls an issue points at. */
function issuesBySpan(chain: TraceScope): Map<string, IssueKind> {
  const map = new Map<string, IssueKind>();
  const issues = [...chain.members.flatMap((member) => member.trace.issues), ...chain.chainIssues];
  for (const issue of issues) for (const id of issue.span_ids) map.set(id, issue.kind);
  return map;
}

/**
 * EXPLAIN for a query of any trace of the chain: the trace's own through `onExplain`, another app's through that
 * app's (`explainIn`), which the agent asks.
 */
function chainExplain(
  chain: TraceScope,
  onExplain: Explain | undefined,
  explainIn: ((traceId: string) => Explain) | undefined,
): Explain | undefined {
  if (!onExplain) return undefined;
  return (span, analyze) => {
    const owner = chain.members.find((member) => member.trace.spans.some((each) => each.id === span));
    return owner && owner !== chain.members[0] && explainIn
      ? explainIn(owner.id)(span, analyze)
      : onExplain(span, analyze);
  };
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

// A command is a job wherever the console names it: the sidebar, its badge (JOB) and its first tab.
const KIND_LABELS: Record<string, string> = { task: "Task", command: "Job", websocket: "WebSocket", page: "Page" };

/** A system's tab, when the request called it: how many calls, and how long they took together. */
function callsTabs(calls: Partial<Record<CallsTabId, SystemCalls>>) {
  return CALLS_TABS.flatMap(({ id, label, icon: Icon }) => {
    const of = calls[id];
    return of
      ? [{ id, label, icon: <Icon />, count: of.spans.length, detail: of.total > 0 ? duration(of.total) : undefined }]
      : [];
  });
}

/** The App tab, when the app said anything about itself. */
function appTab(app: App | null | undefined) {
  if (!appSaidAnything(app)) return [];
  // What is wrong with the app, counted on its tab: none, no count.
  const warnings = appWarnings(app);
  const count = warnings.length ? { count: warnings.length, tone: warningsTone(warnings) } : {};
  return [{ id: "app" as const, label: "App", icon: <BoxIcon />, ...count }];
}

/** The trace's tabs, in the order they show: each list's only when it has anything. */
function traceTabs({
  trace,
  outcome,
  findings,
  calls,
  app,
  logs,
  profiled,
}: {
  trace: Trace;
  outcome: ReactNode;
  findings: readonly Issue[];
  calls: Partial<Record<CallsTabId, SystemCalls>>;
  app: App | null | undefined;
  /** How many records the trace's chain of calls has: its own and those of the traces down its calls. */
  logs: number;
  /** Whether the trace or a trace down its calls was profiled. */
  profiled: boolean;
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
    // What a request is most often opened for: its SQL, cache and HTTP calls, and its logs when it wrote any.
    ...callsTabs(calls),
    ...(logs > 0 ? [{ id: "logs" as const, label: "Logs", icon: <ScrollTextIcon />, count: logs }] : []),
    // Recorded only when asked for: where the time went in code.
    ...(profiled ? [{ id: "profile" as const, label: "Profile", icon: <FlameIcon /> }] : []),
    // Last: the app that served it, its settings and versions, when its SDK says them. About the app, not this request.
    ...appTab(app),
  ];
}

/**
 * The panel's one toolbar row: the way back to the trace this one was opened from, the tabs, Explore and the host's
 * buttons. No status or duration here: the request list beside the trace shows them on the selected row.
 */
function StripHeader({
  lead,
  tabs,
  explore,
  actions,
}: {
  lead: ReactNode;
  tabs: ReactNode;
  explore: ReactNode;
  actions: ReactNode;
}) {
  return (
    <header className="dt-trace-strip">
      {lead}
      {tabs}
      {explore}
      {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </header>
  );
}

/** Explore on its own before the host's buttons, or wherever the host's function puts it among them. */
function placeExplore(
  explore: ReactNode,
  actions: TraceViewProps["actions"],
): { explore: ReactNode; actions: ReactNode } {
  return typeof actions === "function" ? { explore: null, actions: actions(explore) } : { explore, actions };
}

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
  /**
   * Extra header buttons from the host page (open full page, close), shown after Explore; or a function of the
   * Explore button that places it among them (the panel: after Console, with the other icons).
   */
  actions?: ReactNode | ((explore: ReactNode) => ReactNode);
  /** In the panel, before the tabs: the way back to the trace this one was opened from. */
  lead?: ReactNode;
  /** Traces linked to this one (Celery enqueues). */
  related?: Related | undefined;
  /** Another trace's links: the call tree opens the chain of calls through them, a level at a time. */
  loadRelated?: ((traceId: string) => Promise<Related>) | undefined;
  /** The trace's whole chain of calls, on its clock: the tabs list and add it up (Logs). */
  loadChain?: ((traceId: string) => Promise<Chain>) | undefined;
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
  /** EXPLAIN for a query of another trace of its chain of calls (another app's). */
  explainIn?: ((traceId: string) => Explain) | undefined;
  /** The app that served it, as it said itself: an App tab after Request when it said anything (the panel). */
  app?: App | null | undefined;
  /** The part of the time to pick in the call tree, as a link asks (kinds of calls, a stretch of time). */
  initialSlice?: Slice | undefined;
  /** Called when another part of the time is picked (the console keeps it in the URL). */
  onSliceChange?: ((slice: Slice) => void) | undefined;
  /**
   * Opens a call's trace's profile by its id, from the call tree (its flame, its code rows). By default it opens as a
   * linked trace does (`links`), at its Profile tab.
   */
  onTraceProfile?: TraceProfileOpener | undefined;
}

/**
 * The tab a link asked for, until it opens or another is picked: one only the trace's chain of calls has (its
 * queries, when the trace is a browser's view) opens when the chain comes.
 */
function useAskedTab(initialTab: TabId | undefined, tabs: readonly { id: TabId }[], open: (tab: TabId) => void) {
  const asked = useRef(initialTab);
  const ids = tabs.map((tab) => tab.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tabs shown changed (`ids`).
  useEffect(() => {
    const tab = asked.current;
    if (tab && tabs.some((each) => each.id === tab)) {
      asked.current = undefined;
      open(tab);
    }
  }, [ids]);
  return asked;
}

/** What the trace's tabs count over its chain: the calls each lists, its issues, each span's issue. */
function useChainTabs(trace: Trace, chain: TraceScope, findings: readonly Issue[]) {
  return useMemo(() => {
    const spans = scopedSpans(chain.members, null, () => true);
    return {
      calls: callsByTab({ ...trace, spans }),
      findings: chainFindings(chain, findings),
      issueBySpan: issuesBySpan(chain),
    };
  }, [trace, chain, findings]);
}

/** The Request tab: the trace's facts and parts; in the panel (`panel`) its request's line on top. */
function RequestPane({
  open,
  trace,
  related,
  links,
  panel,
}: {
  open: boolean;
  trace: Trace;
  related: Related | undefined;
  links: TraceLinks | undefined;
  panel: boolean;
}) {
  if (!open) return null;
  return <RequestInfo trace={trace} related={related} links={links} hero={panel} />;
}

/**
 * The Call tree tab: the trace's time strip and its legend over the tree, one unit, the same on the page and in the
 * panel. The trace's time is shown here only.
 */
function TreePane({
  open,
  onSelect,
  chain,
  openTab,
  ...tree
}: ComponentProps<typeof CallMap> & {
  open: boolean;
  onSelect: (target: MarkTarget) => void;
  /** What a row's "Under this" counts, and where its counts lead. */
  chain: TraceScope;
  openTab: (tab: TabId) => void;
}) {
  if (!open) return null;
  const onProfile = tree.trace.profile ? () => onSelect({ tab: "profile" }) : undefined;
  return (
    <CallMap
      {...tree}
      under={(under) => (
        <UnderThis counts={underCounts(chain.members, under, chain.chainIssues, chain.setScope, openTab)} />
      )}
      head={<TimeStrip trace={tree.trace} related={tree.related} onSelect={onSelect} />}
      onProfile={onProfile}
      onTraceProfile={tree.onTraceProfile ?? linkedProfiles(tree.links)}
    />
  );
}

/** A call's trace's profile, opened as a linked trace opens, at its Profile tab; none where traces don't open. */
function linkedProfiles(links: TraceLinks | undefined): TraceProfileOpener | undefined {
  return opensTraces(links) ? (id) => openTraceAt(links, id, "profile") : undefined;
}

/** Explore: the ways out of this trace the page itself doesn't show. */
function ExploreMenu({ explore, links }: { explore: readonly ExploreItem[]; links: TraceLinks | undefined }) {
  // In the panel a click on the page doesn't reach the menu: it closes when the frame loses focus.
  const [exploreOpen, setExploreOpen] = useMenuOpen();
  return (
    <DropdownMenu open={exploreOpen} onOpenChange={setExploreOpen}>
      {/* An icon among the header's others (share, theme, dock): its name in the hint. */}
      <Hint title="Explore" detail="This request's endpoint, its issues and the logs around it.">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7.5 shrink-0 text-muted-foreground shadow-none hover:text-foreground"
            aria-label="Explore"
          >
            <CompassIcon />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
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
  );
}

export function TraceView({
  trace,
  explore = [],
  onTabChange,
  onExplain,
  explainIn,
  initialTab,
  preferredTab,
  actions,
  lead,
  related,
  loadRelated,
  loadChain,
  links,
  initialSpan,
  app,
  onTraceProfile,
  variant = "full",
  // The part of the time picked: the lanes and the call tree share it (SliceScope).
  ...held
}: TraceViewProps) {
  const compact = variant === "compact" || variant === "strip";
  const findings = useMemo(() => findingsOf(trace), [trace]);
  const [active, setActive] = useState<TabId>(
    // A tab the link asked for that this trace has not (an error tab without an error) falls back like no tab.
    () =>
      hasTab(trace, initialTab, app)
        ? initialTab
        : trace.errors.length > 0
          ? "error"
          : hasTab(trace, preferredTab, app)
            ? preferredTab
            : "tree",
  );
  const spansNoun = useMemo(() => nounsOf(trace), [trace]);
  const [focus, setFocus] = useState<ReadonlySet<string> | undefined>(undefined);
  // A span to open in the call tree: from the link's `span`, or a log record's "in the call tree".
  const [treeSpan, setTreeSpan] = useState(initialSpan);

  // The trace's chain of calls, and what of it the tabs list: all of it, or what is under a row of the call tree.
  const chain = useTraceScope(trace, related, loadChain);
  const tabbed = useChainTabs(trace, chain, findings);
  const explain = useMemo(() => chainExplain(chain, onExplain, explainIn), [chain, onExplain, explainIn]);

  const status = trace.attrs["http.status_code"];
  const outcome = outcomeOf(trace);
  const tabs = traceTabs({
    trace,
    outcome,
    findings: tabbed.findings,
    calls: tabbed.calls,
    app,
    logs: chain.logs.length,
    profiled: chain.members.some((member) => member.trace.profile !== undefined),
  });
  // A tab the link asked for that only the chain has (the DB tab of a browser's view): opened once the chain came.
  const asked = useAskedTab(initialTab, tabs, setActive);
  const head = heading(trace);
  const path = trace.attrs["http.path"];
  const route = trace.attrs["http.route"];

  // A record's or an issue's row in the call tree.
  const showRow = (row: string) => {
    setTreeSpan(row);
    setActive("tree");
  };
  // A lane or a tile opens the tab with what it drew (the call tree at its span).
  const openAt = (target: MarkTarget) => {
    if (target.tab === "tree") setTreeSpan(target.span);
    openTab(target.tab);
  };
  const panel = (
    <div role="tabpanel" className="dt-tabpanel">
      <RequestPane open={active === "request"} trace={trace} related={related} links={links} panel={compact} />
      <AppPane open={active === "app"} app={app} links={links} />
      <TreePane
        open={active === "tree"}
        onSelect={openAt}
        trace={trace}
        issueBySpan={tabbed.issueBySpan}
        related={related}
        loadRelated={loadRelated}
        links={links}
        initialSpan={treeSpan}
        onExplain={onExplain}
        onTraceProfile={onTraceProfile}
        chain={chain}
        openTab={(tab) => openTab(tab)}
      />
      <IssuesPane
        open={active === "issues"}
        chain={chain}
        findings={findings}
        links={links}
        onShowSpans={(ids) => {
          setFocus(new Set(ids));
          setTreeSpan(ids[0]);
          setActive(tabOfSpans(trace, ids));
        }}
        onShowRow={showRow}
        spansNoun={spansNoun}
      />
      <LogsPane open={active === "logs"} chain={chain} trace={trace} links={links} onShowRow={showRow} />
      <SpanLists
        active={active}
        chain={chain}
        issueBySpan={tabbed.issueBySpan}
        focus={focus}
        onExplain={explain}
        links={links}
      />
      <ProfileTab trace={trace} open={active === "profile"} chain={chain} />
      {active === "error" ? (
        <ErrorView
          errors={trace.errors}
          issues={trace.issues.filter((issue) => issue.kind === "error")}
          links={links}
        />
      ) : null}
    </div>
  );
  const exploreMenu = explore.length > 0 ? <ExploreMenu explore={explore} links={links} /> : null;
  const openTab = (id: TabId) => {
    asked.current = undefined;
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

  const placed = placeExplore(exploreMenu, actions);
  const tabsBar = <Tabs label="Trace details" tabs={tabs} active={active} onChange={openTab} />;

  // In the panel (either dock) the tabs carry the status and timings: one toolbar row, then the content.
  if (compact) {
    return (
      <SliceScope initial={held.initialSlice} onChange={held.onSliceChange}>
        <article className="dt-trace" data-variant="strip">
          <StripHeader lead={lead} tabs={tabsBar} explore={placed.explore} actions={placed.actions} />
          {panel}
        </article>
      </SliceScope>
    );
  }

  return (
    <SliceScope initial={held.initialSlice} onChange={held.onSliceChange}>
      <article className="dt-trace" data-variant={variant}>
        <header className="dt-trace-head">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="dt-trace-title" hidden={compact}>
                <TraceBadge word={head.badge} htmx={htmxOf(trace)} />
                <h2>
                  <HeadingTitle kind={trace.kind} title={head.title} />
                </h2>
                <StatusBadge status={typeof status === "number" ? status : null} />
                <span className="dt-trace-time">{duration(trace.duration)}</span>
                <HeadFacts trace={trace} />
              </div>
              {compact ? null : typeof route === "string" && route !== path ? (
                <p className="dt-trace-route">
                  route <RoutePath path={route} />
                </p>
              ) : null}
            </div>
            {placed.explore}
            {placed.actions ? <div className="flex shrink-0 items-center gap-0.5">{placed.actions}</div> : null}
          </div>
        </header>
        {tabsBar}
        {panel}
      </article>
    </SliceScope>
  );
}
