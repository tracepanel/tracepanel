import { type Counts, type DataSource, type KnownValues, LogoMark, type SearchSpec } from "@tracepanel/ui";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@tracepanel/ui/components/ui/dialog";
import { cn } from "@tracepanel/ui/lib/utils";
import { MenuIcon, SearchIcon } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { ClearDialog } from "./ClearDialog";
import { DataPage } from "./DataPage";
import { useSearch } from "./data";
import { EntryRoute } from "./EntryPage";
import { GroupPage } from "./GroupPage";
import { IssuePage } from "./IssuePage";
import { useRowKeys } from "./keyboard";
import { go, isEntry, parse, periodOf, type Route, type Section } from "./routes";
import { SearchPalette } from "./SearchPalette";
import {
  navItems,
  RAIL_WIDTH,
  Sidebar,
  SidebarHandle,
  SidebarToggle,
  useSidebarCollapsed,
  useSidebarWidth,
} from "./Sidebar";
import { scopedSource, useApps, useScope } from "./scope";
import { useScrollMemory } from "./scroll";
import { sectionLabel } from "./sections";
import { TracePage } from "./TracePage";

/** The menu item a page belongs to; a trace belongs to wherever it was opened from. */
function sectionOf(route: Route): Section | null {
  if (route.name === "group") return route.section;
  if (route.name === "issue") return route.error ? "errors" : "issues";
  if (route.name === "trace") return route.from ? sectionOf(parse(route.from)) : null;
  if (route.name === "home") return null;
  return route.name;
}

export function Console({ route, source: everything }: { route: Route; source: DataSource }) {
  // Several apps sending to one agent: the one chosen narrows every page (scope.tsx).
  const { service, setService } = useScope();
  const source = useMemo(() => scopedSource(everything, service), [everything, service]);
  const apps = useApps(everything);
  // The switcher: only where there is a choice.
  const scope = apps && apps.length > 1 ? { apps, service, onService: setService } : undefined;
  // The chosen app gone (the store cleared, another project): back to all of them.
  useEffect(() => {
    if (service && apps && !apps.some((app) => app.service === service)) setService("");
  }, [service, apps, setService]);
  // The address as the browser has it: positions are filed under the same string they are read back by.
  useScrollMemory(location.hash);
  useRowKeys();
  const [spec, setSpec] = useState<SearchSpec | null>(null);
  const [searching, setSearching] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [menu, setMenu] = useState(false);
  // A choice in the menu goes somewhere: the menu closes behind it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closing on every new address is the point.
  useEffect(() => setMenu(false), [location.hash]);
  useEffect(() => {
    source.searchSpec().then(setSpec, () => undefined);
  }, [source]);
  const counts = useSearch(
    useCallback((): Promise<Counts | undefined> => source.counts(), [source]),
    "",
  ).data;
  const known: KnownValues = useSearch(
    useCallback(() => source.knownValues(), [source]),
    "",
    3,
  ).data ?? {
    route: [],
    logger: [],
    db: [],
    targets: {},
    ops: {},
    task: [],
    // biome-ignore lint/style/useNamingConvention: wire format.
    task_system: [],
    queue: [],
    job: [],
    rpc: [],
    page: [],
    in: [],
    // biome-ignore lint/style/useNamingConvention: wire format.
    log_route: [],
    span: [],
    extra: [],
  };

  // The console opens on HTTP: where every Django project's work comes in.
  useEffect(() => {
    if (route.name === "home") go({ name: "endpoints", q: "" }, true);
  }, [route.name]);

  // ⌘K / Ctrl+K: search traces from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  let page = null;
  if (route.name === "trace")
    page = <TracePage id={route.id} from={route.from} tab={route.tab} span={route.span} source={source} />;
  else if (route.name === "issue") {
    page = (
      <main className="min-h-0 min-w-0 overflow-y-auto bg-background" data-scroll="">
        <IssuePage
          key={`${route.fingerprint} ${route.q ?? ""}`}
          fingerprint={route.fingerprint}
          period={periodOf(route.q ?? "")}
          source={source}
        />
      </main>
    );
  } else if (route.name === "group") {
    page = (
      <main className="min-h-0 min-w-0 overflow-y-auto bg-background" data-scroll="">
        <GroupPage
          key={`${route.section} ${route.key} ${route.q ?? ""}`}
          section={route.section}
          groupKey={route.key}
          period={periodOf(route.q ?? "")}
          source={source}
        />
      </main>
    );
  } else if (route.name !== "home" && isEntry(route.name)) {
    page = (
      <EntryRoute
        // The page stays across By … / All …: the overview keeps its charts, only the list below changes.
        key={route.name}
        section={route.name}
        q={route.q}
        view={route.view ?? "overview"}
        source={source}
        spec={spec}
        known={known}
      />
    );
  } else if (route.name !== "home") {
    page = (
      <DataPage
        key={route.name}
        section={route.name}
        q={route.q}
        open={route.open}
        source={source}
        spec={spec}
        known={known}
        systems={counts?.sections.systems}
      />
    );
  }

  const sidebar = useSidebarWidth();
  const { collapsed, collapse, moving } = useSidebarCollapsed();
  const current = sectionOf(route);
  return (
    <div
      className={cn(
        "grid h-full grid-cols-[var(--sidebar-width)_minmax(0,1fr)] max-[980px]:grid-cols-1 max-[980px]:grid-rows-[auto_minmax(0,1fr)]",
        moving && "transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={{ "--sidebar-width": collapsed ? RAIL_WIDTH : `${sidebar.width}px` } as CSSProperties}
    >
      {/* Where the sidebar has no room: a bar with the menu and search, the sidebar in a drawer. */}
      <header className="hidden items-center gap-3 border-b bg-sidebar px-4 py-2.5 max-[980px]:flex">
        <button type="button" className="icon-button" aria-label="Menu" onClick={() => setMenu(true)}>
          <MenuIcon className="size-5" />
        </button>
        <a href="#/" aria-label="Tracepanel home" className="flex items-center">
          <LogoMark className="size-6" />
        </a>
        <span className="truncate font-semibold">{current ? sectionLabel(current) : "Tracepanel"}</span>
        <button type="button" className="icon-button ml-auto" aria-label="Search" onClick={() => setSearching(true)}>
          <SearchIcon className="size-5" />
        </button>
      </header>
      <Dialog open={menu} onOpenChange={setMenu}>
        <DialogContent
          className="top-0 left-0 h-full w-[17.5rem] max-w-[85vw] translate-x-0 translate-y-0 rounded-none border-0 border-r p-0 sm:max-w-[17.5rem]"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Menu</DialogTitle>
          <DialogDescription className="sr-only">The console's sections</DialogDescription>
          <Sidebar
            drawer={true}
            section={current}
            counts={counts}
            onSearch={() => {
              setMenu(false);
              setSearching(true);
            }}
            onClear={source.clearStore ? () => setClearing(true) : undefined}
            scope={scope}
          />
        </DialogContent>
      </Dialog>
      <div className="relative grid min-h-0 max-[980px]:hidden">
        <Sidebar
          section={current}
          counts={counts}
          onSearch={() => setSearching(true)}
          onClear={source.clearStore ? () => setClearing(true) : undefined}
          scope={scope}
          collapsed={collapsed}
        />
        {collapsed ? null : <SidebarHandle {...sidebar} />}
        <SidebarToggle collapsed={collapsed} collapse={collapse} />
      </div>
      {page}
      <SearchPalette open={searching} onOpenChange={setSearching} source={source} items={navItems(counts)} />
      <ClearDialog
        mode="console"
        open={clearing}
        onOpenChange={setClearing}
        // Deleting is for every app: the dialog counts them all.
        source={everything}
        onCleared={() => {
          // Every page shows data that is gone: start over from the home page.
          location.hash = "#/";
          location.reload();
        }}
      />
    </div>
  );
}
