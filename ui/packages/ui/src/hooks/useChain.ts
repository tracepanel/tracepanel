import { useCallback, useEffect, useRef, useState } from "react";
import type { Related } from "../types";

/**
 * The most traces down a chain of calls whose links one call tree loads: each opened call's trace asks once, and a
 * wide fan-out opened row by row stops here (the calls past it still show as rows that open their trace).
 */
const CHAIN_TRACES_MAX = 60;

interface Asked {
  root: string;
  ids: Map<string, unknown>;
  json: Map<string, string>;
}

/** The links loaded for the traces a tree opened, by trace id: those of the tree's trace (`root`). */
interface Loaded {
  root: string;
  related: ReadonlyMap<string, Related>;
}

/**
 * The links of the call traces a call tree opens, loaded one trace at a time as their rows open (`want`), with the
 * tree's own: when those reload (a trace's tasks and calls arrive later), the opened ones reload with them.
 */
export function useChain(
  root: string,
  load: ((traceId: string) => Promise<Related>) | undefined,
  reloadWith: unknown,
): { loaded: ReadonlyMap<string, Related>; want: (traceId: string) => void } {
  const [loaded, setLoaded] = useState<Loaded>({ root, related: new Map() });
  // Each trace asked for, with the tree's own links it was asked with: those reloading ask again, once.
  const asked = useRef<Asked>({ root, ids: new Map(), json: new Map() });
  if (asked.current.root !== root) asked.current = { root, ids: new Map(), json: new Map() };
  const current = useRef(reloadWith);
  current.current = reloadWith;

  const fetchOne = useCallback(
    (traceId: string) => {
      if (!load) return;
      const at = asked.current;
      load(traceId).then(
        (related) => {
          const json = JSON.stringify(related);
          // Another trace is on screen by now, or nothing changed: the tree stays as it is.
          if (asked.current !== at || at.json.get(traceId) === json) return;
          at.json.set(traceId, json);
          setLoaded((current) => ({
            root: at.root,
            related: new Map(current.root === at.root ? current.related : []).set(traceId, related),
          }));
        },
        () => undefined,
      );
    },
    [load],
  );

  const want = useCallback(
    (traceId: string) => {
      const { ids } = asked.current;
      if (ids.has(traceId) || ids.size >= CHAIN_TRACES_MAX) return;
      ids.set(traceId, current.current);
      fetchOne(traceId);
    },
    [fetchOne],
  );

  // The tree's own links reloaded: those of the traces opened in it reload with them.
  useEffect(() => {
    const { ids } = asked.current;
    for (const [traceId, askedWith] of ids) {
      if (askedWith === reloadWith) continue;
      ids.set(traceId, reloadWith);
      fetchOne(traceId);
    }
  }, [reloadWith, fetchOne]);

  return { loaded: loaded.root === root ? loaded.related : EMPTY, want };
}

const EMPTY: ReadonlyMap<string, Related> = new Map();
