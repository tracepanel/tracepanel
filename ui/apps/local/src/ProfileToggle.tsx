import { type DataSource, Hint } from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { FlameIcon } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
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

// What each mode is called, and what a click that moves to it does.
const NAMES: Record<Mode, string> = {
  off: "Profiling off",
  time: "Profiling time",
  memory: "Profiling time and memory",
};
const CLICKS: Record<Mode, string> = { off: "off", time: "profile time", memory: "also memory (slower)" };

/**
 * Profiling on or off for this browser: a cookie on the app's own origin (the panel is on it) that the app sees on
 * each request. Shown only when a connected app profiles on request; memory too only when it can.
 */
export function ProfileToggle({ source }: { source: DataSource }) {
  const time = useCapability(source, "profile");
  const memory = useCapability(source, "profile_memory");
  return time ? <ProfileButton modes={memory ? ["off", "time", "memory"] : ["off", "time"]} /> : null;
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

/**
 * One icon among the toolbar's: the flame, muted while off, orange while profiling, with a dot at its corner while
 * memory is profiled too. A click (or Enter, Space) moves to the next mode and round. Its name is the mode it is in,
 * and a change is said aloud, as a screen reader doesn't read a focused button's new name by itself.
 */
function ProfileButton({ modes }: { modes: readonly Mode[] }) {
  const [stored, choose] = useProfiling();
  // A memory cookie left from an app that profiles memory: here, with no memory mode, it shows as time.
  const mode = modes.includes(stored) ? stored : "time";
  const next = modes[(modes.indexOf(mode) + 1) % modes.length] ?? "off";
  const [said, say] = useState("");
  return (
    <>
      <Hint title={`${NAMES[mode]} · click: ${CLICKS[next]}`}>
        <button
          type="button"
          className={cn("icon-button relative", mode !== "off" && "text-orange-500 hover:text-orange-500")}
          aria-label={NAMES[mode]}
          onClick={(event) => {
            choose(next);
            say(NAMES[next]);
            blurAfterClick(event);
          }}
        >
          <Flame mode={mode} />
        </button>
      </Hint>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </>
  );
}

/** The flame, filled while profiling is on, with a dot at its corner while memory is too. */
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

/** A mouse click leaves no focus ring behind; the keyboard keeps it (detail is 0 for Enter and Space). */
function blurAfterClick(event: MouseEvent<HTMLButtonElement>): void {
  if (event.detail > 0) event.currentTarget.blur();
}
