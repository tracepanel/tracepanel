import { type DataSource, Hint } from "@tracepanel/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@tracepanel/ui/components/ui/dropdown-menu";
import { cn } from "@tracepanel/ui/lib/utils";
import { ChevronDownIcon, FlameIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useCapability } from "./hooks";

// While it is set, the app profiles every request this browser makes; a session cookie, so closing the browser ends it.
const COOKIE = "tracepanel_profile";

/** Off, where the time goes, or that and what the code allocated (tracemalloc: the request runs slower). */
type Mode = "off" | "time" | "memory";

// What the cookie says of each mode the app sees.
const VALUES: Record<Exclude<Mode, "off">, string> = { time: "1", memory: "memory" };

function profiling(): Mode {
  const value = document.cookie
    .split("; ")
    .find((pair) => pair.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (value === VALUES.memory) return "memory";
  return value === VALUES.time ? "time" : "off";
}

function profile(mode: Mode): void {
  document.cookie =
    mode === "off" ? `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax` : `${COOKIE}=${VALUES[mode]}; Path=/; SameSite=Lax`;
  window.dispatchEvent(new Event(CHANGED));
}

const CHANGED = "tracepanel:profiling";

const HINTS: Record<Mode, { title: string; detail: string }> = {
  off: {
    title: "Profile new requests",
    detail: "Record where the time of each request from now on goes in code, until you turn it off.",
  },
  time: { title: "Profiling time", detail: "Every request this browser makes is profiled. Click to stop." },
  memory: {
    title: "Profiling time and memory (slower)",
    detail: "Every request this browser makes is profiled, with what its code allocated. Click to stop.",
  },
};

/**
 * Profiling on or off for this browser: a cookie on the app's own origin (the panel is on it) that the app sees on
 * each request. Shown only when a connected app profiles on request; the choice of memory too only when it can.
 */
export function ProfileToggle({ source }: { source: DataSource }) {
  const time = useCapability(source, "profile");
  const memory = useCapability(source, "profile_memory");
  return time ? <ProfileButton memory={memory} /> : null;
}

/** The mode this browser profiles in, kept with the cookie wherever it is changed. */
function useProfiling(): [Mode, (mode: Mode) => void] {
  const [mode, setMode] = useState(profiling);
  useEffect(() => {
    const update = () => setMode(profiling());
    window.addEventListener(CHANGED, update);
    return () => window.removeEventListener(CHANGED, update);
  }, []);
  return [mode, profile];
}

/** The flame, with the caret of its menu beside it when the app profiles memory too. */
function ProfileButton({ memory }: { memory: boolean }) {
  const [mode, choose] = useProfiling();
  return (
    <span className="flex items-center">
      <FlameButton mode={mode} onChoose={choose} joined={memory} />
      {memory ? <ProfileMenu mode={mode} onChoose={choose} /> : null}
    </span>
  );
}

/** An icon among the panel's own (share, theme, dock), lit while profiling is on; a click turns it on or off. */
function FlameButton({ mode, onChoose, joined }: { mode: Mode; onChoose: (mode: Mode) => void; joined: boolean }) {
  const on = mode !== "off";
  const hint = HINTS[mode];
  return (
    <Hint title={hint.title} detail={hint.detail}>
      <button
        type="button"
        className={cn(
          "icon-button relative",
          on && "text-orange-500 hover:text-orange-500",
          joined && "rounded-r-none",
        )}
        aria-label={hint.title}
        aria-pressed={on}
        onClick={(event) => {
          // A click starts time only, as without the menu; memory is the menu's, and any mode stops.
          onChoose(on ? "off" : "time");
          // A mouse click leaves no focus ring behind; the keyboard keeps it (detail is 0 for Enter and Space).
          if (event.detail > 0) event.currentTarget.blur();
        }}
      >
        <Flame mode={mode} />
      </button>
    </Hint>
  );
}

/** The flame, filled while profiling is on, with a dot while memory is too. */
function Flame({ mode }: { mode: Mode }) {
  return (
    <>
      <FlameIcon className={cn("size-4", mode !== "off" && "fill-orange-500/30")} />
      {mode === "memory" ? (
        <span
          data-testid="profile-memory-dot"
          className="absolute right-1 bottom-1 size-1.5 rounded-full bg-orange-500 ring-2 ring-background"
        />
      ) : null}
    </>
  );
}

/** The caret beside the flame: off, time, or time and memory. */
function ProfileMenu({ mode, onChoose }: { mode: Mode; onChoose: (mode: Mode) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="icon-button w-4 rounded-l-none"
          aria-label="Profiling mode"
          title="Time, or time and memory"
        >
          <ChevronDownIcon className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Profile new requests</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={(value) => onChoose(value as Mode)}>
          <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="time">Time</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="memory">
            Time and memory
            <span className="ml-auto text-xs text-muted-foreground">slower</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
