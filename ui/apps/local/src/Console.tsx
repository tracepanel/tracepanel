import type { Counts, DataSource, KnownValues, SearchSpec } from "@tracepanel/ui";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { ClearDialog } from "./ClearDialog";
import { DataPage } from "./DataPage";
import { useSearch } from "./data";
import { EntryPage } from "./EntryPage";
import { GroupPage } from "./GroupPage";
import { IssuePage } from "./IssuePage";
import { go, isEntry, parse, periodOf, type Route, type Section } from "./routes";
import { SearchPalette } from "./SearchPalette";
import { Sidebar, SidebarHandle, useSidebarWidth, visibleSections } from "./Sidebar";
import { TracePage } from "./TracePage";

/** The menu item a page belongs to; a trace belongs to wherever it was opened from. */
function sectionOf(route: Route): Section | null {
  if (route.name === "group") return route.section;
  if (route.name === "issue") return route.error ? "errors" : "issues";
  if (route.name === "trace") return route.from ? sectionOf(parse(route.from)) : null;
  if (route.name === "home") return null;
  return route.name;
}

export function Console({ route, source }: { route: Route; source: DataSource }) {
  const [spec, setSpec] = useState<SearchSpec | null>(null);
  const [searching, setSearching] = useState(false);
  const [clearing, setClearing] = useState(false);
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
  ).data ?? { route: [], logger: [], db: [], task: [], queue: [], extra: [] };

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
  if (route.name === "trace") page = <TracePage id={route.id} from={route.from} tab={route.tab} source={source} />;
  else if (route.name === "issue") {
    page = (
      <main className="min-h-0 min-w-0 overflow-y-auto bg-background">
        <IssuePage fingerprint={route.fingerprint} source={source} />
      </main>
    );
  } else if (route.name === "group") {
    page = (
      <main className="min-h-0 min-w-0 overflow-y-auto bg-background">
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
      <EntryPage
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
    page = <DataPage key={route.name} section={route.name} q={route.q} source={source} spec={spec} known={known} />;
  }

  const sidebar = useSidebarWidth();
  return (
    <div
      className="grid h-full grid-cols-[var(--sidebar)_minmax(0,1fr)] max-[980px]:grid-cols-1"
      style={{ "--sidebar": `${sidebar.width}px` } as CSSProperties}
    >
      <div className="relative grid min-h-0 max-[980px]:hidden">
        <Sidebar
          section={sectionOf(route)}
          counts={counts}
          onSearch={() => setSearching(true)}
          onClear={source.clearStore ? () => setClearing(true) : undefined}
        />
        <SidebarHandle {...sidebar} />
      </div>
      {page}
      <SearchPalette open={searching} onOpenChange={setSearching} source={source} sections={visibleSections(counts)} />
      <ClearDialog
        mode="console"
        open={clearing}
        onOpenChange={setClearing}
        source={source}
        onCleared={() => {
          // Every page shows data that is gone: start over from the home page.
          location.hash = "#/";
          location.reload();
        }}
      />
    </div>
  );
}
