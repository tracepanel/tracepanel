// A list that scrolls, faded at the edge it goes on past: the sidebar's, the search palette's.
import { type CSSProperties, type RefObject, useCallback, useLayoutEffect, useState } from "react";

// A list that scrolls fades out at the edge it goes on past: its foot while there is more below, its head once scrolled.
const FADE = "2.5rem";

/** How far in an edge's fade reaches: a fade where the list goes on past it, none where it ends. */
const reach = (faded: boolean) => (faded ? FADE : "0px");

function fadeMask(above: boolean, below: boolean): CSSProperties {
  return {
    maskImage: `linear-gradient(to bottom, transparent, #000 ${reach(above)}, #000 calc(100% - ${reach(below)}), transparent)`,
  };
}

/**
 * The fade of a list that scrolls, kept current as it scrolls, resizes or its items change. `attach` is the list's
 * ref: a list that mounts later than its owner (in a dialog that opens) is followed from then on.
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>) {
  const [edges, setEdges] = useState({ above: false, below: false });
  const [, setMounted] = useState<HTMLElement | null>(null);
  const attach = useCallback(
    (element: HTMLElement | null) => {
      ref.current = element;
      setMounted(element);
    },
    [ref],
  );
  const update = () => {
    const element = ref.current;
    if (!element) return;
    const above = element.scrollTop > 1;
    const below = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    setEdges((current) => (current.above === above && current.below === below ? current : { above, below }));
  };
  // After every render: the items may have changed.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  });
  return { attach, update, style: fadeMask(edges.above, edges.below) };
}
