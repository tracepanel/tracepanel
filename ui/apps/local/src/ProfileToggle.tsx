import { type DataSource, Hint } from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { FlameIcon } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import { useCapabilities } from "./hooks";

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

// What the app's settings profile with no cookie (`profile`, `profile_memory`), said in place of the mode's name.
const FORCED: Record<Exclude<Mode, "off">, string> = {
  time: "Profiling every request (the app's profile setting)",
  memory: "Profiling every request, time and memory (the app's profile and profile_memory settings)",
};
const BACK = "time only, as the app's setting";
const SETTINGS = "To profile less, change the app's settings.";

/** What this browser can choose: the cookie only adds to what the app's settings profile, never goes below it. */
interface Choice {
  modes: readonly Mode[];
  floor: Mode;
}

function choiceOf(memory: boolean, all: boolean, memoryAll: boolean): Choice {
  // Memory with every profile: a profiled request is never the time only.
  const modes: Mode[] = memoryAll ? ["off", "memory"] : memory ? ["off", "time", "memory"] : ["off", "time"];
  const floor: Mode = all ? (memoryAll ? "memory" : "time") : "off";
  return { modes: modes.filter((mode) => mode === floor || modes.indexOf(mode) > modes.indexOf(floor)), floor };
}

/**
 * What the cookie asks for, as a mode to choose even where the apps don't offer it: the button shows what this
 * browser asks, and a click moves on from there.
 */
function withStored(choice: Choice, stored: Mode): Choice {
  const order: readonly Mode[] = ["off", "time", "memory"];
  // Below what the settings profile anyway, the button shows the settings' (see shown).
  if (choice.modes.includes(stored) || order.indexOf(stored) < order.indexOf(choice.floor)) return choice;
  return { ...choice, modes: order.filter((mode) => mode === stored || choice.modes.includes(mode)) };
}

/**
 * The cookie is the host's, not the port's: one set in any console on this host goes with every request this
 * browser makes to it, and a page's browser recording passes it on to the apps it calls (X-Tracepanel-Profile), a
 * gateway to theirs. Set with no app here that profiles on request (another project's, an agent of its own), it still
 * profiles them: the button shows, to turn it off.
 */
const ELSEWHERE: Record<Exclude<Mode, "off">, string> = {
  time: "Asking the apps this browser calls to profile time (the tracepanel_profile cookie, for every port of this host)",
  memory:
    "Asking the apps this browser calls to profile time and memory (the tracepanel_profile cookie, for every port of this host)",
};

/**
 * Profiling on or off for this browser: a cookie on the app's own origin (the panel is on it) that the app sees on
 * each request. Shown when a connected app profiles on request (memory too only when it can), or while the cookie
 * asks for it anyway (see ELSEWHERE). Lit with no cookie when the app's settings profile every request.
 */
export function ProfileToggle({ source }: { source: DataSource }) {
  const capabilities = useCapabilities(source);
  const [stored, choose] = useProfiling();
  if (!capabilities?.profile) {
    if (stored === "off") return null;
    return (
      <ProfileButton choice={{ modes: ["off", stored], floor: "off" }} stored={stored} choose={choose} elsewhere />
    );
  }
  const { profile_memory: memory, profile_all: all, profile_memory_all: memoryAll } = capabilities;
  const choice = withStored(choiceOf(memory, all, memoryAll), stored);
  return <ProfileButton choice={choice} stored={stored} choose={choose} />;
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
function ProfileButton({
  choice: { modes, floor },
  stored,
  choose,
  elsewhere = false,
}: {
  choice: Choice;
  stored: Mode;
  choose: (mode: Mode) => void;
  /** No app here profiles on request: the cookie asks the apps the browser calls (ELSEWHERE). */
  elsewhere?: boolean;
}) {
  const mode = shown(stored, modes, floor);
  const next = modes[(modes.indexOf(mode) + 1) % modes.length] ?? floor;
  const [said, say] = useState("");
  const fixed = modes.length < 2;
  return (
    <>
      <Hint {...hint(mode, fixed ? null : next, floor, elsewhere)}>
        <button
          type="button"
          className={cn(
            "icon-button relative",
            mode !== "off" && "text-orange-500 hover:text-orange-500",
            fixed && "cursor-default",
          )}
          aria-label={NAMES[mode]}
          aria-disabled={fixed || undefined}
          onClick={(event) => {
            if (fixed) return;
            // The app's settings profile the floor themselves: no cookie for it.
            choose(next === floor ? "off" : next);
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

/**
 * What the hint says: the mode, or the app's setting that profiles it, or what the cookie asks of the apps the browser
 * calls (`elsewhere`), and what a click does (`next`, if any).
 */
function hint(mode: Mode, next: Mode | null, floor: Mode, elsewhere: boolean): { title: string; detail?: string } {
  if (elsewhere && mode !== "off") return { title: `${ELSEWHERE[mode]} · click: off` };
  const forced = floor !== "off";
  const name = forced && mode === floor ? FORCED[floor] : NAMES[mode];
  if (!next) return { title: name, detail: SETTINGS };
  return { title: `${name} · click: ${forced && next === floor ? BACK : CLICKS[next]}` };
}

/** The mode the button shows: the cookie's, raised to what the app's settings profile, and one this app offers. */
function shown(stored: Mode, modes: readonly Mode[], floor: Mode): Mode {
  if (stored === "off") return floor;
  if (modes.includes(stored)) return stored;
  // A memory cookie left from an app that profiles memory shows as time where there is no memory mode; a time one,
  // where every profile has memory, as memory.
  return modes.includes("time") ? "time" : "memory";
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
