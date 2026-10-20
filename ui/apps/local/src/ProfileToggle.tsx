import { type DataSource, Hint } from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { FlameIcon } from "lucide-react";
import { useState } from "react";
import { useCapability } from "./hooks";

// While it is set, the app profiles every request this browser makes; a session cookie, so closing the browser ends it.
const COOKIE = "tracepanel_profile";

function profiling(): boolean {
  return document.cookie.split("; ").some((pair) => pair === `${COOKIE}=1`);
}

function profile(on: boolean): void {
  document.cookie = on ? `${COOKIE}=1; Path=/; SameSite=Lax` : `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

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
  const hint = HINTS[on ? "on" : "off"];
  return (
    <Hint title={hint.title} detail={hint.detail}>
      <button
        type="button"
        className={cn(
          "icon-button",
          on && "bg-orange-500/15 text-orange-500 hover:bg-orange-500/25 hover:text-orange-500",
        )}
        aria-label={hint.title}
        aria-pressed={on}
        onClick={() => {
          profile(!on);
          setOn(!on);
        }}
      >
        <FlameIcon className={cn("size-4", on && "fill-amber-400 drop-shadow-[0_0_4px_rgb(249_115_22/0.6)]")} />
      </button>
    </Hint>
  );
}
