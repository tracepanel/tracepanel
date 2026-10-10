import { Button } from "@tracepanel/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@tracepanel/ui/components/ui/dropdown-menu";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

/** One auto-refresh setting for every screen of the console, plus a manual "refresh now". */
interface Refresh {
  /** Milliseconds between reloads; 0 turns auto-refresh off. */
  interval: number;
  setInterval: (ms: number) => void;
  /** Bumped by "refresh now": screens reload when it changes. */
  tick: number;
  now: () => void;
}

const KEY = "tracepanel:refresh";
const CHOICES: [number, string][] = [
  [0, "Off"],
  [2000, "2s"],
  [5000, "5s"],
  [15000, "15s"],
  [60000, "1m"],
];

function read(): number {
  try {
    const value = Number(localStorage.getItem(KEY));
    return CHOICES.some(([ms]) => ms === value) && localStorage.getItem(KEY) !== null ? value : 5000;
  } catch {
    return 5000;
  }
}

const RefreshContext = createContext<Refresh>({
  interval: 5000,
  setInterval: () => undefined,
  tick: 0,
  now: () => undefined,
});

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [interval, setIntervalState] = useState(read);
  const [tick, setTick] = useState(0);
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
    }),
    [interval, tick],
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
  if (!live) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-9 gap-1.5 px-3 shadow-none"
        aria-label="Refresh now"
        title="Refresh now"
        onClick={now}
      >
        <RefreshCwIcon />
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
        title="Refresh now"
        onClick={now}
      >
        <RefreshCwIcon />
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
