import { type DataSource, Hint, SEGMENT_TRACK } from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { CircleSmallIcon, FlameIcon, MemoryStickIcon } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
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
  off: { title: "Profiling off", detail: "The requests this browser makes run as they are." },
  time: {
    title: "Profile time",
    detail: "Record where the time of each request this browser makes goes in code, until you turn it off.",
  },
  memory: {
    title: "Profile time and memory (slower)",
    detail: "As Profile time, with what each request's code allocated. The requests run slower meanwhile.",
  },
};

/**
 * Profiling on or off for this browser: a cookie on the app's own origin (the panel is on it) that the app sees on
 * each request. Shown only when a connected app profiles on request; the choice of memory too only when it can.
 */
export function ProfileToggle({ source }: { source: DataSource }) {
  const time = useCapability(source, "profile");
  const memory = useCapability(source, "profile_memory");
  return time ? <ProfileSwitch modes={memory ? ["off", "time", "memory"] : ["off", "time"]} /> : null;
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

// How far each key moves the choice along the switch, as in any radio group.
const STEPS = new Map([
  ["ArrowRight", 1],
  ["ArrowDown", 1],
  ["ArrowLeft", -1],
  ["ArrowUp", -1],
]);

// The chosen mode's colour: orange while profiling is on, as the flame was.
const LIT: Record<Mode, string> = { off: "text-foreground", time: "text-orange-500", memory: "text-orange-500" };

/**
 * The modes side by side on the track every pill switch sits on (Segmented), as high as the toolbar's buttons: the
 * chosen one raised, lit orange while profiling is on. A radio group: Tab reaches the chosen one, arrows move.
 */
function ProfileSwitch({ modes }: { modes: readonly Mode[] }) {
  const [stored, choose] = useProfiling();
  // A memory cookie left from an app that profiles memory: here, with no segment for it, it shows as time.
  const mode = modes.includes(stored) ? stored : "time";
  const buttons = useRef(new Map<Mode, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent) => {
    const by = STEPS.get(event.key);
    if (by === undefined) return;
    event.preventDefault();
    const next = modes[(modes.indexOf(mode) + by + modes.length) % modes.length] ?? mode;
    choose(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Profile new requests" className={SEGMENT_TRACK} onKeyDown={onKeyDown}>
      {modes.map((each) => (
        <ModeButton
          key={each}
          mode={each}
          checked={each === mode}
          onChoose={choose}
          ref={(button) => {
            if (button) buttons.current.set(each, button);
            else buttons.current.delete(each);
          }}
        />
      ))}
    </div>
  );
}

/** One mode on the switch: its icon, its name and what it does in the hint. */
function ModeButton({
  mode,
  checked,
  onChoose,
  ref,
}: {
  mode: Mode;
  checked: boolean;
  onChoose: (mode: Mode) => void;
  ref: (button: HTMLButtonElement | null) => void;
}) {
  const hint = HINTS[mode];
  return (
    <Hint title={hint.title} detail={hint.detail}>
      {/* biome-ignore lint/a11y/useSemanticElements: an icon on the track, not a native radio with its label. */}
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={hint.title}
        tabIndex={checked ? 0 : -1}
        className={cn(
          "flex h-6.5 items-center gap-0.5 rounded-md px-1.5 transition-colors",
          checked ? ["bg-background shadow-sm", LIT[mode]] : "text-muted-foreground hover:text-foreground",
        )}
        onClick={(event) => {
          onChoose(mode);
          blurAfterClick(event);
        }}
      >
        <ModeIcon mode={mode} lit={checked} />
      </button>
    </Hint>
  );
}

/** A dot for off; the flame for time, filled while it is on; the flame and a memory stick for both. */
function ModeIcon({ mode, lit }: { mode: Mode; lit: boolean }) {
  if (mode === "off") return <CircleSmallIcon className="size-3.5" />;
  const flame = <FlameIcon className={cn("size-3.5", lit && "fill-orange-500/30")} />;
  return mode === "memory" ? (
    <>
      {flame}
      <MemoryStickIcon className="size-3.5" />
    </>
  ) : (
    flame
  );
}

/** A mouse click leaves no focus ring behind; the keyboard keeps it (detail is 0 for Enter and Space). */
function blurAfterClick(event: MouseEvent<HTMLButtonElement>): void {
  if (event.detail > 0) event.currentTarget.blur();
}
