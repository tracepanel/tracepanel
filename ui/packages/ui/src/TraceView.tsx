import {
  ArrowUpRightIcon,
  BugIcon,
  CableIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CompassIcon,
  GlobeIcon,
  ListChecksIcon,
  ListIcon,
  ListTreeIcon,
  MailIcon,
  ScrollTextIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ComponentProps, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CallMap } from "./CallMap";
import { CallsTab, systemCalls, systemOfIssue } from "./CallsTab";
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
import { linkProps, type TraceLinks } from "./links";
import { MailList } from "./MailList";
import { Metrics } from "./Metrics";
import { MethodBadge, RoutePath, StatusBadge } from "./primitives";
import { RequestInfo } from "./RequestInfo";
import type { Explain } from "./SqlList";
import { Tabs } from "./Tabs";
import { Timeline } from "./Timeline";
import type { Issue, IssueKind, Related, Span, Trace } from "./types";

export type TabId = "request" | "tree" | "issues" | "calls" | "logs" | "mail" | "error";

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

function heading(trace: Trace): { badge: string; title: string } {
  const attrs = trace.attrs;
  const operation = attrs["graphql.operation"];
  if (typeof operation === "string") return { badge: "GQL", title: operation };
  if (trace.kind === "task") return { badge: "TASK", title: trace.name };
  if (trace.kind === "command") return { badge: "JOB", title: trace.name };
  if (trace.kind === "websocket") return { badge: "WS", title: trace.name.replace(/^WS /, "") };
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

/** The tabs a trace shows only when it has something for them (issues, an error, mail, HTTP calls). */
const OPTIONAL_TABS: Partial<Record<TabId, (trace: Trace) => boolean>> = {
  issues: (trace) => findingsOf(trace).length > 0,
  error: (trace) => trace.errors.length > 0,
  mail: (trace) => trace.spans.some((span) => span.kind === "mail"),
  calls: (trace) => systemCalls(trace).length > 0,
};

function hasTab(trace: Trace, tab: TabId | undefined): tab is TabId {
  if (tab === undefined) return false;
  return OPTIONAL_TABS[tab]?.(trace) ?? true;
}

/** The tabs that list spans: the calls to each system, emails. */
function SpanLists({ active, mails, calls }: { active: TabId; mails: Span[]; calls: ComponentProps<typeof CallsTab> }) {
  if (active === "calls") return <CallsTab {...calls} />;
  if (active === "mail") return <MailList spans={mails} />;
  return null;
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

/** Where an issue's spans are listed: calls in the Calls tab (on their system), the rest in the call tree. */
function tabOfSpans(trace: Trace, ids: readonly string[]): TabId {
  return systemOfIssue(trace, ids[0]) ? "calls" : "tree";
}

const KIND_ICONS: Record<string, typeof GlobeIcon> = {
  http: GlobeIcon,
  task: ListChecksIcon,
  command: TerminalIcon,
  websocket: CableIcon,
};

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
  // The system the Calls tab shows: the one an issue points at, else the first the request called.
  const [system, setSystem] = useState<string | undefined>(undefined);
  const systems = useMemo(() => systemCalls(trace), [trace]);
  const callCount = systems.reduce((sum, each) => sum + each.spans.length, 0);
  const callTime = systems.reduce((sum, each) => sum + each.total, 0);
  const mails = useMemo(() => trace.spans.filter((span) => span.kind === "mail"), [trace]);
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
  const KindIcon = KIND_ICONS[trace.kind] ?? GlobeIcon;
  const tabs = [
    {
      id: "request" as const,
      label: trace.kind === "task" ? "Task" : trace.kind === "command" ? "Command" : "Request",
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
    // Every call to another system (SQL, Redis, HTTP…), one system at a time; its time goes with it.
    ...tabIfAny(systems, {
      id: "calls" as const,
      label: "Calls",
      icon: <ArrowUpRightIcon />,
      count: callCount,
      detail: callTime > 0 ? duration(callTime) : undefined,
    }),
    { id: "logs" as const, label: "Logs", icon: <ScrollTextIcon />, count: trace.logs.length },
    ...tabIfAny(mails, { id: "mail" as const, label: "Mail", icon: <MailIcon />, count: mails.length }),
  ];
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
            setSystem(systemOfIssue(trace, ids[0]));
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
      <SpanLists
        active={active}
        mails={mails}
        calls={{ systems, system, onSystem: setSystem, issueBySpan, focus, onExplain, links }}
      />
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
