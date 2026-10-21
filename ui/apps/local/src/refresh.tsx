import { Button } from "@tracepanel/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@tracepanel/ui/components/ui/dropdown-menu";
import { cn } from "@tracepanel/ui/lib/utils";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

/** One auto-refresh setting for every screen of the console, plus a manual "refresh now". */
interface Refresh {
  /** Milliseconds between reloads; 0 turns auto-refresh off, `LIVE_MS` is Live. */
  interval: number;
  setInterval: (ms: number) => void;
  /** Bumped by "refresh now": screens reload when it changes. */
  tick: number;
  now: () => void;
  /** Bumped every `interval` while the page is visible: one clock for every screen, so all reload together. */
  cycle: number;
  /** Whether a screen holds the clock while its reader reads (a record open, a list scrolled down). */
  paused: boolean;
  setPaused: (paused: boolean) => void;
}

const KEY = "tracepanel:refresh";

// Live: as often as a list can follow what happens, not so often the agent notices. It holds while the reader reads.
export const LIVE_MS = 2000;

const CHOICES: [number, string][] = [
  [LIVE_MS, "Live"],
  [0, "Off"],
  [5000, "5s"],
  [15000, "15s"],
  [60000, "1m"],
];

// What the menu's button says of an interval; Off and Live say their own.
const EVERY = new Map(CHOICES.filter(([ms]) => ms && ms !== LIVE_MS).map(([ms, text]) => [ms, `Every ${text}`]));

// Fresh enough for a local console, without its lists jumping under the reader every few seconds.
const DEFAULT_MS = 15000;

function read(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    return CHOICES.some(([ms]) => ms === value) && localStorage.getItem(KEY) !== null ? value : DEFAULT_MS;
  } catch {
    return DEFAULT_MS;
  }
}

const RefreshContext = createContext<Refresh>({
  interval: DEFAULT_MS,
  setInterval: () => undefined,
  tick: 0,
  now: () => undefined,
  cycle: 0,
  paused: false,
  setPaused: () => undefined,
});

/* ---------- What is loading: the button's spinner, its error, its "updated" time ---------- */

interface Activity {
  /** Loads in flight. */
  pending: number;
  /** Why the last load failed (the agent stopped, …); null once one succeeds. */
  error: string | null;
  /** When a load last succeeded. */
  updated: number | null;
}

let activity: Activity = { pending: 0, error: null, updated: null };
const listeners = new Set<() => void>();

function change(next: Partial<Activity>): void {
  activity = { ...activity, ...next };
  for (const listener of listeners) listener();
}

/** Counts a load for the refresh button: it spins while any is in flight and turns red when one fails. */
export function track<T>(load: Promise<T>, counts: (error: unknown) => boolean = () => true): Promise<T> {
  change({ pending: activity.pending + 1 });
  return load.then(
    (value) => {
      change({ pending: activity.pending - 1, error: null, updated: Date.now() });
      return value;
    },
    (error: unknown) => {
      // fetch() rejects with a TypeError when nothing answers: the agent stopped.
      const message =
        error instanceof TypeError
          ? "the agent isn't answering"
          : error instanceof Error
            ? error.message
            : String(error);
      change({ pending: activity.pending - 1, ...(counts(error) ? { error: message } : {}) });
      throw error;
    },
  );
}

function useActivity(): Activity {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => activity,
  );
}

/** A spin of half a turn at least: a load that answers at once is still seen. */
const MIN_SPIN_MS = 600;

function useSpinning(busy: boolean): boolean {
  const [spinning, setSpinning] = useState(busy);
  useEffect(() => {
    if (busy) {
      setSpinning(true);
      return;
    }
    const timer = setTimeout(() => setSpinning(false), MIN_SPIN_MS);
    return () => clearTimeout(timer);
  }, [busy]);
  return spinning;
}

function ago(at: number | null, now: number): string {
  if (at === null) return "Not loaded yet";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 2) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  return `Updated ${Math.round(seconds / 60)}m ago`;
}

/** The refresh icon: spinning while loading, red with the reason when the last load failed. */
function RefreshIcon({ activity }: { activity: Activity }) {
  const spinning = useSpinning(activity.pending > 0);
  return (
    <RefreshCwIcon
      className={cn(
        spinning && "animate-spin [animation-duration:0.6s] motion-reduce:animate-none",
        activity.error && !spinning && "text-error",
      )}
    />
  );
}

function useTitle(activity: Activity): string {
  // Re-read on hover: the title says how long ago, and that changes with no load.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (activity.error) return `Couldn't refresh: ${activity.error} · click to retry`;
  return `Refresh now · ${ago(activity.updated, now)}`;
}

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [interval, setIntervalState] = useState(read);
  const [tick, setTick] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!interval || paused) return;
    const timer = window.setInterval(
      () => document.visibilityState === "visible" && setCycle((current) => current + 1),
      interval,
    );
    return () => window.clearInterval(timer);
  }, [interval, paused]);
  const value = useMemo<Refresh>(
    () => ({
      interval,
      setInterval: (ms) => {
        try {
          localStorage.setItem(KEY, String(ms));
        } catch {
          // Blocked storage: the choice lasts until reload.
        }
        setIntervalState(ms);
      },
      tick,
      now: () => setTick((current) => current + 1),
      cycle,
      paused,
      setPaused,
    }),
    [interval, tick, cycle, paused],
  );
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): Refresh {
  return useContext(RefreshContext);
}

/**
 * "Refresh now" and the auto-refresh, for page headers: Live, Off or an interval, one choice for every screen.
 * `live={false}`: "Refresh now" only, for pages that don't reload on a timer. `paused`: the page's reader is reading
 * (a record open, the list scrolled down), so the clock holds, and the menu says so.
 */
export function RefreshControl({ live = true, paused = false }: { live?: boolean; paused?: boolean }) {
  const loading = useActivity();
  const title = useTitle(loading);
  const { now } = useRefresh();
  if (!live) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-9 gap-1.5 px-3 shadow-none"
        aria-label="Refresh now"
        title={title}
        onClick={now}
      >
        <RefreshIcon activity={loading} />
        Refresh
      </Button>
    );
  }
  return (
    <div className="flex shrink-0 items-center">
      <Button
        variant="outline"
        size="sm"
        className="h-9 rounded-r-none border-r-0 shadow-none"
        aria-label="Refresh now"
        title={title}
        onClick={now}
      >
        <RefreshIcon activity={loading} />
      </Button>
      <AutoRefresh paused={paused} />
    </div>
  );
}

/** The auto-refresh menu: Live on top, then off and the intervals. */
function AutoRefresh({ paused }: { paused: boolean }) {
  const { interval, setInterval } = useRefresh();
  useHold(paused);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-2 rounded-l-none px-3 shadow-none">
          <AutoRefreshLabel interval={interval} paused={paused} />
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Auto-refresh</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={String(interval)} onValueChange={(value) => setInterval(Number(value))}>
          {CHOICES.map(([ms, text]) => (
            <DropdownMenuRadioItem key={ms} value={String(ms)}>
              {ms === LIVE_MS ? <LiveChoice /> : text}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Live in the menu: what it does under its name. */
function LiveChoice() {
  return (
    <span className="grid">
      <span className="flex items-center gap-2">
        Live <LiveDot paused={false} />
      </span>
      <span className="text-xs text-muted-foreground">Every 2s, holds while you read</span>
    </span>
  );
}

/** What the menu's button says: "Live" with its light, "Live · paused", "Every 15s" or "Auto-refresh off". */
function AutoRefreshLabel({ interval, paused }: { interval: number; paused: boolean }) {
  if (interval === LIVE_MS) return <LiveLabel paused={paused} />;
  return <>{EVERY.get(interval) ?? "Auto-refresh off"}</>;
}

function LiveLabel({ paused }: { paused: boolean }) {
  const [label, title] = paused ? ["Live · paused", HELD] : ["Live", "Reloads every 2 seconds"];
  return (
    <span className="flex items-center gap-2" title={title}>
      <LiveDot paused={paused} />
      {label}
    </span>
  );
}

const HELD = "Paused while a record is open or the list is scrolled down";

/** Live's light: pulsing while it follows, steady while it holds. */
function LiveDot({ paused }: { paused: boolean }) {
  return (
    <span className="relative flex size-2" aria-hidden="true">
      {paused ? null : <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-60" />}
      <span className={cn("relative size-2 rounded-full", paused ? "bg-muted-foreground" : "bg-ok")} />
    </span>
  );
}

/** Holds the console's clock while `paused`, and lets it go when the page goes. */
function useHold(paused: boolean): void {
  const { setPaused } = useRefresh();
  useEffect(() => {
    setPaused(paused);
    return () => setPaused(false);
  }, [paused, setPaused]);
}
