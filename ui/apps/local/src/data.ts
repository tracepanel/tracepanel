import { type Page, SearchError } from "@tracepanel/ui";
import { useCallback, useEffect, useState } from "react";
import { useRefresh } from "./refresh";

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
}

/**
 * Loads on every change of `q`, on "refresh now", and on the auto-refresh interval (times `slower`) while visible.
 * `slower` 0: no interval, for summaries that change slowly (the page refreshes on "refresh now" only).
 */
export function useSearch<T>(load: (q: string) => Promise<T>, q: string, slower = 1): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: undefined, error: null });
  // Another loader is another resource (a page switching from groups to calls): its old data would show for a moment
  // as the new resource's. A new `q` for the same loader keeps the old rows until the new ones arrive.
  const [loader, setLoader] = useState(() => load);
  if (loader !== load) {
    setLoader(() => load);
    setState({ data: undefined, error: null });
  }
  const { interval, tick } = useRefresh();
  const refreshMs = interval * slower;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reloads on "refresh now".
  useEffect(() => {
    let cancelled = false;
    const run = () =>
      load(q).then(
        (data) => !cancelled && setState({ data, error: null }),
        (error: unknown) =>
          !cancelled &&
          setState((current) => ({
            data: error instanceof SearchError ? undefined : current.data,
            error: error instanceof Error ? error.message : String(error),
          })),
      );
    run();
    const timer = refreshMs
      ? window.setInterval(() => document.visibilityState === "visible" && run(), refreshMs)
      : undefined;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [load, q, refreshMs, tick]);
  return state;
}

/** Cursor pages: the first page refreshes, older pages are appended on demand. */
export function usePaged<T>(load: (q: string, before: number | null) => Promise<Page<T>>, q: string) {
  const first = useSearch(
    useCallback((query: string) => load(query, null), [load]),
    q,
  );
  const [older, setOlder] = useState<{ items: T[]; next: number | null; q: string }>({ items: [], next: null, q });
  const [loading, setLoading] = useState(false);
  if (older.q !== q) setOlder({ items: [], next: null, q });
  const next = older.items.length > 0 ? older.next : (first.data?.next ?? null);
  const more = () => {
    // One page at a time: scrolling and the button may both ask.
    if (next === null || loading) return;
    setLoading(true);
    load(q, next)
      .then((page) => setOlder((current) => ({ items: [...current.items, ...page.items], next: page.next, q })))
      .finally(() => setLoading(false));
  };
  return {
    items: first.data ? [...first.data.items, ...older.items] : undefined,
    error: first.error,
    hasMore: next !== null,
    loading,
    more,
  };
}
