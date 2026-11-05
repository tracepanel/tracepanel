import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useCallback, useRef, useState } from "react";

const KEY = "tracepanel:panel-names";
const LEAST = 0.2;
const MOST = 0.75;
const AT_FIRST = 0.5;
const STEP = 0.02;

function held(share: number): number {
  return Math.min(MOST, Math.max(LEAST, share));
}

function remembered(): number {
  const share = Number(readItem(KEY));
  return share > 0 ? held(share) : AT_FIRST;
}

/**
 * The waterfall's split between its call tree and its bars: the tree's width, in pixels, in `--wf-names`, for
 * the rows and the bar above them; a share of the width, remembered, so it holds when the panel resizes.
 */
export function useNamesSplit() {
  const [share, setShare] = useState(remembered);
  const [width, setWidth] = useState(0);
  const area = useRef<HTMLElement | null>(null);
  const watcher = useRef<ResizeObserver | null>(null);
  const areaRef = useCallback((node: HTMLElement | null) => {
    watcher.current?.disconnect();
    area.current = node;
    if (!node) return;
    watcher.current = new ResizeObserver(() => setWidth(node.clientWidth));
    watcher.current.observe(node);
    setWidth(node.clientWidth);
  }, []);
  const keep = (next: number) => {
    setShare(next);
    writeItem(KEY, String(next));
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const box = area.current?.getBoundingClientRect();
    if (!(box && event.currentTarget.hasPointerCapture(event.pointerId))) return;
    setShare(held((event.clientX - box.left) / box.width));
  };
  const onPointerUp = () => writeItem(KEY, String(share));
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft") keep(held(share - STEP));
    else if (event.key === "ArrowRight") keep(held(share + STEP));
  };
  const style = width ? ({ "--wf-names": `${Math.round(width * share)}px` } as CSSProperties) : undefined;
  return {
    style,
    areaRef,
    handle: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onKeyDown,
      onDoubleClick: () => keep(AT_FIRST),
      now: Math.round(share * 100),
    },
  };
}

/** The line between the call tree and the bars: drag it, or arrows on it; a double click puts it back. */
export function NamesSplitter({ now, ...props }: ReturnType<typeof useNamesSplit>["handle"]) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a splitter that moves, which an <hr> can't be.
    <div
      className="panel-wf-split"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the call tree"
      aria-valuemin={LEAST * 100}
      aria-valuemax={MOST * 100}
      aria-valuenow={now}
      tabIndex={0}
      {...props}
    />
  );
}
