import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const KEY = "tracepanel:panel-names";
const LEAST = 0.2;
const MOST = 0.75;
const AT_FIRST = 0.5;
const STEP = 0.02;

function heldShare(share: number): number {
  return Math.min(MOST, Math.max(LEAST, share));
}

function remembered(): number {
  const share = Number(readItem(KEY));
  return share > 0 ? heldShare(share) : AT_FIRST;
}

/**
 * The waterfall's split between its call tree and its bars: the tree's width, in pixels, in `--wf-names`, for
 * the rows and the bar above them; a share of the width, remembered, so it holds when the panel resizes.
 */
export function useNamesSplit(frozen: boolean) {
  const [share, setShare] = useState(remembered);
  const [width, setWidth] = useState(0);
  // The tree keeps its width when the details step aside for a row: only the bars take their room.
  const held = useRef(frozen);
  held.current = frozen;
  const area = useRef<HTMLElement | null>(null);
  const watcher = useRef<ResizeObserver | null>(null);
  const areaRef = useCallback((node: HTMLElement | null) => {
    watcher.current?.disconnect();
    area.current = node;
    if (!node) return;
    watcher.current = new ResizeObserver(() => {
      if (!held.current) setWidth(node.clientWidth);
    });
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
    setShare(heldShare((event.clientX - box.left) / (width || box.width)));
  };
  const onPointerUp = () => writeItem(KEY, String(share));
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft") keep(heldShare(share - STEP));
    else if (event.key === "ArrowRight") keep(heldShare(share + STEP));
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

/** Whether the selected row has nothing to say: its details are there and empty, so the panel gives up their room. */
export function useDetailsEmpty(host: HTMLElement | null): boolean {
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    if (!host) return;
    const check = () => setEmpty(host.querySelector(".dt-trace") !== null && !host.textContent?.trim());
    check();
    const watcher = new MutationObserver(check);
    watcher.observe(host, { childList: true, subtree: true, characterData: true });
    return () => watcher.disconnect();
  }, [host]);
  return empty;
}

const DETAILS_LEAST = 0.2;
const DETAILS_MOST = 0.7;
/** How much of the panel the details take at first, by where the panel is docked. */
const DETAILS_AT_FIRST: Readonly<Record<string, number>> = { bottom: 0.38, right: 0.45 };

function heldDetails(share: number): number {
  return Math.min(DETAILS_MOST, Math.max(DETAILS_LEAST, share));
}

function rememberedDetails(dock: string): number {
  const share = Number(readItem(`tracepanel:panel-details-${dock}`));
  return share > 0 ? heldDetails(share) : (DETAILS_AT_FIRST[dock] ?? 0.38);
}

/**
 * The split between the rows and the details: their share of the panel in `--wf-details`, across docked at the
 * bottom, down docked at the right, remembered for each.
 */
export function useDetailsSplit(dock: string) {
  const down = dock === "right";
  const [shares, setShares] = useState<Readonly<Record<string, number>>>({});
  const share = shares[dock] ?? rememberedDetails(dock);
  const set = (next: number) => setShares((all) => ({ ...all, [dock]: next }));
  const save = (next: number) => writeItem(`tracepanel:panel-details-${dock}`, String(next));
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!(box && event.currentTarget.hasPointerCapture(event.pointerId))) return;
    set(heldDetails(down ? (box.bottom - event.clientY) / box.height : (box.right - event.clientX) / box.width));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const grows = down ? "ArrowUp" : "ArrowLeft";
    const shrinks = down ? "ArrowDown" : "ArrowRight";
    if (event.key !== grows && event.key !== shrinks) return;
    const next = heldDetails(share + (event.key === grows ? STEP : -STEP));
    set(next);
    save(next);
  };
  return {
    style: { "--wf-details": `${(share * 100).toFixed(2)}%` } as CSSProperties,
    handle: {
      down,
      now: Math.round(share * 100),
      onPointerDown,
      onPointerMove,
      onPointerUp: () => save(share),
      onKeyDown,
      onDoubleClick: () => {
        const first = DETAILS_AT_FIRST[dock] ?? 0.38;
        set(first);
        save(first);
      },
    },
  };
}

/** The line between the rows and the details: drag it, or arrows on it; a double click puts it back. */
export function DetailsSplitter({ down, now, ...props }: ReturnType<typeof useDetailsSplit>["handle"]) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a splitter that moves, which an <hr> can't be.
    <div
      className="panel-wf-details-split"
      role="separator"
      aria-orientation={down ? "horizontal" : "vertical"}
      aria-label="Resize the details"
      aria-valuemin={DETAILS_LEAST * 100}
      aria-valuemax={DETAILS_MOST * 100}
      aria-valuenow={now}
      tabIndex={0}
      {...props}
    />
  );
}
