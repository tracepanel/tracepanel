import { useEffect, useState } from "react";

export function tellWidget(
  type: "tracepanel:close" | "tracepanel:reload" | "tracepanel:dock" | "tracepanel:clear",
  detail: Record<string, unknown> = {},
): void {
  window.parent.postMessage({ type, ...detail }, "*");
}

export type Dock = "right" | "bottom";

/** Where the widget docks the panel; it says so when the panel loads and whenever it changes. */
export function useDock(): Dock {
  const [dock, setDock] = useState<Dock>("right");
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (event.source !== window.parent || typeof data !== "object" || data === null) return;
      if ("type" in data && data.type === "tracepanel:dock" && "dock" in data) {
        setDock(data.dock === "bottom" ? "bottom" : "right");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return dock;
}

/** Wide enough for the request list beside the trace, as in the devtools Network tab. */
const SPLIT_WIDTH = 900;

export function useSplit(dock: Dock): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= SPLIT_WIDTH);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= SPLIT_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return dock === "bottom" ? wide : false;
}

/* ---------- Tab history (panel) ---------- */
