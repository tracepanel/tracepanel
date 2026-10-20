import type { DataSource } from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import { cn } from "@tracepanel/ui/lib/utils";
import { FlameIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useCapability } from "./hooks";
import { NARROW_ICON } from "./UserSwitcher";

// One-shot: the app profiles the next request that carries it, and deletes it in that request's answer.
const COOKIE = "tracepanel_profile";
const WAIT_S = 60;

function armed(): boolean {
  return document.cookie.split("; ").some((pair) => pair === `${COOKIE}=1`);
}

const TITLES = {
  idle: "Profile the next request: where its time goes in code",
  waiting: "The next request this browser makes is profiled: reload the page or click something. Click to cancel.",
};

/** Ask for one profile, or take the ask back: the cookie set for a minute, or deleted. */
function ask(on: boolean): void {
  document.cookie = on
    ? `${COOKIE}=1; Max-Age=${WAIT_S}; Path=/; SameSite=Lax`
    : `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

/**
 * Profile the next request: a cookie on the app's own origin (the panel is on it) for the app to see on its next
 * request. Shown only when a connected app profiles on request.
 */
export function ProfileNext({ source }: { source: DataSource }) {
  return useCapability(source, "profile") ? <ProfileButton /> : null;
}

function ProfileButton() {
  const [waiting, setWaiting] = useState(false);
  // The app deletes the cookie with the request it profiled; the button follows.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setWaiting(armed()), 500);
    return () => clearInterval(timer);
  }, [waiting]);
  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={waiting}
      title={TITLES[waiting ? "waiting" : "idle"]}
      className={cn(
        "mr-1 h-7 gap-1.5 px-2.5 text-sm shadow-none",
        NARROW_ICON,
        waiting && "border-brand/40 bg-brand-soft text-brand",
      )}
      onClick={() => {
        ask(!waiting);
        setWaiting(!waiting);
      }}
    >
      <FlameIcon />
      <span className="bar-label">{waiting ? "Waiting…" : "Profile"}</span>
    </Button>
  );
}
