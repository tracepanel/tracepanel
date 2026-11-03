import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { linksBehind } from "../lib/chainRows";
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

/**
 * The links loaded for the traces a tree opened, by trace id: those of the tree's trace (`root`); and the traces
 * opened whose links are still on their way (`loading`: asked, no answer yet).
 */
interface Loaded {
  root: string;
  related: ReadonlyMap<string, Related>;
  loading: ReadonlySet<string>;
}

/** While the tree's links miss traces its chain has, they are asked for again this often, this many times at most. */
const BEHIND_ASK_MS = 1_000;
const BEHIND_ASKS = 5;

/** The traces of the trace's chain of calls, where each hangs (`parent`: the trace whose call it served). */
type Expected = readonly { id: string; parent: string | null; via: string | null }[];

/**
 * What the tree is to catch up with: the trace's chain (`expected`, loaded on its own clock), and the way to reload the
 * tree's own links (`reloadRoot`; the opened traces' it reloads itself).
 */
export interface CatchUp {
  expected?: Expected | undefined;
  reloadRoot?: (() => void) | undefined;
}

/**
 * The links of the call traces a call tree opens, loaded one trace at a time as their rows open (`want`), with the
 * tree's own (`related`): when those reload (a trace's tasks and calls arrive later), the opened ones reload with
 * them. While the chain has traces those links don't name yet (`behind`: the agent stored them after the links
 * loaded), the links missing them are asked for again, so the tree fills as soon as the chain does; the chain's traces
 * under an opened trace whose links haven't come yet are not in the tree either, and count in `behind` too.
 */
export function useChain(
  root: string,
  load: ((traceId: string) => Promise<Related>) | undefined,
  related: Related | undefined,
  { expected, reloadRoot }: CatchUp = {},
): { loaded: ReadonlyMap<string, Related>; want: (traceId: string) => void; behind: number } {
  const reloadWith = related;
  const [loaded, setLoaded] = useState<Loaded>({ root, related: new Map(), loading: new Set() });
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
          setLoaded((current) => {
            const same = current.root === at.root;
            return {
              root: at.root,
              related: new Map(same ? current.related : []).set(traceId, related),
              loading: without(same ? current.loading : EMPTY_IDS, traceId),
            };
          });
        },
        // No links to wait for: the tree shows the trace's calls as they are.
        () => {
          if (asked.current !== at) return;
          setLoaded((current) =>
            current.root === at.root ? { ...current, loading: without(current.loading, traceId) } : current,
          );
        },
      );
    },
    [load],
  );

  const want = useCallback(
    (traceId: string) => {
      const { ids } = asked.current;
      if (ids.has(traceId) || ids.size >= CHAIN_TRACES_MAX) return;
      ids.set(traceId, current.current);
      const { root: at } = asked.current;
      setLoaded((loaded) =>
        loaded.root === at
          ? { ...loaded, loading: new Set(loaded.loading).add(traceId) }
          : { root: at, related: new Map(), loading: new Set([traceId]) },
      );
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

  const ours = loaded.root === root;
  const shown = ours ? loaded.related : EMPTY;
  const loading = ours ? loaded.loading : EMPTY_IDS;
  const behind = useMemo(
    () => linksBehind(expected ?? [], (traceId) => (traceId === root ? related : shown.get(traceId))),
    [expected, root, related, shown],
  );
  // The chain's traces under an opened trace whose links are still on their way: not in the tree yet either.
  const coming = useMemo(
    () => (expected ?? []).filter((each) => each.parent !== null && loading.has(each.parent)).length,
    [expected, loading],
  );
  useCatchUp(root, behind, reloadRoot, fetchOne);
  return { loaded: shown, want, behind: behind.length + coming };
}

/** The ids but one (the same set when it isn't among them). */
function without(ids: ReadonlySet<string>, traceId: string): ReadonlySet<string> {
  if (!ids.has(traceId)) return ids;
  const left = new Set(ids);
  left.delete(traceId);
  return left;
}

/**
 * Asks again for the links that miss traces of the chain (`behind`): at once, then every BEHIND_ASK_MS while they
 * still miss the same ones, BEHIND_ASKS times at most (links that never name a trace the chain has don't poll on).
 */
function useCatchUp(
  root: string,
  behind: Expected,
  reloadRoot: (() => void) | undefined,
  fetchOne: (traceId: string) => void,
): void {
  const key = behind.map((each) => `${each.parent}/${each.id}`).join(",");
  const [again, setAgain] = useState(0);
  const asked = useRef({ key: "", count: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `behind`; `again` asks once more.
  useEffect(() => {
    if (key === "") return;
    if (asked.current.key !== key) asked.current = { key, count: 0 };
    if (asked.current.count >= BEHIND_ASKS) return;
    asked.current.count += 1;
    for (const parent of new Set(behind.map((each) => each.parent))) {
      if (parent === root) reloadRoot?.();
      else if (parent !== null) fetchOne(parent);
    }
    const timer = window.setTimeout(() => setAgain((count) => count + 1), BEHIND_ASK_MS);
    return () => window.clearTimeout(timer);
  }, [key, again]);
}

const EMPTY: ReadonlyMap<string, Related> = new Map();
const EMPTY_IDS: ReadonlySet<string> = new Set();
