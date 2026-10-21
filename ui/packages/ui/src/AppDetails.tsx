import { SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Input } from "./components/ui/input";
import { stamp } from "./format";
import { NameValues } from "./NameValues";
import { Empty } from "./primitives";
import type { App } from "./types";

/** Whether the app said anything about itself: an SDK that doesn't (JavaScript, Java today) said neither. */
export function appSaidAnything(app: App | null | undefined): app is App {
  return Boolean(app && (app.settings || app.versions));
}

/** A titled part of the app's details: its name and count above a card, as a request's parts are. */
function Part({
  label,
  count,
  tools,
  children,
}: {
  label: string;
  count?: number;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2" aria-label={label}>
      <div className="flex min-h-7 items-center gap-3">
        <h3 className="flex items-baseline gap-1.5 text-[11px] font-semibold tracking-wider text-foreground/80 uppercase">
          {label}
          {count === undefined ? null : <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
        </h3>
        {tools}
      </div>
      {children}
    </section>
  );
}

/** The settings whose name or value has `filter` in it, case aside. */
function matching(settings: Record<string, string>, filter: string): [string, string][] {
  const wanted = filter.trim().toLowerCase();
  return Object.entries(settings).filter(
    ([name, value]) => !wanted || name.toLowerCase().includes(wanted) || value.toLowerCase().includes(wanted),
  );
}

/** Every setting by name, the filter above them: secrets come masked from the app's SDK, as `********`. */
function Settings({ settings }: { settings: Record<string, string> | null }) {
  const [filter, setFilter] = useState("");
  if (!settings) {
    return (
      <Part label="Settings">
        <p className="rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
          The app doesn't send its settings: its framework has none to send (FastAPI, Falcon), or the capture_settings
          setting is off.
        </p>
      </Part>
    );
  }
  const rows = matching(settings, filter);
  const box = (
    <div className="relative ml-auto w-64 max-w-full">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter settings…"
        aria-label="Filter settings"
        className="h-7 pl-8 text-xs md:text-xs"
      />
    </div>
  );
  return (
    <Part label="Settings" count={Object.keys(settings).length} tools={box}>
      <div className="overflow-hidden rounded-lg border bg-card">
        {rows.length ? (
          <NameValues fold rows={rows.map(([name, value]) => ({ name, value }))} />
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">No setting matches “{filter.trim()}”.</p>
        )}
      </div>
    </Part>
  );
}

/** What the app runs on, then the agent that serves this console. */
function Versions({ app }: { app: App }) {
  const rows = [
    ...(app.versions ?? []).map((each) => ({ name: each.name, value: each.version })),
    { name: "tracepanel-agent", value: app.agent },
  ];
  return (
    <Part label="Versions" count={rows.length}>
      <div className="overflow-hidden rounded-lg border bg-card">
        <NameValues rows={rows} />
      </div>
    </Part>
  );
}

/** When the app said it, and whether it is connected now: an app that stopped still shows what it said last. */
function Told({ app }: { app: App }) {
  if (app.received === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {app.connected ? "Connected" : "Not connected"} · as the app said at {stamp(app.received)}
    </p>
  );
}

/**
 * An app's settings and versions, as it said them in its hello: the panel's App tab and the console's app page show
 * the same. An app that said nothing is said so plainly.
 */
export function AppDetails({ app }: { app: App | null }) {
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
    <div className="grid gap-5">
      <Told app={app} />
      <Settings settings={app.settings} />
      <Versions app={app} />
    </div>
  );
}
