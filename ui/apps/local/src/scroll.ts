import { useEffect } from "react";

// Each history entry keeps how far its page was scrolled, in its own `history.state`. A link makes a new entry with
// none, so only Back and Forward (a popstate that brings one) scroll anything: Chrome sends popstate for a link to
// another hash too, and typing in a search changes the address as well.
let pending: number | null = null;

// Saved once scrolling settles, not on every frame of it.
const SETTLE_MS = 150;
// How long to wait for a page's data to make it tall enough to scroll back into.
const PATIENCE_MS = 1500;
const POLL_MS = 50;

/** The part of the page that scrolls, marked `data-scroll`: below a list's sticky header, or the whole page. */
function page(): HTMLElement | null {
  return document.querySelector("[data-scroll]");
}

function savedScroll(state: unknown): number | null {
  if (state && typeof state === "object" && "scroll" in state && typeof state.scroll === "number") return state.scroll;
  return null;
}

/** Remember each history entry's scroll, and put it back when the browser goes Back or Forward to it. */
export function useScrollMemory(hash: string): void {
  useEffect(() => {
    let timer = 0;
    const onScroll = (event: Event) => {
      const element = page();
      if (event.target !== element || element === null) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const state = history.state && typeof history.state === "object" ? history.state : {};
        history.replaceState({ ...state, scroll: element.scrollTop }, "");
      }, SETTLE_MS);
    };
    const onPop = (event: PopStateEvent) => {
      pending = savedScroll(event.state);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("popstate", onPop);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the page for this address has rendered; restore into it.
  useEffect(() => {
    const target = pending;
    pending = null;
    if (target === null) return;
    const until = Date.now() + PATIENCE_MS;
    let timer = 0;
    const restore = () => {
      const element = page();
      if (element && element.scrollHeight - element.clientHeight >= target) {
        element.scrollTop = target;
        return;
      }
      if (Date.now() < until) timer = window.setTimeout(restore, POLL_MS);
    };
    restore();
    return () => window.clearTimeout(timer);
  }, [hash]);
}
