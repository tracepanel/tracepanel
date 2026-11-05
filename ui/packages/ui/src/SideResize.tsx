import { type CSSProperties, type KeyboardEvent, type PointerEvent, useState } from "react";
import { readItem, writeItem } from "./lib/storage";

const WIDTH_KEY = "tracepanel:side-width";
/** The details stay readable, and so does the tree beside them. */
const MIN_SIDE = 280;
const MIN_TREE = 240;
/** The arrow keys move the edge as a drag would: left widens the pane. */
const KEY_STEPS = new Map([
  ["ArrowLeft", 32],
  ["ArrowRight", -32],
]);

function stored(): number | undefined {
  const width = Number(readItem(WIDTH_KEY));
  return width > 0 ? width : undefined;
}

function store(width: number | undefined): void {
  writeItem(WIDTH_KEY, width ? String(Math.round(width)) : null);
}

function fitted(width: number, total: number): number {
  return Math.max(MIN_SIDE, Math.min(width, total - MIN_TREE));
}

/**
 * The details pane's width, as the reader dragged it: kept across requests and page loads, the default (a share of
 * the tree's width) until then. `style` goes on the grid that holds the tree and the pane.
 */
export function useSideWidth() {
  const [width, setWidth] = useState(stored);
  const style = width ? ({ "--tp-side-width": `${width}px` } as CSSProperties) : undefined;
  return { width, setWidth, style };
}

/** The grid holding the tree and the pane: what the pane's width is measured against. */
function gridOf(handle: HTMLElement): DOMRect | undefined {
  return handle.closest(".tp-map-body")?.getBoundingClientRect();
}

function paneWidth(handle: HTMLElement): number {
  return handle.closest(".tp-map-body")?.querySelector(".tp-map-side")?.clientWidth ?? MIN_SIDE;
}

/** The width after an arrow key: from the dragged width, or the pane's default one. */
function nudged(handle: HTMLElement, width: number | undefined, step: number): number {
  return fitted((width ?? paneWidth(handle)) + step, gridOf(handle)?.width ?? 0);
}

/**
 * The line between the tree and the pane, its whole height, to drag (or move with the arrow keys) for a wider or
 * narrower pane; a double click goes back to the default width.
 */
export function SideResize({
  width,
  onWidth,
}: {
  width: number | undefined;
  onWidth: (width: number | undefined) => void;
}) {
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const grid = gridOf(event.currentTarget);
    if (grid) onWidth(fitted(grid.right - event.clientX, grid.width));
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS.get(event.key);
    if (step === undefined) return;
    event.preventDefault();
    const next = nudged(event.currentTarget, width, step);
    onWidth(next);
    store(next);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't be focused and dragged; a separator role can.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the details"
      aria-valuenow={width ? Math.round(width) : undefined}
      tabIndex={0}
      className="tp-map-resize"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={drag}
      onPointerUp={() => store(width)}
      onKeyDown={nudge}
      onDoubleClick={() => {
        onWidth(undefined);
        store(undefined);
      }}
    />
  );
}
