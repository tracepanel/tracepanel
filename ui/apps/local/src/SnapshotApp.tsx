import { Empty, type Snapshot, snapshotSource } from "@tracepanel/ui";
import { TooltipProvider } from "@tracepanel/ui/components/ui/tooltip";
import { useMemo } from "react";
import { href, type Route, useRoute } from "./routes";
import { TracePage } from "./TracePage";

type Shown = { id: string; from?: string | undefined; tab?: string | undefined; span?: string | undefined };

/** The trace a route opens: the shared one at the start, a trace of the snapshot by its link, else none. */
function shownTrace(route: Route, snapshot: Snapshot): Shown | null {
  if (route.name === "home") return { id: snapshot.root };
  if (route.name !== "trace" || !snapshot.traces[route.id]) return null;
  return { id: route.id, from: route.from, tab: route.tab, span: route.span };
}

/** When and how the snapshot was made, and the way back to the shared trace from another. */
function SnapshotBar({ snapshot, away }: { snapshot: Snapshot; away: boolean }) {
  const when = new Date(snapshot.created / 1000).toLocaleString();
  return (
    <div className="flex shrink-0 flex-wrap items-baseline gap-x-2 border-b bg-muted/40 px-6 py-2 text-sm">
      <span className="font-medium">Tracepanel snapshot</span>
      <span className="text-muted-foreground">
        Made {when} with Tracepanel {snapshot.agent}, {snapshot.values ? "with values" : "without values"}.
      </span>
      {away ? (
        <a className="ml-auto underline-offset-2 hover:underline" href={href({ name: "trace", id: snapshot.root })}>
          Back to the shared trace
        </a>
      ) : null}
    </div>
  );
}

/**
 * The console opened from a snapshot file: its traces, read-only, with no store behind them. Any other page of the
 * console isn't in the file, and says so.
 */
export function SnapshotApp({ snapshot }: { snapshot: Snapshot }) {
  const source = useMemo(() => snapshotSource(snapshot), [snapshot]);
  const shown = shownTrace(useRoute(), snapshot);
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh min-h-0 flex-col">
        <SnapshotBar snapshot={snapshot} away={shown?.id !== snapshot.root} />
        {shown ? (
          <TracePage key={shown.id} {...shown} source={source} />
        ) : (
          <main className="min-h-0 overflow-y-auto">
            <Empty
              title="Not in this snapshot"
              action={<a href={href({ name: "trace", id: snapshot.root })}>Open the shared trace</a>}
            >
              A snapshot holds one trace and the traces linked to it. The rest of the console needs the app's own
              Tracepanel.
            </Empty>
          </main>
        )}
      </div>
    </TooltipProvider>
  );
}
