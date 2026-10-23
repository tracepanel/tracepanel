import { type RefObject, useEffect, useRef, useState } from "react";

/** The nearest ancestor that scrolls up and down: what a sticky header sticks to (none: the page). */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** Out of view above the top of what scrolls, not below its bottom. */
function above(entry: IntersectionObserverEntry): boolean {
  return !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0);
}

/**
 * Whether a sticky header is stuck: the rows scroll under it. `sentinel` goes at the top of what scrolls with the
 * rows; once it has gone past the top of the scrolling ancestor while the rest is still in view, the header holds
 * the top edge.
 */
export function useStuck<T extends HTMLElement>(): { sentinel: RefObject<T | null>; stuck: boolean } {
  const sentinel = useRef<T>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) setStuck(above(entry));
      },
      { root: scrollerOf(element) },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { sentinel, stuck };
}
