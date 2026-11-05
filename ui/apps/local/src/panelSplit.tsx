import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import { SearchIcon, XIcon } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

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

const MAP_KEY = "tracepanel:panel-map";
const MAP_AT_FIRST = 128;
const MAP_LEAST = 64;
const MAP_MOST = 640;
/** The time column, its gaps and the row's end, right of the bars. */
const AFTER_MAP = 90;

function heldMap(width: number): number {
  return Math.round(Math.min(MAP_MOST, Math.max(MAP_LEAST, width)));
}

/** The bars' width, a small map at first: in `--wf-map`, the names take the rest. Remembered. */
export function useMapWidth() {
  const [width, setWidth] = useState(() => {
    const stored = Number(readItem(MAP_KEY));
    return stored > 0 ? heldMap(stored) : MAP_AT_FIRST;
  });
  const keep = (next: number) => {
    setWidth(next);
    writeItem(MAP_KEY, String(next));
  };
  return {
    style: { "--wf-map": `${width}px` } as CSSProperties,
    handle: {
      now: width,
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const box = event.currentTarget.parentElement?.getBoundingClientRect();
        if (box && event.currentTarget.hasPointerCapture(event.pointerId)) {
          setWidth(heldMap(box.right - AFTER_MAP - event.clientX));
        }
      },
      onPointerUp: () => writeItem(MAP_KEY, String(width)),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === "ArrowLeft") keep(heldMap(width + 16));
        else if (event.key === "ArrowRight") keep(heldMap(width - 16));
      },
      onDoubleClick: () => keep(MAP_AT_FIRST),
    },
  };
}

/** The line between the tree and the bars: drag it, or arrows on it; a double click puts it back. */
export function MapSplitter({ now, ...props }: ReturnType<typeof useMapWidth>["handle"]) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a splitter that moves, which an <hr> can't be.
    <div
      className="panel-wf-split"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the time bars"
      aria-valuemin={MAP_LEAST}
      aria-valuemax={MAP_MOST}
      aria-valuenow={now}
      tabIndex={0}
      {...props}
    />
  );
}

/** The panel's filter over the waterfall: ⌘K to it, Esc clears it, and closes the panel only once it is empty. */
export function PanelFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <label className="panel-filter">
      <SearchIcon aria-hidden="true" />
      <input
        ref={input}
        type="text"
        value={value}
        placeholder="Filter"
        aria-label="Filter the rows"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !value) return;
          event.preventDefault();
          onChange("");
        }}
      />
      {value ? null : <kbd>⌘K</kbd>}
    </label>
  );
}

const DETAILS_SHOWN_KEY = "tracepanel:panel-details-shown";

/** Whether the details are beside the rows, or closed for the rows and their bars to take the panel. Remembered. */
export function useDetailsShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(() => readItem(DETAILS_SHOWN_KEY) !== "0");
  const keep = (next: boolean) => {
    setShown(next);
    writeItem(DETAILS_SHOWN_KEY, next ? null : "0");
  };
  return [shown, keep];
}

/** Closes the details, at the end of their tabs: the rows and their bars take the panel until a row is picked. */
export function DetailsClose({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="icon-button panel-wf-details-close" aria-label="Close details" onClick={onClose}>
      <XIcon />
    </button>
  );
}
