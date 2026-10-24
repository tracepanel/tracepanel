import { type DataSource, Hint } from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { FlameIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useCapability } from "./hooks";

// While it is set, the app profiles every request this browser makes; a session cookie, so closing the browser ends it.
const COOKIE = "tracepanel_profile";

function profiling(): boolean {
  return document.cookie.split("; ").some((pair) => pair === `${COOKIE}=1`);
}

function profile(on: boolean): void {
  document.cookie = on ? `${COOKIE}=1; Path=/; SameSite=Lax` : `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  window.dispatchEvent(new Event(CHANGED));
}

const CHANGED = "tracepanel:profiling";

const HINTS = {
  off: {
    title: "Profile new requests",
    detail: "Record where the time of each request from now on goes in code, until you turn it off.",
  },
  on: { title: "Profiling is on", detail: "Every request this browser makes is profiled. Click to stop." },
};

/**
 * Profiling on or off for this browser: a cookie on the app's own origin (the panel is on it) that the app sees on
 * each request. Shown only when a connected app profiles on request.
 */
export function ProfileToggle({ source }: { source: DataSource }) {
  return useCapability(source, "profile") ? <ProfileButton /> : null;
}

/** An icon among the panel's own (share, theme, dock), lit while profiling is on. */
function ProfileButton() {
  const [on, setOn] = useState(profiling);
  useEffect(() => {
    const update = () => setOn(profiling());
    window.addEventListener(CHANGED, update);
    return () => window.removeEventListener(CHANGED, update);
  }, []);
  const hint = HINTS[on ? "on" : "off"];
  return (
    <Hint title={hint.title} detail={hint.detail}>
      <button
        type="button"
        className={cn("icon-button", on && "text-orange-500 hover:text-orange-500")}
        aria-label={hint.title}
        aria-pressed={on}
        onClick={(event) => {
          profile(!on);
          setOn(!on);
          // A mouse click leaves no focus ring behind; the keyboard keeps it (detail is 0 for Enter and Space).
          if (event.detail > 0) event.currentTarget.blur();
        }}
      >
        <FlameIcon className={cn("size-4", on && "fill-orange-500/30")} />
      </button>
    </Hint>
  );
}
