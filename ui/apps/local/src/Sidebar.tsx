import { type Counts, Hint, Logo, LogoMark, type Otlp, RuntimeIcon, runtimeKind } from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@tracepanel/ui/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tracepanel/ui/components/ui/tooltip";
import { type Family, isAwsSystem, systemOfPage } from "@tracepanel/ui/lib/systems";
import { cn, rem } from "@tracepanel/ui/lib/utils";
import {
  AppWindowIcon,
  ArrowLeftRightIcon,
  ArrowUpRightIcon,
  BracesIcon,
  BugIcon,
  CableIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  CloudIcon,
  DatabaseIcon,
  DatabaseZapIcon,
  HardDriveIcon,
  KeyRoundIcon,
  LayersIcon,
  ListChecksIcon,
  type LucideIcon,
  MailIcon,
  MonitorIcon,
  MoonIcon,
  NetworkIcon,
  RabbitIcon,
  RouteIcon,
  ScaleIcon,
  ScrollTextIcon,
  SearchIcon,
  SendIcon,
  SparklesIcon,
  SunIcon,
  TerminalIcon,
  Trash2Icon,
  UnplugIcon,
  WaypointsIcon,
  ZapIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useScrollFade } from "./fade";
import { callsSection, type Section } from "./routes";
import type { App } from "./scope";
import { type ThemeChoice, useTheme } from "./theme";

export interface NavItem {
  section: Section;
  label: string;
  icon: LucideIcon;
  /** The item it is listed under, shown only while that item or one of its own is open: AWS's services. */
  under?: Section;
}

/**
 * Where work comes in (one entry point per kind of trace), what it touched, and what went wrong. Entry points
 * without stored traces are hidden: a project without a task queue has no Tasks (one whose worker runs, but no task
 * has ended yet, has: its Now).
 */
const NAV_GROUPS: { title: string | null; items: NavItem[] }[] = [
  {
    title: "Entry points",
    // In the order work comes in: the user's pages in the browser, the requests they make, what those start.
    items: [
      { section: "pages", label: "Pages", icon: AppWindowIcon },
      { section: "endpoints", label: "HTTP", icon: RouteIcon },
      { section: "graphql", label: "GraphQL", icon: BracesIcon },
      { section: "tasks", label: "Tasks", icon: ListChecksIcon },
      { section: "websockets", label: "WebSockets", icon: CableIcon },
      { section: "jobs", label: "Jobs", icon: TerminalIcon },
      { section: "rpc", label: "RPC", icon: WaypointsIcon },
    ],
  },
  {
    title: "Data",
    // The map of what the app talks to first, then a page per system it calls (dataItems), logs and emails last.
    items: [
      { section: "services", label: "Services", icon: NetworkIcon },
      // AWS, every service of it on one page, among the calls out (after HTTP calls, before the LLMs).
      { section: "aws", label: "AWS", icon: CloudIcon },
      { section: "logs", label: "Logs", icon: ScrollTextIcon },
      { section: "mails", label: "Emails", icon: MailIcon },
    ],
  },
  {
    // Last, a group of its own: not data but what all of the above turned up. What failed, then what could be better.
    title: "Problems",
    items: [
      { section: "errors", label: "Errors", icon: BugIcon },
      { section: "issues", label: "Issues", icon: CircleAlertIcon },
    ],
  },
];

export const NAV: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** The groups that scroll, and the last, Problems, kept in view below them. */
const LISTED = NAV_GROUPS.slice(0, -1);
const PROBLEMS = NAV_GROUPS[NAV_GROUPS.length - 1] as (typeof NAV_GROUPS)[number];

/** Spans the sidebar's padding, so the current page's mark at the edge isn't cut off. */
const edges = (rail: boolean) => (rail ? "-mx-3 justify-items-center px-3" : "-mx-5 px-5");

/**
 * Only the list scrolls (an app that calls many systems): the logo, search, Problems and footer stay in place.
 * Problems sit right below the list, pinned above the footer once it scrolls: their red and amber counts are never
 * below the fold.
 */
function SidebarNav({ rail, groupProps }: { rail: boolean; groupProps: Omit<NavGroupProps, "group" | "index"> }) {
  const list = useRef<HTMLDivElement>(null);
  const fade = useScrollFade(list);
  return (
    <nav className="flex min-h-0 flex-col gap-3">
      <div
        ref={fade.attach}
        data-nav-list=""
        onScroll={fade.update}
        style={fade.style}
        className={cn(
          "grid min-h-0 shrink content-start gap-3 overflow-y-auto overscroll-contain [scrollbar-width:thin]",
          edges(rail),
        )}
      >
        {LISTED.map((group, index) => (
          <NavGroup key={group.title} group={group} index={index} {...groupProps} />
        ))}
      </div>
      <div className={cn("grid", edges(rail))}>
        <NavGroup group={PROBLEMS} index={LISTED.length} {...groupProps} />
      </div>
    </nav>
  );
}

/** A group of the sidebar: its title, then its items that have something to show. */
interface NavGroupProps {
  group: (typeof NAV_GROUPS)[number];
  index: number;
  section: Section | null;
  counts: Counts | undefined;
  rail: boolean;
  visible: Set<Section>;
}

function NavGroup({ group, index, section, counts, rail, visible }: NavGroupProps) {
  const items = itemsOf(group, counts).filter((entry) => visible.has(entry.section));
  const open = openParent(items, section);
  return (
    <div className="grid gap-0.5">
      <GroupTitle title={group.title} rail={rail} divider={index > 0} />
      {items
        .filter((entry) => !entry.under || entry.under === open)
        .map((entry) => (
          <NavLink
            key={entry.section}
            entry={entry}
            current={entry.section === section}
            counts={counts}
            rail={rail}
            items={visible.size}
          />
        ))}
    </div>
  );
}

/** The item whose own items are shown: the current page, or the one the current page is listed under. */
function openParent(items: readonly NavItem[], section: Section | null): Section | null {
  if (items.some((item) => item.under === section)) return section;
  return items.find((item) => item.section === section)?.under ?? null;
}

/**
 * The sections shown only once there is something in them; HTTP always (it is where a project starts). Emails too:
 * only some frameworks send them through what an SDK records (Django's mail).
 */
const OPTIONAL = ["graphql", "tasks", "websockets", "jobs", "rpc", "pages", "aws", "mails"] as const;

/** What shows a section before it has traces: Tasks, with tasks in flight or an app that sends task events. */
const LIVE: Partial<Record<Section, (counts: Counts) => boolean>> = { tasks: (counts) => counts.live_tasks };

/** Whether a section has something to show: its traces, or (Tasks) what is in flight. */
function hasData(counts: Counts, section: (typeof OPTIONAL)[number]): boolean {
  return Boolean(counts.sections[section]) || LIVE[section]?.(counts) === true;
}

/** Entry points with traces, and a page for each system the app called. */
function visibleSections(counts: Counts | undefined): Set<Section> {
  // Before the counts, the optional sections are hidden too: one shown, then gone, is a flash.
  const hidden = new Set<Section>(OPTIONAL.filter((section) => !(counts && hasData(counts, section))));
  const shown = NAV.map((item) => item.section).filter((section) => !hidden.has(section));
  return new Set([...shown, ...systemItems(counts).map((item) => item.section)]);
}

/**
 * A system's icon, by its family: the database, a key–value store, a cache, a datastore, a broker, RPC, HTTP, file
 * storage, an LLM.
 */
const FAMILY_ICONS: Record<Family, LucideIcon> = {
  sql: DatabaseIcon,
  redis: KeyRoundIcon,
  cache: ZapIcon,
  datastore: DatabaseZapIcon,
  messaging: SendIcon,
  rpc: ArrowLeftRightIcon,
  http: ArrowUpRightIcon,
  storage: HardDriveIcon,
  llm: SparklesIcon,
};

/** A system with an icon of its own, where its family's would make two items alike (Kafka and RabbitMQ). */
const SYSTEM_ICONS: Partial<Record<string, LucideIcon>> = { rabbitmq: RabbitIcon };

/** The systems whose calls a page of their own lists: AWS's API calls are on the AWS page. */
const ON_THEIR_OWN_PAGE: ReadonlySet<string> = new Set(["aws-api"]);

/** A system item, with its family: where in the Data group it goes. */
interface SystemItem extends NavItem {
  family: Family;
}

/**
 * A Data item for each system the store has operations of, in the agent's order (families, then names). An AWS
 * service's (DynamoDB, Amazon SQS) is listed under AWS while the AWS page is shown: that page lists its calls too and
 * leads on to its own.
 */
function systemItems(counts: Counts | undefined): SystemItem[] {
  const systems = (counts?.sections.systems ?? []).filter(({ system }) => !ON_THEIR_OWN_PAGE.has(system));
  const folded = counts !== undefined && hasData(counts, "aws");
  return systems.map(({ system, family, label }) => {
    const name = systemOfPage(system, family, label).label;
    const item = { section: callsSection(system), label: name, icon: SYSTEM_ICONS[system] ?? FAMILY_ICONS[family] };
    return folded && isAwsSystem(system, name) ? { ...item, family, under: "aws" as const } : { ...item, family };
  });
}

/** Every page the console lists, in the sidebar's order: the search palette's "Go to". */
export function navItems(counts: Counts | undefined): NavItem[] {
  const visible = visibleSections(counts);
  return NAV_GROUPS.flatMap((group) => itemsOf(group, counts)).filter((item) => visible.has(item.section));
}

/** A group's items, the Data group's with the systems the app calls in them (dataItems). */
function itemsOf(group: (typeof NAV_GROUPS)[number], counts: Counts | undefined): NavItem[] {
  return group.title === "Data" ? dataItems(group.items, counts) : group.items;
}

/** The systems listed after AWS, in this order: the calls out to LLMs, then file storage. */
const AFTER_AWS: readonly Family[] = ["llm", "storage"];

/**
 * The Data group: the services map; the databases and caches, the brokers; the calls out (RPC, HTTP, AWS with its
 * services under it, LLMs); file storage; then logs and emails.
 */
function dataItems(items: readonly NavItem[], counts: Counts | undefined): NavItem[] {
  const systems = systemItems(counts);
  const own = (section: Section) => items.filter((item) => item.section === section);
  const top = systems.filter((item) => !item.under);
  return [
    ...own("services"),
    ...top.filter((item) => !AFTER_AWS.includes(item.family)),
    ...own("aws"),
    ...systems.filter((item) => item.under === "aws"),
    ...AFTER_AWS.flatMap((family) => top.filter((item) => item.family === family)),
    ...items.filter((item) => item.section !== "services" && item.section !== "aws"),
  ];
}

export function Sidebar({
  section,
  counts,
  onSearch,
  onClear,
  drawer = false,
  collapsed = false,
  scope,
  otlp,
}: {
  section: Section | null;
  /** Issues (the badge turns red with errors) and traces per entry point (empty ones are hidden). */
  counts: Counts | undefined;
  onSearch: () => void;
  /** Deletes the stored data; left out where the source can't clear its store. */
  onClear?: (() => void) | undefined;
  /** In the narrow screen's menu, which shows it where the column is hidden. */
  drawer?: boolean;
  /** A rail of icons, each named on hover; the drawer is never one. */
  collapsed?: boolean;
  /** Several apps in the store: which one the console shows. Left out with one app. */
  scope?: AppScope | undefined;
  /** Where the agent takes OTLP, or why it doesn't; left out with OTLP off or by a backend that is no agent. */
  otlp?: Otlp | undefined;
}) {
  const visible = visibleSections(counts);
  const rail = collapsed && !drawer;
  const groupProps = { section, counts, rail, visible };
  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-sidebar pt-6 pb-5",
        // The same gaps open and as a rail: toggling moves things sideways only, never up or down.
        rail ? "items-center gap-5 px-3" : "gap-5 px-5",
        drawer ? "h-full overflow-y-auto" : "border-r max-[980px]:hidden",
      )}
    >
      <SidebarHead rail={rail} />
      {scope ? <AppSwitcher scope={scope} rail={rail} /> : null}
      <SearchButton rail={rail} onSearch={onSearch} />
      <SidebarNav rail={rail} groupProps={groupProps} />
      <SidebarFooter rail={rail} onClear={onClear} otlp={otlp} />
    </aside>
  );
}

/** The logo: the mark as a rail. Collapsing is the toggle on the sidebar's edge (SidebarToggle). */
function SidebarHead({ rail }: { rail: boolean }) {
  return (
    <div className="flex h-8 items-center">
      <a href="#/" className={cn("no-underline", !rail && "px-2")} aria-label="Tracepanel home">
        {rail ? <LogoMark /> : <Logo />}
      </a>
    </div>
  );
}

/**
 * Collapse and expand: a round button on the sidebar's right edge, level with the logo. Always shown and in the same
 * place in both states, outside the sidebar's rows, so toggling moves nothing up or down.
 */
export function SidebarToggle({ collapsed, collapse }: { collapsed: boolean; collapse: (collapsed: boolean) => void }) {
  const label = collapsed ? "Expand the sidebar" : "Collapse the sidebar";
  const Icon = collapsed ? ChevronRightIcon : ChevronLeftIcon;
  return (
    <RailTip label={label} detail="⌘B">
      <button
        type="button"
        aria-label={label}
        aria-expanded={!collapsed}
        onClick={() => collapse(!collapsed)}
        className="absolute top-7 -right-3 z-20 grid size-6 place-items-center rounded-full border bg-sidebar text-muted-foreground shadow-sm transition-colors hover:border-[var(--dt-border-strong)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Icon className="size-3.5" />
      </button>
    </RailTip>
  );
}

/** Opens search: the field open, its icon as a rail, the same height in both. */
function SearchButton({ rail, onSearch }: { rail: boolean; onSearch: () => void }) {
  if (rail) {
    return (
      <RailTip label="Search traces" detail="⌘K">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search traces"
          className="grid size-10 place-items-center rounded-lg border bg-[var(--dt-field)] text-muted-foreground transition-colors hover:border-[var(--dt-border-strong)] hover:text-foreground"
        >
          <SearchIcon className="size-[1.125rem]" />
        </button>
      </RailTip>
    );
  }
  return (
    <button
      type="button"
      onClick={onSearch}
      className="flex h-10 items-center gap-2.5 rounded-lg border bg-[var(--dt-field)] px-3 text-left whitespace-nowrap text-md text-muted-foreground transition-colors hover:border-[var(--dt-border-strong)] hover:text-foreground"
    >
      <SearchIcon className="size-4" />
      Search traces
      <kbd className="ml-auto rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-text-2">⌘K</kbd>
    </button>
  );
}

const TITLE_ROW =
  "h-5 px-3.5 pb-1 text-2xs leading-4 font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase";

/** A group's title; as a rail its row stays, with a short line between groups, so the items keep their height. */
function GroupTitle({ title, rail, divider }: { title: string | null; rail: boolean; divider: boolean }) {
  if (!title) return null;
  if (!rail) return <span className={TITLE_ROW}>{title}</span>;
  return (
    <span className="relative h-5 w-full" aria-hidden>
      {divider ? <span className="absolute inset-x-0 top-2 mx-auto h-px w-6 bg-border" /> : null}
    </span>
  );
}

/** Errors and issues carry a count: red for errors, amber for issues. */
const NAV_COUNTS: Partial<Record<Section, "errors" | "issues">> = { errors: "errors", issues: "issues" };

function navCount(section: Section, counts: Counts | undefined): number | undefined {
  const key = NAV_COUNTS[section];
  return key && counts?.[key];
}

const COUNT_TONE = { error: "bg-error-soft text-error", warn: "bg-warn-soft text-warn" } as const;

function toneOf(section: Section): "error" | "warn" {
  return section === "errors" ? "error" : "warn";
}

function navClass(rail: boolean, current: boolean): string {
  return cn(
    "relative flex items-center rounded-lg font-medium whitespace-nowrap text-sidebar-foreground no-underline",
    // 15px names in 34px rows, in both themes (the group titles stay small); as a rail the same rows: toggling moves
    // nothing up or down.
    rail ? "size-[2.125rem] justify-center" : "h-[2.125rem] gap-3 px-3.5 text-[1rem]",
    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
    current &&
      "bg-sidebar-accent font-semibold text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:-left-2.5 before:w-1 before:rounded-full before:bg-brand",
    // On the white sidebar the current page is a grey row, no raised card.
    current && "light:bg-[rgb(9_9_11/0.05)]",
  );
}

interface NavLinkProps {
  entry: NavItem;
  current: boolean;
  counts: Counts | undefined;
  /** How many items the list has: one more above the current page's may push it out of view. */
  items: number;
}

function NavLink({ rail, ...props }: NavLinkProps & { rail: boolean }) {
  return rail ? <RailNavLink {...props} /> : <OpenNavLink {...props} />;
}

/** The current page's item scrolled into the list's view, clear of its fades, when the list is longer than the column. */
function useShownWhenCurrent(current: boolean, items: number) {
  const ref = useRef<HTMLAnchorElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new item above moves the current one: look again.
  useEffect(() => {
    const item = ref.current;
    const list = item?.closest<HTMLElement>("[data-nav-list]");
    if (!(current && item && list)) return;
    const reveal = () => {
      const room = 40;
      const box = item.getBoundingClientRect();
      const view = list.getBoundingClientRect();
      if (box.bottom > view.bottom - room) list.scrollTop += box.bottom - view.bottom + room;
      else if (box.top < view.top + room) list.scrollTop -= view.top + room - box.top;
    };
    reveal();
    // The list gets shorter as what is above it loads (the app switcher), or the window does: look again then.
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [current, items]);
  return ref;
}

/** As a rail: the icon, its count on the corner, the name in a tooltip. */
function RailNavLink({ entry: { section, label, icon: Icon }, current, counts, items }: NavLinkProps) {
  const count = navCount(section, counts);
  const ref = useShownWhenCurrent(current, items);
  return (
    <RailTip label={label} detail={count ? String(count) : undefined} tone={toneOf(section)}>
      <a
        ref={ref}
        href={`#/${section}`}
        aria-current={current ? "page" : undefined}
        aria-label={[label, count].filter(Boolean).join(", ")}
        className={navClass(true, current)}
      >
        <Icon className={cn("size-5 shrink-0", current && "text-brand")} />
        <RailCount count={count} tone={toneOf(section)} />
      </a>
    </RailTip>
  );
}

function OpenNavLink({ entry, current, counts, items }: NavLinkProps) {
  const { section, label, icon: Icon } = entry;
  const ref = useShownWhenCurrent(current, items);
  const nested = openNested(entry, current);
  return (
    <a ref={ref} href={`#/${section}`} aria-current={current ? "page" : undefined} className={nested.row}>
      <Icon className={nested.icon} />
      <OpenCount label={label} count={navCount(section, counts)} tone={toneOf(section)} />
    </a>
  );
}

/** An open item's row and icon: one under another starts below its name, indented, its icon smaller. */
function openNested({ under }: NavItem, current: boolean): { row: string; icon: string } {
  const mark = current && "text-brand";
  if (!under) return { row: navClass(false, current), icon: cn("size-[1.125rem] shrink-0", mark) };
  return { row: cn(navClass(false, current), "pl-[2.375rem]"), icon: cn("size-4 shrink-0", mark) };
}

/** As a rail: the count as a badge on the icon's corner. */
function RailCount({ count, tone }: { count: number | undefined; tone: "error" | "warn" }) {
  if (!count) return null;
  return (
    <span
      className={cn(
        "absolute -top-1 -right-1.5 min-w-[1.125rem] rounded-full px-1 text-center font-mono text-2xs leading-[1.125rem] font-semibold tabular-nums ring-2 ring-sidebar",
        COUNT_TONE[tone],
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Open: the label, and the count at the end of the row. */
function OpenCount({ label, count, tone }: { label: string; count: number | undefined; tone: "error" | "warn" }) {
  return (
    <>
      {label}
      {count ? (
        <span
          className={cn(
            "ml-auto min-w-6 rounded-full px-2 text-center font-mono text-xs leading-6 font-semibold tabular-nums",
            COUNT_TONE[tone],
          )}
        >
          {count}
        </span>
      ) : null}
    </>
  );
}

function SidebarFooter({
  rail,
  onClear,
  otlp,
}: {
  rail: boolean;
  onClear?: (() => void) | undefined;
  otlp?: Otlp | undefined;
}) {
  const missed = otlp && !otlp.serving ? otlp : undefined;
  if (rail) {
    return (
      <footer className="mt-auto flex flex-col items-center gap-1 border-t pt-4">
        {missed ? (
          <RailTip label={`No OTLP: ${missed.address} ${missed.taken ? "is taken" : "isn't served"}`}>
            <span className="grid size-9 place-items-center text-warn" role="img" aria-label="No OTLP">
              <UnplugIcon className="size-4" />
            </span>
          </RailTip>
        ) : null}
        {onClear ? (
          <RailTip label="Delete all data">
            <button
              type="button"
              className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-error"
              aria-label="Delete all data"
              onClick={onClear}
            >
              <Trash2Icon className="size-4" />
            </button>
          </RailTip>
        ) : null}
        <LicensesLink rail={true} />
        <ThemeToggle side="right" />
      </footer>
    );
  }
  return (
    <footer className="mt-auto flex flex-col gap-2 border-t pt-4 pl-3.5 text-xs text-muted-foreground">
      {missed ? <OtlpNotice otlp={missed} /> : null}
      {/* Its text starts where the items' icons do, on one line: the full sentence on hover. */}
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate" title="Local: the data is stored in .tracepanel/">
          Local · <code className="font-mono">.tracepanel/</code>
        </span>
        <span className="flex items-center gap-1">
          {onClear ? (
            <button
              type="button"
              className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-error"
              title="Delete all data"
              aria-label="Delete all data"
              onClick={onClear}
            >
              <Trash2Icon className="size-4" />
            </button>
          ) : null}
          <LicensesLink rail={false} />
          <ThemeToggle />
        </span>
      </div>
      {otlp?.serving ? (
        <p
          className="min-w-0 truncate"
          title={`OpenTelemetry exporters send their spans here: OTEL_EXPORTER_OTLP_ENDPOINT=http://${otlp.address}`}
        >
          OTLP · <code className="font-mono">{otlp.address}</code>
        </p>
      ) : null}
    </footer>
  );
}

/**
 * The agent takes no OTLP: another project's agent (or another program) holds the port it wanted. Calm: the SDKs'
 * traces still come, only this project's OpenTelemetry exporters need an address of its own.
 */
function OtlpNotice({ otlp }: { otlp: Otlp }) {
  const by = otlp.taken_by ? `the agent of ${otlp.taken_by}` : "another program";
  return (
    <div role="note" aria-label="OTLP" className="flex gap-2 rounded-md border bg-muted/40 p-2.5 leading-relaxed">
      <UnplugIcon className="mt-1 size-3.5 shrink-0 text-warn" aria-hidden={true} />
      {otlp.taken ? (
        <p className="min-w-0 break-words">
          OTLP: <code className="font-mono text-foreground">{otlp.address}</code> is taken by {by}. Set{" "}
          {/* Where it doesn't fit on the line, broken after the = only. */}
          <code className="font-mono text-foreground select-all">
            <span className="whitespace-nowrap">TRACEPANEL_OTLP=</span>
            <wbr />
            <span className="whitespace-nowrap">{otlp.free ?? "HOST:PORT"}</span>
          </code>{" "}
          for this project's apps and point its OTLP exporters there.
        </p>
      ) : (
        <p className="min-w-0 break-words">
          OTLP: not served on <code className="font-mono text-foreground">{otlp.address}</code>
          {otlp.error ? `: ${otlp.error}` : ""}.
        </p>
      )}
    </div>
  );
}

/**
 * The agent's license and the notices of everything it is built from, as `tracepanel-agent licenses` prints them: the
 * agent's text, in a tab of its own. Relative, so it is the API of wherever the console is served (an app's
 * /__tracepanel__/ too).
 */
function LicensesLink({ rail }: { rail: boolean }) {
  const link = (
    <a
      href="api/licenses"
      target="_blank"
      rel="noopener"
      aria-label="Licenses"
      title={rail ? undefined : "Licenses"}
      className={cn(
        "grid place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
        rail ? "size-9" : "size-8",
      )}
    >
      <ScaleIcon className="size-4" />
    </a>
  );
  return rail ? <RailTip label="Licenses">{link}</RailTip> : link;
}

export interface AppScope {
  apps: App[];
  /** "" is every app. */
  service: string;
  onService: (service: string) => void;
  /** The app being switched to, while its counts load: the switcher says it is busy, the console stays as it is. */
  pending?: string | null | undefined;
}

/** Switching: dimmed only if it takes a while (the delay), so a quick switch shows nothing in between. */
function switchingClass(busy: boolean): string {
  return cn("transition-opacity motion-reduce:transition-none", busy && "cursor-progress opacity-60 delay-300");
}

/** Which app the console shows: every one, or one of them. A rail shows the chosen app's mark. */
function AppSwitcher({ scope, rail }: { scope: AppScope; rail: boolean }) {
  const chosen = scope.apps.find((app) => app.service === scope.service);
  const mark = (app: App | undefined) => {
    const kind = app?.runtime ? runtimeKind(app.runtime) : null;
    return kind ? <RuntimeIcon kind={kind} /> : <LayersIcon />;
  };
  const label = chosen ? chosen.service : "All apps";
  const busy = scope.pending != null;
  const switching = switchingClass(busy);
  const trigger = rail ? (
    <button
      type="button"
      aria-label={`App: ${label}`}
      aria-busy={busy}
      className={cn(
        "grid size-11 place-items-center rounded-lg border text-text-2 hover:border-[var(--dt-border-strong)] hover:text-foreground [&_svg]:size-[1.125rem]",
        chosen && "border-brand/40 bg-brand-soft text-brand",
        switching,
      )}
    >
      {mark(chosen)}
    </button>
  ) : (
    <button
      type="button"
      aria-busy={busy}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-md font-medium transition-colors hover:border-[var(--dt-border-strong)] [&_svg]:size-4",
        chosen && "border-brand/40 bg-brand-soft",
        switching,
      )}
    >
      <span className={cn("text-text-2", chosen && "text-brand")}>{mark(chosen)}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronsUpDownIcon className="text-muted-foreground" />
    </button>
  );
  return (
    <DropdownMenu>
      {rail ? (
        <RailTip label={`App: ${label}`}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </RailTip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="start" side={rail ? "right" : "bottom"} className="w-60">
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={scope.pending ?? scope.service} onValueChange={scope.onService}>
          <DropdownMenuRadioItem value="" className="gap-2">
            <LayersIcon className="text-muted-foreground" />
            All apps
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {scope.apps.map((app) => (
            <DropdownMenuRadioItem key={app.service} value={app.service} className="gap-2">
              <span className="text-muted-foreground">{mark(app)}</span>
              <span className="truncate">{app.service}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The rail's names: beside the icon at once, with a count or a shortcut. */
function RailTip({
  label,
  detail,
  tone,
  children,
}: {
  label: string;
  detail?: string | undefined;
  tone?: "error" | "warn";
  children: ReactNode;
}) {
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={12}
        arrow={false}
        className="flex items-center gap-2 rounded-lg border bg-popover px-3 py-1.5 text-sm font-medium text-popover-foreground shadow-[var(--dt-popover-shadow)]"
      >
        {label}
        {detail ? (
          <span
            className={cn(
              "rounded-md px-1.5 font-mono text-2xs leading-5 tabular-nums",
              tone === "error"
                ? "bg-error-soft text-error"
                : tone === "warn"
                  ? "bg-warn-soft text-warn"
                  : "bg-muted text-text-2",
            )}
          >
            {detail}
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "system", label: "Auto", icon: MonitorIcon },
];

/** One small button that cycles Dark (the default) → Light → Auto; `compact` for the panel's toolbar. */
export function ThemeToggle({ compact = false, side = "top" }: { compact?: boolean; side?: "top" | "right" }) {
  const [theme, setTheme] = useTheme();
  const index = Math.max(
    THEMES.findIndex((item) => item.value === theme),
    0,
  );
  const current = THEMES[index];
  const next = THEMES[(index + 1) % THEMES.length];
  if (!(current && next)) return null;
  const Icon = current.icon;
  const label = `Theme: ${current.label} · click for ${next.label}`;
  if (compact) {
    return (
      <Hint title={`Theme: ${current.label}`} detail={`Click for ${next.label}.`}>
        <button type="button" className="icon-button" aria-label={label} onClick={() => setTheme(next.value)}>
          <Icon className="size-4" />
        </button>
      </Hint>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          className="size-9 shadow-none"
          aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
          onClick={() => setTheme(next.value)}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        Theme: {current.label} · click for {next.label}
      </TooltipContent>
    </Tooltip>
  );
}

const WIDTH_KEY = "tracepanel:sidebar-width";
// In rem, so the defaults follow the density; a dragged width is the reader's, in pixels.
const DEFAULT_WIDTH = () => Math.round(rem(18.5));
const MIN_WIDTH = () => Math.round(rem(13.75));
const MAX_WIDTH = () => Math.round(rem(27.5));

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH(), Math.max(MIN_WIDTH(), Math.round(width)));
}

/** The sidebar's width, dragged by its edge and remembered in this browser. */
export function useSidebarWidth(): { width: number; resize: (width: number) => void } {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      return saved ? clampWidth(saved) : DEFAULT_WIDTH();
    } catch {
      return DEFAULT_WIDTH();
    }
  });
  const resize = (next: number) => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {
      // Blocked storage: the width lasts until reload.
    }
  };
  return { width, resize };
}

/** The sidebar's right edge: drag to resize, arrow keys for steps, double-click for the default width. */
export function SidebarHandle({ width, resize }: { width: number; resize: (width: number) => void }) {
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const from = event.clientX;
    const initial = width;
    const move = (moved: PointerEvent) => resize(initial + moved.clientX - from);
    const stop = () => {
      delete handle.dataset["dragging"];
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    handle.dataset["dragging"] = "";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a window splitter has no native element; role="separator" is the pattern.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuemin={MIN_WIDTH()}
      aria-valuemax={MAX_WIDTH()}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      // 10px to grab, centred on the sidebar's 1px border; what shows is that border, a step stronger in hand.
      className="absolute top-0 -right-[5px] z-10 h-full w-2.5 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[4px] after:w-px after:bg-transparent after:transition-colors motion-reduce:after:transition-none hover:after:bg-(--dt-divider-active) focus-visible:after:bg-(--dt-divider-active) data-dragging:after:bg-(--dt-divider-active)"
      onPointerDown={start}
      onDoubleClick={() => resize(DEFAULT_WIDTH())}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") resize(width - 16);
        if (event.key === "ArrowRight") resize(width + 16);
      }}
    />
  );
}

const COLLAPSED_KEY = "tracepanel:sidebar-collapsed";
/** Below this window width the sidebar is a rail until the reader opens it: its column would take the lists' room. */
const NARROW = "(max-width: 1279.98px)";
/** The reader's choice in a narrow window, kept apart from the wide one's: each width remembers its own. */
const NARROW_KEY = "tracepanel:sidebar-collapsed-narrow";
/** The rail: its items (2.75rem) between its sides (0.75rem each), and the border. */
export const RAIL_WIDTH = "calc(4.25rem + 1px)";
/** How long the column takes to open or close. */
const COLLAPSE_MS = 200;

/** Whether the window matches `query`, kept current as it resizes. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setMatches(list.matches);
    change();
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return matches;
}

/** The choice stored under `key`: collapsed, open, or none made yet. */
function storedChoice(key: string): boolean | undefined {
  try {
    const value = localStorage.getItem(key);
    return value === null ? undefined : value === "1";
  } catch {
    return undefined;
  }
}

/**
 * Whether the sidebar is a rail of icons: open in a wide window and a rail in a narrow one until the reader says
 * otherwise, each choice remembered in this browser; ⌘B / Ctrl+B toggles it.
 */
export function useSidebarCollapsed(): {
  collapsed: boolean;
  collapse: (collapsed: boolean) => void;
  /** True while the column changes width: only then does it animate, not while dragged. */
  moving: boolean;
} {
  const narrow = useMedia(NARROW);
  const key = narrow ? NARROW_KEY : COLLAPSED_KEY;
  const [choices, setChoices] = useState(() => ({
    [COLLAPSED_KEY]: storedChoice(COLLAPSED_KEY),
    [NARROW_KEY]: storedChoice(NARROW_KEY),
  }));
  const collapsed = choices[key] ?? narrow;
  const [moving, setMoving] = useState(false);
  const collapse = (next: boolean) => {
    setMoving(true);
    setChoices((current) => ({ ...current, [key]: next }));
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Blocked storage: the choice lasts until reload.
    }
  };
  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(() => setMoving(false), COLLAPSE_MS + 50);
    return () => clearTimeout(timer);
  }, [moving]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: collapse reads only the state it is given.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        collapse(!collapsed);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, key]);
  return { collapsed, collapse, moving };
}
