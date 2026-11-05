import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useState } from "react";

const STEP = 0.02;

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
