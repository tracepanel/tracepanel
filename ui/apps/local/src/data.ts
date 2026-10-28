import { type Page, SearchError } from "@tracepanel/ui";
import { useCallback, useEffect, useState } from "react";
import { track, useRefresh } from "./refresh";

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
}

/**
 * Loads on every change of `q`, on "refresh now", and on the auto-refresh interval (times `slower`) while visible.
 * `slower` 0: no interval, for summaries that change slowly (the page refreshes on "refresh now" only).
 */
/**
 * Calls `reset` when the rows on screen stop being of what is asked for. Another loader is another resource (a page
 * switching from groups to calls): its old data would show for a moment as the new resource's. A new `q` for the
 * same loader keeps the old rows until the new ones arrive, except no search at all: the whole list is never the last
 * search's rows, or a search that matched nothing would pass for nothing stored yet.
 */
function useResource(load: unknown, q: string, reset: () => void): void {
  const [loader, setLoader] = useState(() => load);
  const [searched, setSearched] = useState(q);
  if (loader !== load) {
    setLoader(() => load);
    reset();
  }
  if (searched !== q) {
    setSearched(q);
    if (!q) reset();
  }
}

export function useSearch<T>(load: (q: string) => Promise<T>, q: string, slower = 1): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: undefined, error: null });
  useResource(load, q, () => setState({ data: undefined, error: null }));
  const { tick, cycle } = useRefresh();
  // The shared clock's cycles, every `slower`th of them: all screens reload together.
  const due = slower ? Math.floor(cycle / slower) : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reloads on "refresh now", `due` on the clock.
  useEffect(() => {
    let cancelled = false;
    // A rejected search is the query's fault, not a failed refresh: the button stays as it is.
    track(load(q), (error) => !(error instanceof SearchError)).then(
      (data) => !cancelled && setState({ data, error: null }),
      (error: unknown) =>
        !cancelled &&
        setState((current) => ({
          data: error instanceof SearchError ? undefined : current.data,
          error: error instanceof Error ? error.message : String(error),
        })),
    );
    return () => {
      cancelled = true;
    };
  }, [load, q, due, tick]);
  return state;
}

type PageLoad<T> = (q: string, before: number | null) => Promise<Page<T>>;

/**
 * What lies between a refreshed first page and the older pages shown under it. New rows push rows out of the first
 * page, while the older pages still start where it used to end (`boundary`): without these, those rows would show
 * nowhere. Pages from `from` down, every row at or after the boundary.
 */
async function between<T>(
  load: PageLoad<T>,
  q: string,
  from: number | null,
  boundary: number,
  cursorOf: (item: T) => number,
): Promise<T[]> {
  const items: T[] = [];
  let cursor = from;
  while (cursor !== null && cursor > boundary) {
    const page = await load(q, cursor);
    const kept = page.items.filter((item) => cursorOf(item) >= boundary);
    items.push(...kept);
    if (kept.length < page.items.length) break;
    cursor = page.next;
  }
  return items;
}

interface Older<T> {
  items: T[];
  next: number | null;
  q: string;
  /** Where the first page ended when the first older page was asked for: the older pages are all before it. */
  boundary: number | null;
}

/** The rows between the first page and the older ones, for the first page they were loaded under. */
function useBetween<T>(
  load: PageLoad<T>,
  first: Page<T> | undefined,
  older: Older<T>,
  cursorOf: (item: T) => number,
): T[] | undefined {
  const [bridge, setBridge] = useState<{ under: Page<T> | undefined; items: T[] }>({ under: undefined, items: [] });
  useEffect(() => {
    if (!first || older.boundary === null) return;
    let cancelled = false;
    between(load, older.q, first.next, older.boundary, cursorOf).then(
      (items) => !cancelled && setBridge({ under: first, items }),
      () => !cancelled && setBridge({ under: first, items: [] }),
    );
    return () => {
      cancelled = true;
    };
  }, [load, first, older.q, older.boundary, cursorOf]);
  if (older.boundary === null) return [];
  return bridge.under === first ? bridge.items : undefined;
}

/** The cursor of the next older page: past the older pages once there are some, else past the first. */
function nextCursor<T>(older: Older<T>, first: Page<T> | undefined): number | null {
  return older.items.length > 0 ? older.next : (first?.next ?? null);
}

/** The older pages, appended one at a time; a new search starts them over. */
function useOlder<T>(load: PageLoad<T>, q: string, first: Page<T> | undefined) {
  const [older, setOlder] = useState<Older<T>>({ items: [], next: null, q, boundary: null });
  const [loading, setLoading] = useState(false);
  if (older.q !== q) setOlder({ items: [], next: null, q, boundary: null });
  const next = nextCursor(older, first);
  const more = () => {
    // One page at a time: scrolling and the button may both ask.
    if (next === null || loading) return;
    setLoading(true);
    const boundary = older.boundary ?? next;
    load(q, next)
      .then((page) =>
        setOlder((current) => ({ items: [...current.items, ...page.items], next: page.next, q, boundary })),
      )
      .finally(() => setLoading(false));
  };
  return { older, next, loading, more };
}

/**
 * The rows as last whole: while the rows between pages load, the list stays as it was, never with a gap. The same
 * rows are the same list, so what is worked out from them (a long list's lines) isn't worked out again each render.
 */
function useWhole<T>(items: T[] | undefined): T[] | undefined {
  const [shown, setShown] = useState<T[] | undefined>(undefined);
  const next = whole(shown, items);
  if (next !== shown) setShown(next);
  return next;
}

/** The rows to show: the ones shown while the new ones are the same or still loading, else the new ones. */
function whole<T>(shown: T[] | undefined, items: T[] | undefined): T[] | undefined {
  return items === undefined || sameRows(shown, items) ? shown : items;
}

/**
 * Cursor pages: the first page refreshes, older pages are appended on demand, and the rows a refresh pushes out of
 * the first page stay listed between the two. `cursorOf` is the value a page's cursor is (a row's time).
 */
export function usePaged<T>(load: PageLoad<T>, q: string, cursorOf: (item: T) => number) {
  const first = useSearch(
    useCallback((query: string) => load(query, null), [load]),
    q,
  );
  const { older, next, loading, more } = useOlder(load, q, first.data);
  const bridge = useBetween(load, first.data, older, cursorOf);
  const whole = useWhole(first.data && bridge ? [...first.data.items, ...bridge, ...older.items] : undefined);
  return {
    items: first.data ? whole : undefined,
    error: first.error,
    hasMore: next !== null,
    loading,
    more,
  };
}

function sameRows<T>(a: readonly T[] | undefined, b: readonly T[]): boolean {
  return a !== undefined && a.length === b.length && a.every((item, index) => item === b[index]);
}

/** True from the first time `now` is, and from then on: a page shown once stays shown while it reloads. */
export function useLatch(now: boolean): boolean {
  const [latched, setLatched] = useState(now);
  if (now && !latched) setLatched(true);
  return latched || now;
}
