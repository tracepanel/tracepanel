import { type Counts, Logo, LogoMark, RuntimeIcon, runtimeKind } from "@tracepanel/ui";
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
import { cn, rem } from "@tracepanel/ui/lib/utils";
import {
  BracesIcon,
  BugIcon,
  CableIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  DatabaseIcon,
  LayersIcon,
  ListChecksIcon,
  type LucideIcon,
  MailIcon,
  MonitorIcon,
  MoonIcon,
  NetworkIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RouteIcon,
  ScrollTextIcon,
  SearchIcon,
  SunIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { Section } from "./routes";
import type { App } from "./scope";
import { type ThemeChoice, useTheme } from "./theme";

interface NavItem {
  section: Section;
  label: string;
  icon: LucideIcon;
}

/**
 * Where work comes in (one entry point per kind of trace), what it touched, and what went wrong. Entry points
 * without stored traces are hidden: a project without Celery has no Tasks.
 */
export const NAV_GROUPS: { title: string | null; items: NavItem[] }[] = [
  {
    title: "Entry points",
    items: [
      { section: "endpoints", label: "HTTP", icon: RouteIcon },
      { section: "graphql", label: "GraphQL", icon: BracesIcon },
      { section: "tasks", label: "Tasks", icon: ListChecksIcon },
      { section: "websockets", label: "WebSockets", icon: CableIcon },
      { section: "jobs", label: "Jobs", icon: TerminalIcon },
    ],
  },
  {
    title: "Data",
    items: [
      { section: "services", label: "Services", icon: NetworkIcon },
      { section: "queries", label: "Database", icon: DatabaseIcon },
      { section: "mails", label: "Emails", icon: MailIcon },
      { section: "logs", label: "Logs", icon: ScrollTextIcon },
      // Last: what all of the above turned up. What failed, then what could be better.
      { section: "errors", label: "Errors", icon: BugIcon },
      { section: "issues", label: "Issues", icon: CircleAlertIcon },
    ],
  },
];

export const NAV: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** Entry points with traces; HTTP always (it is where a project starts). */
export function visibleSections(counts: Counts | undefined): Set<Section> {
  const sections = counts?.sections;
  const hidden = new Set<Section>();
  if (sections) {
    if (!sections.graphql) hidden.add("graphql");
    if (!sections.tasks) hidden.add("tasks");
    if (!sections.websockets) hidden.add("websockets");
    if (!sections.jobs) hidden.add("jobs");
  }
  return new Set(NAV.map((item) => item.section).filter((section) => !hidden.has(section)));
}

export function Sidebar({
  section,
  counts,
  onSearch,
  onClear,
  drawer = false,
  collapsed = false,
  onCollapse,
  scope,
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
  /** Collapse or expand; left out where it can't (the drawer). */
  onCollapse?: ((collapsed: boolean) => void) | undefined;
  /** Several apps in the store: which one the console shows. Left out with one app. */
  scope?: AppScope | undefined;
}) {
  const visible = visibleSections(counts);
  const rail = collapsed && !drawer;
  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-sidebar pt-6 pb-5",
        rail ? "items-center gap-6 px-3" : "gap-7 px-5",
        drawer ? "h-full overflow-y-auto" : "border-r max-[980px]:hidden",
      )}
    >
      <div className={cn("flex items-center", !rail && "justify-between gap-2")}>
        <a href="#/" className={cn("no-underline", !rail && "px-2")} aria-label="Tracepanel home">
          {rail ? <LogoMark /> : <Logo />}
        </a>
        {onCollapse && !rail ? (
          <button
            type="button"
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
            title="Collapse the sidebar · ⌘B"
            aria-label="Collapse the sidebar"
            onClick={() => onCollapse(true)}
          >
            <PanelLeftCloseIcon className="size-[1.125rem]" />
          </button>
        ) : null}
      </div>
      {scope ? <AppSwitcher scope={scope} rail={rail} /> : null}
      {rail ? (
        <RailTip label="Search traces" detail="⌘K">
          <button
            type="button"
            onClick={onSearch}
            aria-label="Search traces"
            className="grid size-11 place-items-center rounded-lg border bg-[var(--dt-field)] text-muted-foreground transition-colors hover:border-[var(--dt-border-strong)] hover:text-foreground"
          >
            <SearchIcon className="size-[1.125rem]" />
          </button>
        </RailTip>
      ) : (
        <button
          type="button"
          onClick={onSearch}
          className="flex items-center gap-2.5 rounded-lg border bg-[var(--dt-field)] px-3 py-2 text-left whitespace-nowrap text-md text-muted-foreground transition-colors hover:border-[var(--dt-border-strong)] hover:text-foreground"
        >
          <SearchIcon className="size-4" />
          Search traces
          <kbd className="ml-auto rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-text-2">⌘K</kbd>
        </button>
      )}
      <nav className={cn("grid", rail ? "justify-items-center gap-4" : "gap-5")}>
        {NAV_GROUPS.map((group, index) => (
          <div key={group.items[0]?.section} className="grid gap-1">
            {rail ? (
              index > 0 ? (
                <span className="mx-auto mb-3 h-px w-6 bg-border" />
              ) : null
            ) : group.title ? (
              <span className="px-3.5 pb-1 text-2xs font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase">
                {group.title}
              </span>
            ) : null}
            {group.items
              .filter((entry) => visible.has(entry.section))
              .map(({ section: item, label, icon: Icon }) => {
                const current = item === section;
                const count = item === "errors" ? counts?.errors : item === "issues" ? counts?.issues : undefined;
                const tone = item === "errors" ? "error" : "warn";
                const link = (
                  <a
                    key={item}
                    href={`#/${item}`}
                    aria-current={current ? "page" : undefined}
                    aria-label={rail ? (count ? `${label}, ${count}` : label) : undefined}
                    className={cn(
                      "relative flex items-center rounded-lg text-lg font-medium whitespace-nowrap text-sidebar-foreground no-underline",
                      rail ? "size-11 justify-center" : "gap-3.5 px-3.5 py-2.5",
                      "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                      current &&
                        "bg-sidebar-accent font-semibold text-sidebar-accent-foreground before:absolute before:inset-y-2 before:-left-2.5 before:w-1 before:rounded-full before:bg-brand",
                    )}
                  >
                    <Icon className={cn("size-5 shrink-0", current && "text-brand")} />
                    {rail ? (
                      count ? (
                        <span
                          className={cn(
                            "absolute -top-1 -right-1.5 min-w-[1.125rem] rounded-full px-1 text-center font-mono text-2xs leading-[1.125rem] font-semibold tabular-nums ring-2 ring-sidebar",
                            tone === "error" ? "bg-error-soft text-error" : "bg-warn-soft text-warn",
                          )}
                        >
                          {count > 99 ? "99+" : count}
                        </span>
                      ) : null
                    ) : (
                      <>
                        {label}
                        {count ? (
                          <span
                            className={cn(
                              "ml-auto min-w-6 rounded-full px-2 text-center font-mono text-xs leading-6 font-semibold tabular-nums",
                              tone === "error" ? "bg-error-soft text-error" : "bg-warn-soft text-warn",
                            )}
                          >
                            {count}
                          </span>
                        ) : null}
                      </>
                    )}
                  </a>
                );
                return rail ? (
                  <RailTip key={item} label={label} detail={count ? String(count) : undefined} tone={tone}>
                    {link}
                  </RailTip>
                ) : (
                  link
                );
              })}
          </div>
        ))}
      </nav>
      {rail ? (
        <footer className="mt-auto flex flex-col items-center gap-1 border-t pt-4">
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
          <ThemeToggle side="right" />
          {onCollapse ? (
            <RailTip label="Expand the sidebar" detail="⌘B">
              <button
                type="button"
                className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                aria-label="Expand the sidebar"
                onClick={() => onCollapse(false)}
              >
                <PanelLeftOpenIcon className="size-[1.125rem]" />
              </button>
            </RailTip>
          ) : null}
        </footer>
      ) : (
        <footer className="mt-auto flex items-center justify-between gap-2 border-t pt-4 pl-2.5 text-sm text-muted-foreground">
          <span>
            Local · stored in <code className="font-mono">.tracepanel/</code>
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
            <ThemeToggle />
          </span>
        </footer>
      )}
    </aside>
  );
}

export interface AppScope {
  apps: App[];
  /** "" is every app. */
  service: string;
  onService: (service: string) => void;
}

/** Which app the console shows: every one, or one of them. A rail shows the chosen app's mark. */
function AppSwitcher({ scope, rail }: { scope: AppScope; rail: boolean }) {
  const chosen = scope.apps.find((app) => app.service === scope.service);
  const mark = (app: App | undefined) => {
    const kind = app?.runtime ? runtimeKind(app.runtime) : null;
    return kind ? <RuntimeIcon kind={kind} /> : <LayersIcon />;
  };
  const label = chosen ? chosen.service : "All apps";
  const trigger = rail ? (
    <button
      type="button"
      aria-label={`App: ${label}`}
      className={cn(
        "grid size-11 place-items-center rounded-lg border text-text-2 hover:border-[var(--dt-border-strong)] hover:text-foreground [&_svg]:size-[1.125rem]",
        chosen && "border-brand/40 bg-brand-soft text-brand",
      )}
    >
      {mark(chosen)}
    </button>
  ) : (
    <button
      type="button"
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-md font-medium transition-colors hover:border-[var(--dt-border-strong)] [&_svg]:size-4",
        chosen && "border-brand/40 bg-brand-soft",
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
        <DropdownMenuRadioGroup value={scope.service} onValueChange={scope.onService}>
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
  { value: "system", label: "Auto", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** One small button that cycles Auto → Light → Dark; `compact` for the panel's toolbar. */
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
      <button
        type="button"
        className="icon-button"
        title={label}
        aria-label={label}
        onClick={() => setTheme(next.value)}
      >
        <Icon className="size-4" />
      </button>
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
    const from = event.clientX;
    const initial = width;
    const move = (moved: PointerEvent) => resize(initial + moved.clientX - from);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
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
      className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[0.1875rem] after:w-0.5 after:bg-transparent after:transition-colors hover:after:bg-brand/50 focus-visible:after:bg-brand"
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
/** The rail: its items (2.75rem) between its sides (0.75rem each), and the border. */
export const RAIL_WIDTH = "calc(4.25rem + 1px)";
/** How long the column takes to open or close. */
const COLLAPSE_MS = 200;

/** Whether the sidebar is a rail of icons: remembered in this browser, ⌘B / Ctrl+B toggles it. */
export function useSidebarCollapsed(): {
  collapsed: boolean;
  collapse: (collapsed: boolean) => void;
  /** True while the column changes width: only then does it animate, not while dragged. */
  moving: boolean;
} {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [moving, setMoving] = useState(false);
  const collapse = (next: boolean) => {
    setMoving(true);
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
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
  }, [collapsed]);
  return { collapsed, collapse, moving };
}
