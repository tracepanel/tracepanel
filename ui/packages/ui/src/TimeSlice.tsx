import {
  type CSSProperties,
  createContext,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { isTyping } from "./lib/keys";
import { cleared, isWhole, rangeOf, type Slice, sliceKey, type TimeRange, WHOLE } from "./lib/slice";

/** A move this short is a click, not a drag. */
const DRAG_PX = 4;

/** The click that ends a drag: what the pointer let go over isn't clicked. */
function swallow(event: MouseEvent): void {
  event.stopPropagation();
  event.preventDefault();
}

function ignoreNextClick(): void {
  window.addEventListener("click", swallow, { capture: true, once: true });
  // No click came (the pointer left the window): the next real one goes through.
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/** Microseconds since the trace started, at a point across a track `total` long. */
function timeAt(track: DOMRect, x: number, total: number): number {
  return (Math.min(Math.max(x - track.left, 0), track.width) / Math.max(track.width, 1)) * total;
}

/**
 * A drag across a track of the trace's time picks a stretch of it: `draft` while the pointer is down, `onRange` once
 * it lets go. A press that doesn't move stays a click on what is under it.
 */
export function useRangeDrag(total: number, onRange: (range: TimeRange) => void) {
  const [draft, setDraft] = useState<TimeRange | null>(null);
  const start = (event: ReactPointerEvent, track: Element) => {
    if (event.button !== 0) return;
    // No text selected on the way, no focus left on the row it started on.
    event.preventDefault();
    const box = track.getBoundingClientRect();
    const from = event.clientX;
    let dragged = false;
    const rangeTo = (x: number) => rangeOf(timeAt(box, from, total), timeAt(box, x, total), total);
    const move = (next: PointerEvent) => {
      dragged ||= Math.abs(next.clientX - from) >= DRAG_PX;
      if (dragged) setDraft(rangeTo(next.clientX));
    };
    const up = (next: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(null);
      if (!dragged) return;
      ignoreNextClick();
      const range = rangeTo(next.clientX);
      if (range) onRange(range);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return { draft, start };
}

/** Where a range sits across a track of the trace's time, as CSS offsets. */
function bandPlace(range: TimeRange, total: number): CSSProperties {
  const span = Math.max(total, 1);
  return { left: `${(range[0] / span) * 100}%`, width: `${((range[1] - range[0]) / span) * 100}%` };
}

/**
 * The picked stretch of time over a track: a hairline and a faint tint, no words. Where it starts and ends and how
 * long is said once, by the legend's chip that lets it go.
 */
export function RangeBand({ range, total }: { range: TimeRange; total: number }) {
  return <div className="dt-range" style={bandPlace(range, total)} aria-hidden="true" />;
}

/**
 * Esc, not taken by anything open before (a menu, a dialog, a tooltip that holds a link: it closes first) nor typed
 * into a field.
 */
function isFreeEscape(event: KeyboardEvent): boolean {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !isTyping(event) &&
    !document.querySelector(`[${ESCAPE_FIRST}]`)
  );
}

/** Set on an open tooltip that closes on Esc before the slice is let go. */
export const ESCAPE_FIRST = "data-escape-first";

/**
 * The part of a trace's time picked to look at, from a link's (`initial`), told to the host as it changes (the
 * console keeps it in the URL). Esc lets it go before anything else takes the key (going back, closing the panel).
 */
function useSlice(initial: Slice | undefined, onChange: ((slice: Slice) => void) | undefined) {
  const [slice, setSlice] = useState(initial ?? WHOLE);
  // Another link to the same trace (Back, a link with another part picked): the slice it says.
  const asked = useRef(initial ?? WHOLE);
  asked.current = initial ?? WHOLE;
  const askedKey = sliceKey(asked.current);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the slice asked for.
  useEffect(() => {
    setSlice((current) => (sliceKey(current) === askedKey ? current : asked.current));
  }, [askedKey]);
  const change = (next: Slice) => {
    setSlice(next);
    onChange?.(next);
  };
  const latest = useRef({ slice, change });
  latest.current = { slice, change };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isFreeEscape(event) || isWhole(latest.current.slice)) return;
      event.preventDefault();
      latest.current.change(cleared(latest.current.slice));
    };
    // Caught on the way down: the page's own Esc (back, close) listens on the way up.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return { slice, change };
}

/** The slice a trace's view holds, with the way to change it. */
interface Held {
  slice: Slice;
  change: (slice: Slice) => void;
}

const SliceContext = createContext<Held | null>(null);

/** Where a trace's lanes and call tree share the part of its time picked. */
export function SliceScope({
  initial,
  onChange,
  children,
}: {
  initial: Slice | undefined;
  onChange: ((slice: Slice) => void) | undefined;
  children: ReactNode;
}) {
  return <SliceContext value={useSlice(initial, onChange)}>{children}</SliceContext>;
}

/** The slice of the trace's view around, or, outside one (a call tree on its own), a slice of this part's own. */
export function useHeldSlice(): Held {
  const held = useContext(SliceContext);
  const [slice, change] = useState(WHOLE);
  return held ?? { slice, change };
}
