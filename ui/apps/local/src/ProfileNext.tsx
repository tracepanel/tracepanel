import type { DataSource } from "@tracepanel/ui";
import { cn } from "@tracepanel/ui/lib/utils";
import { FlameIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useCapability } from "./hooks";

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

/** An icon among the panel's own (share, theme, dock): a dot on it while it waits for the request. */
function ProfileButton() {
  const [waiting, setWaiting] = useState(false);
  // The app deletes the cookie with the request it profiled; the button follows.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setWaiting(armed()), 500);
    return () => clearInterval(timer);
  }, [waiting]);
  const title = TITLES[waiting ? "waiting" : "idle"];
  return (
    <button
      type="button"
      className={cn("icon-button relative", waiting && "text-brand")}
      title={title}
      aria-label={title}
      aria-pressed={waiting}
      onClick={() => {
        ask(!waiting);
        setWaiting(!waiting);
      }}
    >
      <FlameIcon className="size-4" />
      {waiting ? <span className="absolute top-1 right-1 size-1.5 animate-pulse rounded-full bg-brand" /> : null}
    </button>
  );
}
