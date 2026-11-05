import {
  type Chain,
  type ChainCall,
  type ChainEntry,
  chainApps,
  chainCalls,
  type TraceRow,
  type TraceSummary,
  waitingUntil,
} from "@tracepanel/ui";
import type { RowCounts } from "@tracepanel/ui/lib/chainCounts";
import { readJson, writeItem } from "@tracepanel/ui/lib/storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type TabHistory, usePolling } from "./hooks";
import { ARRIVING_POLL_MS, arrange, idsOf, justEnded, NO_RUNS, type Runs, rowKey } from "./panelRows";
import { source } from "./panelSource";
import { type Counter, chainCounter, countsOf, cutsOf, type KnownApp, knownApps, type RowChains } from "./viewCalls";

/** The tab's traces as the agent has them, and the task runs each led to. */
interface TabTraces {
  traces: TraceSummary[];
  runs: Runs;
  counts?: Record<string, RowCounts> | undefined;
}

const NO_TRACES: TabTraces = { traces: [], runs: NO_RUNS };

/** The tab's traces as the agent has them, and the task runs each led to (none where the source can't say). */
function loadTab(ids: readonly string[]): Promise<TabTraces> {
  if (ids.length === 0) return Promise.resolve(NO_TRACES);
  if (source.listTracesWithRuns) return source.listTracesWithRuns(ids);
  return source.listTraces({ ids, limit: ids.length }).then((traces) => ({ traces, runs: NO_RUNS }));
}

/**
 * The tab's rows, which of them the agent has stored (the others are the widget's own, still on their way), and the
 * task runs each request led to, as the workers record them.
 */
export function useTabRows(history: TabHistory | null): {
  rows: TraceRow[];
  stored: ReadonlySet<string>;
  counts: ReadonlyMap<string, RowCounts> | undefined;
  runs: Runs;
} {
  const ids = idsOf(history);
  const key = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies the id list.
  const load = useCallback(() => loadTab(ids), [key]);
  // The last answer's: whether a row that just ended is still on its way, so the list asks sooner.
  const known = useRef<ReadonlySet<string>>(new Set());
  const soon = (history?.entries ?? []).some((entry) => justEnded(entry, known.current));
  const { traces, runs, counts } = usePolling(load, soon ? ARRIVING_POLL_MS : TAB_POLL_MS) ?? NO_TRACES;
  const stored = useMemo(() => new Set(traces.map((trace) => trace.id)), [traces]);
  known.current = stored;
  const rowCounts = useMemo(() => (counts ? new Map<string, RowCounts>(Object.entries(counts)) : undefined), [counts]);
  return { rows: history ? arrange(history, traces) : [], stored, runs, counts: rowCounts };
}

/** How often the tab's rows are asked for. */
const TAB_POLL_MS = 2_000;

/** A row's chain is loaded again while it is this new: the traces of its calls may still be on their way. */
const CHAIN_FRESH_MS = 20_000;

const CHAIN_POLL_MS = 2_000;

/** What tells a row's two loads of its chain apart: its traces and how much each holds, the chain's findings. */
function chainKey(chain: Chain): string {
  const traces = chain.traces.map((each) => `${each.id}:${each.trace?.spans.length ?? 0}`).join(",");
  return `${traces}|${chain.issues.length}|${chain.capped}`;
}

/** A row's first load of its chain shows placeholder rows once it takes this long (a quick one shows nothing). */
const CHAIN_SLOW_MS = 250;

/** How often the hosts' apps may be asked for again while the list has a host none is known for. */
const KNOWN_ASK_MS = 2_000;

/**
 * The app each host was last served by, as the agent's service map links them (a call to 127.0.0.1:8043 was served by
 * graphql-router): a view's calls to a host an app served before are grouped under its name from in flight on, not
 * under the host until their traces come. Asked when the list has a host none is known for, and again as views come
 * while it still has (at most every KNOWN_ASK_MS): their traces may have named it since. Their traces' app wins.
 */
export function useKnownApps(rows: readonly TraceRow[]): ReadonlyMap<string, KnownApp> {
  const [known, setKnown] = useState<ReadonlyMap<string, KnownApp>>(() => new Map());
  const asked = useRef(0);
  const unknown = [...new Set(rows.flatMap((row) => (row.host && !known.has(row.host) ? [row.host] : [])))]
    .sort()
    .join(",");
  const views = rows.filter((row) => row.trace.kind === "page").length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view asks again for the hosts still unknown.
  useEffect(() => {
    if (!unknown) return;
    let live = true;
    const ask = () => {
      asked.current = Date.now();
      source.listServices("since:7d").then(
        (map) => live && setKnown(knownApps(map)),
        () => undefined,
      );
    };
    // Asked a moment ago: once more when the moment has passed.
    const timer = window.setTimeout(ask, Math.max(0, asked.current + KNOWN_ASK_MS - Date.now()));
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [unknown, views]);
  return known;
}

// The rows' chains, kept for the browser tab's session: the panel loads again with each page, and a row that had its
// numbers says them at once, not "…" until its chain comes again (slowly, on a slow network).
const CHAINS_KEY = "tracepanel:chains";

/** The most chains kept, the newest, and the most room they take (characters): the rest load again. */
const CHAINS_KEPT = 24;

const CHAINS_ROOM = 1_500_000;

/** A row's chain as kept: with when it was asked for (ms), as its calls are judged (asOf). */
type KeptChain = Chain & { asOf?: number | undefined };

/**
 * When a kept chain was asked for (ms): its calls are waited for, or not traced, as of then. Now for one kept before
 * the time was.
 */
function asOf(chain: KeptChain): number {
  return chain.asOf ?? Date.now();
}

/** The rows' chains, starting with those the panel had before the page reloaded it, kept as they change. */
function useKeptChains() {
  const [chains, setChains] = useState<ReadonlyMap<string, KeptChain>>(readChains);
  useEffect(() => saveChains(chains), [chains]);
  return [chains, setChains] as const;
}

function readChains(): ReadonlyMap<string, KeptChain> {
  const saved = readJson(CHAINS_KEY, "sessionStorage");
  return new Map(Array.isArray(saved) ? (saved.filter(Array.isArray) as [string, KeptChain][]) : []);
}

function saveChains(chains: ReadonlyMap<string, KeptChain>): void {
  const kept = [...chains].slice(-CHAINS_KEPT);
  let text = JSON.stringify(kept);
  // Too big: the newest that fit.
  while (text.length > CHAINS_ROOM && kept.length > 0) {
    kept.shift();
    text = JSON.stringify(kept);
  }
  // Where it can't be kept, the rows load their chains again, "…" until then.
  writeItem(CHAINS_KEY, text, "sessionStorage");
}

/**
 * The apps each row's trace called, by its id. A view's or an action's too: its requests to an app with an SDK are
 * rows of their own (left out here), but a call through a proxy or a gateway (Apollo Router, over OTLP) answers with
 * no trace id for the widget to list, and only the chain says what served it. Read from the trace's chain, as its
 * call tree and tabs read it (`source.chain`): loaded once a row is stored, again when the row changes, and every two
 * seconds while it is new or a call of it is still waited for (a service's trace can arrive after its caller's, a cut
 * call's minutes later). One load of a row at a time: a row whose
 * last load hasn't answered isn't asked again, and an answer that comes after the rows changed is kept all the same.
 * Its calls whose traces are on their way are rows too, until they arrive or stop being waited for (lib/chainRows).
 */
export function useRowChains(rows: readonly TraceRow[], stored: ReadonlySet<string>): RowChains {
  const [chains, setChains] = useKeptChains();
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const has = useRef(chains);
  has.current = chains;
  const loaded = useRef(new Map<string, string>());
  // The rows whose load hasn't answered: not asked again until it has.
  const asking = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const wanted = rows.filter((row) => stored.has(row.trace.id)).map((row) => row.trace);
  const key = wanted.map(rowKey).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` says which rows and what they hold.
  useEffect(() => {
    const load = source.chain;
    if (!load) return;
    const timers = new Set<number>();
    // Kept with when it was asked for (`at`): the same chain again moves its time on while a call of it was still
    // waited for then, its calls judged as of it (asOf), never by a later clock with an older chain.
    const keep = (id: string, chain: Chain, at: number) =>
      setChains((current) => {
        const before = current.get(id);
        if (before && chainKey(before) === chainKey(chain) && waitingUntil(before, asOf(before)) === null)
          return current;
        return new Map(current).set(id, { ...chain, asOf: at });
      });
    const done = (id: string) =>
      setLoading((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    const tick = () => {
      const now = Date.now();
      for (const trace of wanted) {
        if (asking.current.has(trace.id)) continue;
        const fresh = now - (trace.start + trace.duration) / 1000 < CHAIN_FRESH_MS;
        // A call of it still waited for (one cut short is, for minutes): its trace may come any time.
        const chain = has.current.get(trace.id);
        const awaited = chain !== undefined && waitingUntil(chain, asOf(chain)) !== null;
        if (loaded.current.get(trace.id) === rowKey(trace) && !fresh && !awaited) continue;
        loaded.current.set(trace.id, rowKey(trace));
        // Its first load: placeholders under the row once it is slow, so the list says something is on its way.
        const first = !has.current.has(trace.id);
        const timer = first
          ? window.setTimeout(
              () => mounted.current && setLoading((current) => new Set(current).add(trace.id)),
              CHAIN_SLOW_MS,
            )
          : undefined;
        if (timer !== undefined) timers.add(timer);
        asking.current.add(trace.id);
        const at = Date.now();
        const settle = () => {
          asking.current.delete(trace.id);
          window.clearTimeout(timer);
          if (timer !== undefined) timers.delete(timer);
          if (mounted.current) done(trace.id);
        };
        load(trace.id).then(
          (chain) => {
            if (mounted.current) keep(trace.id, chain, at);
            settle();
          },
          () => {
            // No chain to say more (the trace rotated out, the agent can't): its own numbers are all there are.
            if (mounted.current)
              setFailed((current) => (current.has(trace.id) ? current : new Set(current).add(trace.id)));
            settle();
          },
        );
      }
    };
    tick();
    const timer = window.setInterval(() => document.visibilityState === "visible" && tick(), CHAIN_POLL_MS);
    return () => {
      window.clearInterval(timer);
      for (const each of timers) window.clearTimeout(each);
    };
  }, [key]);
  const listed = rows.map((row) => row.trace.id).join(",");
  const pages = rows
    .filter((row) => row.trace.kind === "page")
    .map((row) => row.trace.id)
    .join(",");
  // Built as of when each chain was asked for (asOf): its waiting calls go once a chain asked for after they stopped
  // being waited for says no trace came.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `listed` and `pages` say which rows there are.
  const { apps, calls, counters } = useMemo(() => {
    const rowsIn = new Set(listed.split(","));
    const views = new Set(pages.split(","));
    const apps = new Map<string, ChainEntry[]>();
    const calls = new Map<string, ChainCall[]>();
    const counters = new Map<string, Counter>();
    for (const [id, chain] of chains) {
      if (!rowsIn.has(id)) continue;
      // A view's or an action's calls are its rows, one each, as they were in flight (chainCalls).
      if (views.has(id)) {
        calls.set(id, chainCalls(chain, id, rowsIn, asOf(chain)));
        const row = rows.find((each) => each.trace.id === id)?.trace;
        // Loaded again while it is new (CHAIN_FRESH_MS), as the loads above have it.
        const fresh = () => row !== undefined && Date.now() - (row.start + row.duration) / 1000 < CHAIN_FRESH_MS;
        counters.set(id, chainCounter(chain, id, rowsIn, { chains, fresh }));
        continue;
      }
      const under = chainApps(chain, id, rowsIn, asOf(chain));
      if (under.length > 0) apps.set(id, under);
    }
    return { apps, calls, counters };
  }, [chains, listed, pages]);
  const counts = useMemo(() => countsOf(chains), [chains]);
  const cut = useMemo(() => cutsOf(chains), [chains]);
  const settled = useMemo(() => (source.chain ? new Set([...chains.keys(), ...failed]) : undefined), [chains, failed]);
  return { apps, calls, counters, loading, counts, settled, cut };
}

// The rows the user folded or opened, each a change from where it starts (an app's row open, a run open while its
// app has few traces); a new key, as the old one held the rows opened when an app's row started folded.
const CHAIN_OPEN_KEY = "tracepanel:chain-toggled";

/** The chain rows open in the list: kept for the browser tab's session, as the panel reloads with each page. */
export function useChainOpen(): [ReadonlySet<string>, (key: string) => void] {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    const saved = readJson(CHAIN_OPEN_KEY, "sessionStorage");
    return new Set(Array.isArray(saved) ? saved.filter((each) => typeof each === "string") : []);
  });
  const toggle = useCallback((key: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      writeItem(CHAIN_OPEN_KEY, JSON.stringify([...next]), "sessionStorage");
      return next;
    });
  }, []);
  return [open, toggle];
}
