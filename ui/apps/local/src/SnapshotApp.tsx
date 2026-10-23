import { dayTime, duration, Empty, type Snapshot, snapshotSource, type Trace } from "@tracepanel/ui";
import { TooltipProvider } from "@tracepanel/ui/components/ui/tooltip";
import { useEffect, useMemo, useState } from "react";
import { href, type Route, useRoute } from "./routes";
import { TracePage } from "./TracePage";

type Shown = { id: string; from?: string | undefined; tab?: string | undefined; span?: string | undefined };

/** The trace a route opens: the shared one at the start, a trace of the snapshot by its link, else none. */
function shownTrace(route: Route, snapshot: Snapshot): Shown | null {
  if (route.name === "home") return { id: snapshot.root };
  if (route.name !== "trace" || !snapshot.traces[route.id]) return null;
  return { id: route.id, from: route.from, tab: route.tab, span: route.span };
}

/** A snapshot is sent around and opened anywhere, a phone included: there it shows the trace as the panel does. */
const NARROW = "(max-width: 720px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/** The trace on screen, named: on a narrow screen the trace has no header of its own (as in the panel). */
function TraceName({ trace }: { trace: Trace | undefined }) {
  if (!trace) return null;
  const status = trace.attrs["http.status_code"] ?? trace.status;
  return (
    <span className="w-full truncate font-medium font-mono">
      {trace.name} · {String(status)} · {duration(trace.duration)}
    </span>
  );
}

/** The trace that has no header of its own: the one on screen, shown compact. */
function headingless(variant: "full" | "compact", shown: Shown | null, snapshot: Snapshot): Trace | undefined {
  if (variant === "full" || !shown) return undefined;
  return snapshot.traces[shown.id] as Trace;
}

/** When and how the snapshot was made, and the way back to the shared trace from another. */
function SnapshotBar({ snapshot, away, named }: { snapshot: Snapshot; away: boolean; named?: Trace | undefined }) {
  const when = dayTime(snapshot.created);
  return (
    <div className="flex shrink-0 flex-wrap items-baseline gap-x-2 border-b bg-muted/40 px-6 py-2 text-sm max-[720px]:px-4">
      <TraceName trace={named} />
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
  const variant = useNarrow() ? "compact" : "full";
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh min-h-0 flex-col">
        <SnapshotBar
          snapshot={snapshot}
          away={shown?.id !== snapshot.root}
          named={headingless(variant, shown, snapshot)}
        />
        {shown ? (
          <TracePage key={shown.id} {...shown} source={source} inSnapshot={true} variant={variant} />
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
