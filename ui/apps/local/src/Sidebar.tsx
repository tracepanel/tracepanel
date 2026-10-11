import { type Counts, Logo } from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tracepanel/ui/components/ui/tooltip";
import { cn } from "@tracepanel/ui/lib/utils";
import {
  BracesIcon,
  BugIcon,
  CableIcon,
  CircleAlertIcon,
  DatabaseIcon,
  ListChecksIcon,
  type LucideIcon,
  MailIcon,
  MonitorIcon,
  MoonIcon,
  NetworkIcon,
  RouteIcon,
  ScrollTextIcon,
  SearchIcon,
  SunIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import type { Section } from "./routes";
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
}: {
  section: Section | null;
  /** Issues (the badge turns red with errors) and traces per entry point (empty ones are hidden). */
  counts: Counts | undefined;
  onSearch: () => void;
  /** Deletes the stored data; left out where the source can't clear its store. */
  onClear?: (() => void) | undefined;
  /** In the narrow screen's menu, which shows it where the column is hidden. */
  drawer?: boolean;
}) {
  const visible = visibleSections(counts);
  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col gap-7 bg-sidebar px-5 pt-6 pb-5",
        drawer ? "h-full overflow-y-auto" : "border-r max-[980px]:hidden",
      )}
    >
      <a href="#/" className="px-2 no-underline" aria-label="Tracepanel home">
        <Logo />
      </a>
      <button
        type="button"
        onClick={onSearch}
        className="flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2 text-left text-[15px] text-muted-foreground hover:bg-accent"
      >
        <SearchIcon className="size-4" />
        Search traces
        <kbd className="ml-auto rounded border px-1.5 font-mono text-[12px]">⌘K</kbd>
      </button>
      <nav className="grid gap-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.items[0]?.section} className="grid gap-1">
            {group.title ? (
              <span className="px-3.5 pb-1 text-[12px] font-semibold tracking-wider text-muted-foreground uppercase">
                {group.title}
              </span>
            ) : null}
            {group.items
              .filter((entry) => visible.has(entry.section))
              .map(({ section: item, label, icon: Icon }) => {
                const current = item === section;
                const count = item === "errors" ? counts?.errors : item === "issues" ? counts?.issues : undefined;
                return (
                  <a
                    key={item}
                    href={`#/${item}`}
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "relative flex items-center gap-3.5 rounded-lg px-3.5 py-2.5 text-[17px] font-medium text-sidebar-foreground no-underline",
                      "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                      current &&
                        "bg-sidebar-accent font-semibold text-sidebar-accent-foreground before:absolute before:inset-y-2 before:-left-2.5 before:w-1 before:rounded-full before:bg-brand",
                    )}
                  >
                    <Icon className={cn("size-5 shrink-0", current && "text-brand")} />
                    {label}
                    {count ? (
                      <span
                        className={cn(
                          "ml-auto min-w-6 rounded-full px-2 text-center text-[13px] leading-6 font-semibold tabular-nums",
                          item === "errors" ? "bg-error text-white" : "bg-warn-soft text-warn",
                        )}
                      >
                        {count}
                      </span>
                    ) : null}
                  </a>
                );
              })}
          </div>
        ))}
      </nav>
      <footer className="mt-auto flex items-center justify-between gap-2 border-t pt-4 pl-2.5 text-[13.5px] text-muted-foreground">
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
    </aside>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "Auto", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** One small button that cycles Auto → Light → Dark; `compact` for the panel's toolbar. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
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
      <TooltipContent side="top">
        Theme: {current.label} · click for {next.label}
      </TooltipContent>
    </Tooltip>
  );
}

const WIDTH_KEY = "tracepanel:sidebar-width";
const DEFAULT_WIDTH = 296;
const MIN_WIDTH = 220;
const MAX_WIDTH = 440;

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

/** The sidebar's width, dragged by its edge and remembered in this browser. */
export function useSidebarWidth(): { width: number; resize: (width: number) => void } {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      return saved ? clampWidth(saved) : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
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
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-transparent after:transition-colors hover:after:bg-brand/50 focus-visible:after:bg-brand"
      onPointerDown={start}
      onDoubleClick={() => resize(DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") resize(width - 16);
        if (event.key === "ArrowRight") resize(width + 16);
      }}
    />
  );
}
