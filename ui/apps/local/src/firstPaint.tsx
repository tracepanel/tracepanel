// The console's first paint: on a load or a reload it shows once, whole (the menu with its sections, the page with
// its lists), and fades in, instead of building itself on screen piece by piece. After that, pages load as they do.
import { cn } from "@tracepanel/ui/lib/utils";
import { createContext, type ReactNode, useContext, useEffect, useId, useLayoutEffect, useState } from "react";

type Report = (id: string, ready: boolean | null) => void;

const PaintContext = createContext<Report>(() => undefined);

// What the console waits for at most: a slow agent still gets a console, its pages loading in it.
const WAIT_MS = 2500;

/** Holds the first paint until `ready`: a page says it while its first answers are missing. */
export function usePaintWhen(ready: boolean): void {
  const report = useContext(PaintContext);
  const id = useId();
  // Before the browser paints: a page that waits says so before the console can show without it.
  useLayoutEffect(() => report(id, ready), [id, ready, report]);
  useLayoutEffect(() => () => report(id, null), [id, report]);
}

/** The waiting pages with one's news: ready or not, or gone (`null`). */
function reported(current: ReadonlyMap<string, boolean>, id: string, ready: boolean | null): Map<string, boolean> {
  const next = new Map(current);
  if (ready === null) next.delete(id);
  else next.set(id, ready);
  return next;
}

/** Whether the console shows: once the menu and every waiting page are ready, or once it waited long enough. */
function useShown(ready: boolean): boolean {
  const [shown, setShown] = useState(false);
  if (ready && !shown) setShown(true);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  return shown;
}

/** The console, hidden until the menu (`catalog`) and every page that waits are ready, then faded in, once. */
export function FirstPaint({ catalog, children }: { catalog: boolean; children: ReactNode }) {
  const [waiting, setWaiting] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [report] = useState<Report>(
    () => (id: string, ready: boolean | null) => setWaiting((current) => reported(current, id, ready)),
  );
  const shown = useShown(catalog && [...waiting.values()].every(Boolean));
  return (
    <PaintContext.Provider value={report}>
      <div
        className={cn("h-full transition-opacity duration-200 motion-reduce:transition-none", !shown && "opacity-0")}
        aria-busy={!shown}
        data-first-paint={shown ? "shown" : "waiting"}
      >
        {children}
      </div>
    </PaintContext.Provider>
  );
}
