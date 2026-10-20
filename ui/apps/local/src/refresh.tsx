import { Button } from "@tracepanel/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@tracepanel/ui/components/ui/dropdown-menu";
import { useStored } from "@tracepanel/ui/hooks/useStored";
import { cn } from "@tracepanel/ui/lib/utils";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

/** One auto-refresh setting for every screen of the console, plus a manual "refresh now". */
interface Refresh {
  /** Milliseconds between reloads; 0 turns auto-refresh off. */
  interval: number;
  setInterval: (ms: number) => void;
  /** Bumped by "refresh now": screens reload when it changes. */
  tick: number;
  now: () => void;
  /** Bumped every `interval` while the page is visible: one clock for every screen, so all reload together. */
  cycle: number;
}

const KEY = "tracepanel:refresh";
const CHOICES: [number, string][] = [
  [0, "Off"],
  [2000, "2s"],
  [5000, "5s"],
  [15000, "15s"],
  [60000, "1m"],
];

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
  useEffect(() => {
    if (!interval) return;
    const timer = window.setInterval(
      () => document.visibilityState === "visible" && setCycle((current) => current + 1),
      interval,
    );
    return () => window.clearInterval(timer);
  }, [interval]);
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
    }),
    [interval, tick, cycle],
  );
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): Refresh {
  return useContext(RefreshContext);
}

/**
 * "Refresh now" and the auto-refresh interval, for page headers. `live={false}`: "Refresh now" only, for pages that
 * don't reload on a timer.
 */
export function RefreshControl({ live = true }: { live?: boolean }) {
  const { interval, setInterval, now } = useRefresh();
  const loading = useActivity();
  const title = useTitle(loading);
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
  const label = CHOICES.find(([ms]) => ms === interval)?.[1] ?? "Off";
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-l-none px-3 shadow-none">
            {interval ? `Every ${label}` : "Auto-refresh off"}
            <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel>Auto-refresh</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={String(interval)} onValueChange={(value) => setInterval(Number(value))}>
            {CHOICES.map(([ms, text]) => (
              <DropdownMenuRadioItem key={ms} value={String(ms)}>
                {text}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// Live: as often as a list can follow what happens, not so often the agent notices.
const LIVE_MS = 2000;

const readLive = (raw: unknown): boolean => raw === true;

// What the toggle says, held (live, but paused) or not.
const LIVE_SAYS: Record<string, [label: string, title: string]> = {
  true: ["Live · paused", "Paused while a record is open or the list is scrolled down"],
  false: ["Live", "Reload every 2 seconds"],
};

/**
 * Live, for a list that follows what happens as it happens (the logs, as a tail): reloads every 2 seconds while on,
 * kept per browser. `paused` while the reader is reading (a record open, the list scrolled down): it holds still then,
 * and says so.
 */
export function LiveToggle({ list, paused }: { list: string; paused: boolean }) {
  const [live, setLive] = useStored(`tracepanel:${list}:live`, readLive);
  useLive(live && !paused);
  const [label, title] = LIVE_SAYS[String(live && paused)] ?? [];
  return (
    <label className="toggle mr-3 text-base font-medium" title={title}>
      <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
      {label}
    </label>
  );
}

/** Turns a list's Live on before its page shows (an old link to Tasks' Live): the toggle reads it as it mounts. */
export function turnLiveOn(list: string): void {
  try {
    localStorage.setItem(`tracepanel:${list}:live`, "true");
  } catch {
    // Blocked storage: the toggle stays as it was.
  }
}

/** "Refresh now" every 2 seconds while `running`. */
function useLive(running: boolean) {
  const { now } = useRefresh();
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(now, LIVE_MS);
    return () => window.clearInterval(timer);
  }, [running, now]);
}
