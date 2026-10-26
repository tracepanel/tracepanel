import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { AppWarnings, appWarnings } from "./AppWarnings";
import { Input } from "./components/ui/input";
import { dayTime } from "./format";
import type { TraceLinks } from "./links";
import { NameValues } from "./NameValues";
import { Empty } from "./primitives";
import { Segmented } from "./Segmented";
import type { App } from "./types";

/** Whether the app said anything about itself: an SDK that doesn't (JavaScript, Java today) said nothing. */
export function appSaidAnything(app: App | null | undefined): app is App {
  if (!app) return false;
  return [app.settings, app.versions, app.checks, app.migrations].some(Boolean);
}

/** The settings whose name or value has `filter` in it, case aside. */
function matching(settings: Record<string, string>, filter: string): [string, string][] {
  const wanted = filter.trim().toLowerCase();
  return Object.entries(settings).filter(
    ([name, value]) => !wanted || name.toLowerCase().includes(wanted) || value.toLowerCase().includes(wanted),
  );
}

/** The filter over the settings, beside the switch. */
function SettingsFilter({ filter, onFilter }: { filter: string; onFilter: (filter: string) => void }) {
  return (
    <div className="relative ml-auto w-64 max-w-full">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={filter}
        onChange={(event) => onFilter(event.target.value)}
        placeholder="Filter settings…"
        aria-label="Filter settings"
        className="h-7 pl-8 text-xs md:text-xs"
      />
    </div>
  );
}

/** Every setting by name: secrets come masked from the app's SDK, as `********`. */
function Settings({ settings, filter }: { settings: Record<string, string> | null; filter: string }) {
  if (!settings) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        The app doesn't send its settings: its framework has none to send (FastAPI, Falcon), or the capture_settings
        setting is off.
      </p>
    );
  }
  const rows = matching(settings, filter);
  if (!rows.length)
    return <p className="px-3 py-2 text-xs text-muted-foreground">No setting matches “{filter.trim()}”.</p>;
  return <NameValues rows={rows.map(([name, value]) => ({ name, value }))} />;
}

/** What the app runs on, then the agent that serves this console. */
function versionRows(app: App): { name: string; value: string }[] {
  return [
    ...(app.versions ?? []).map((each) => ({ name: each.name, value: each.version })),
    { name: "tracepanel-agent", value: app.agent },
  ];
}

type Part = "settings" | "versions";

/** The switch's two parts, each with its count: the settings' only when the app sent them. */
function partSegments(app: App, versions: number) {
  return [
    { id: "settings" as const, label: "Settings", count: app.settings ? Object.keys(app.settings).length : undefined },
    { id: "versions" as const, label: "Versions", count: versions },
  ];
}

/** Settings and Versions, one at a time behind a switch, as a request's parts are. */
function Parts({ app }: { app: App }) {
  const [picked, setPicked] = useState<Part>(app.settings ? "settings" : "versions");
  const [filter, setFilter] = useState("");
  const versions = versionRows(app);
  const filtering = picked === "settings" && app.settings !== null;
  return (
    <section className="grid gap-2" aria-label="App details">
      <div className="flex min-h-8 flex-wrap items-center gap-3">
        <Segmented
          label="App details"
          segments={partSegments(app, versions.length)}
          value={picked}
          onChange={setPicked}
        />
        {filtering ? <SettingsFilter filter={filter} onFilter={setFilter} /> : null}
      </div>
      <div className="overflow-hidden rounded-lg border bg-card" role="tabpanel" aria-label={PART_LABEL.get(picked)}>
        <PartBody picked={picked} app={app} filter={filter} versions={versions} />
      </div>
    </section>
  );
}

function PartBody({
  picked,
  app,
  filter,
  versions,
}: {
  picked: Part;
  app: App;
  filter: string;
  versions: { name: string; value: string }[];
}) {
  if (picked === "versions") return <NameValues rows={versions} />;
  return <Settings settings={app.settings} filter={filter} />;
}

const PART_LABEL = new Map<Part, string>([
  ["settings", "Settings"],
  ["versions", "Versions"],
]);

/** When the app said it, and whether it is connected now: an app that stopped still shows what it said last. */
function Told({ app }: { app: App }) {
  if (app.received === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {app.connected ? "Connected" : "Not connected"} · as the app said at {dayTime(app.received)}
    </p>
  );
}

/**
 * An app's settings and versions, as it said them in its hello, and what its checks found wrong with it on top: the
 * panel's App tab and the console's app page show the same. An app that said nothing is said so plainly.
 */
export function AppDetails({ app, links }: { app: App | null; links?: TraceLinks | undefined }) {
  const agent = app?.agent;
  if (!appSaidAnything(app)) {
    return (
      <Empty title="No settings or versions from this app">
        This app's SDK doesn't report its settings and versions yet: the Python SDK does, from Django and Flask.
        {agent ? ` The agent is tracepanel-agent ${agent}.` : ""}
      </Empty>
    );
  }
  return (
    <div className="grid gap-3">
      <Told app={app} />
      <AppWarnings warnings={appWarnings(app)} links={links} />
      <Parts app={app} />
    </div>
  );
}
