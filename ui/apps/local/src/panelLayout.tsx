import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import { rem } from "@tracepanel/ui/lib/utils";
import { type RefObject, useCallback, useEffect, useState } from "react";

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

const LIST_WIDTH_KEY = "tracepanel:list-width";

// In rem, so the defaults follow the density; a dragged width is the reader's, in pixels.
// A narrow window gives the trace the room: its tabs keep their names where the list would take them (a quarter of
// the width, down to 15rem).
const LIST_WIDTH = () => Math.round(Math.min(rem(22.5), Math.max(rem(15), window.innerWidth * 0.26)));

const MIN_LIST_WIDTH = () => Math.round(rem(13.75));

const MIN_TRACE_WIDTH = () => Math.round(rem(22.5));

/** The width the reader dragged the list to, kept in this browser; null where they never did. */
function storedListWidth(): number | null {
  const value = Number(readItem(LIST_WIDTH_KEY));
  return value >= MIN_LIST_WIDTH() ? value : null;
}

/**
 * The list's width: the reader's, else the default for the panel's width, followed as the panel opens and resizes
 * (it may be narrow at first while it opens).
 */
function useListWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => storedListWidth() ?? LIST_WIDTH());
  const [dragged, setDragged] = useState(() => storedListWidth() !== null);
  useEffect(() => {
    if (dragged) return;
    const follow = () => setWidth(LIST_WIDTH());
    follow();
    window.addEventListener("resize", follow);
    return () => window.removeEventListener("resize", follow);
  }, [dragged]);
  const drag = useCallback((next: number) => {
    setDragged(true);
    setWidth(next);
  }, []);
  return [width, drag];
}

function clampListWidth(value: number): number {
  return Math.round(Math.min(Math.max(value, MIN_LIST_WIDTH()), window.innerWidth - MIN_TRACE_WIDTH()));
}

/**
 * The divider between the request list and the trace: drag it, use the arrow keys, double-click to reset.
 * While dragging the width goes straight to the CSS variable, so React does not render on every pointer move.
 */
export function SplitHandle({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const [width, setWidth] = useListWidth();
  const apply = useCallback(
    (value: number, save: boolean) => {
      const next = clampListWidth(value);
      container.current?.style.setProperty("--list-width", `${next}px`);
      if (!save) return;
      setWidth(next);
      writeItem(LIST_WIDTH_KEY, String(next));
    },
    [container, setWidth],
  );
  useEffect(() => apply(width, false), [apply, width]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable separator has no native element.
    <div
      className="split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the request list"
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(event) => {
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        handle.dataset["dragging"] = "";
        const left = container.current?.getBoundingClientRect().left ?? 0;
        const onMove = (move: PointerEvent) => apply(move.clientX - left, false);
        const onUp = (up: PointerEvent) => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
          delete handle.dataset["dragging"];
          apply(up.clientX - left, true);
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      }}
      onDoubleClick={() => apply(LIST_WIDTH(), true)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 80 : 20;
        if (event.key === "ArrowLeft") apply(width - step, true);
        else if (event.key === "ArrowRight") apply(width + step, true);
        else return;
        event.preventDefault();
      }}
    />
  );
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
