import {
  type Chain,
  type ChainCall,
  type ChainEntry,
  callsCounted,
  type ServiceMap,
  type TraceRow,
  type TraceSummary,
  waitingSummary,
} from "@tracepanel/ui";
import { type ChainCounts, chainCounts } from "@tracepanel/ui/lib/chainCounts";
import { chainCutAt } from "@tracepanel/ui/lib/live";
import { traceRuntime } from "@tracepanel/ui/lib/runtime";
import type { TabHistory } from "./hooks";
import { arrivingIn, inFlight, madeAt } from "./panelRows";

/**
 * A row's chain without its calls cut short (no answer yet) while the page still waits for a request of its own: that
 * request's row, in flight under it, is the same call, said once (lib/live).
 */
export function withoutFlying(
  apps: ReadonlyMap<string, ChainEntry[]>,
  history: TabHistory | null,
): ReadonlyMap<string, ChainEntry[]> {
  const waiting = new Set(
    (history?.entries ?? []).filter((entry) => entry.summary?.open && inFlight(entry.id)).map((entry) => entry.parent),
  );
  if (waiting.size === 0) return apps;
  return new Map(
    [...apps].map(([id, entries]) => [
      id,
      waiting.has(id) ? entries.filter((entry) => entry.type !== "waiting" || entry.cut === null) : entries,
    ]),
  );
}

/** A view's call, as its row: its place (when it started, µs) and the row. */
type Placed = { at: number; row: TraceRow };

/** When a call started (µs): the call's own start, not its trace's. */
function callStart(call: ChainCall): number {
  return call.type === "trace" ? call.called : call.start;
}

/** When a call ended (µs), as the view's trace has it. */
function callEnd(call: ChainCall): number {
  return call.type === "trace" ? (call.ended ?? call.called + call.summary.duration) : call.end;
}

/** When a row the widget listed ended (µs): its answer, or now for one still in flight. */
function flightEnd(flight: TraceRow): number {
  return flight.open ? Date.now() * 1000 : flight.trace.start + flight.trace.duration;
}

/** What a call is named by, to match its row in flight: its GraphQL operation, else its method. */
function callName(name: string): string {
  return name.startsWith("GraphQL ") ? name : (name.split(" ")[0] ?? "");
}

/** How far apart (µs) a call's start in the browser's trace and in the widget can be to be the same call. */
const SAME_CALL_US = 3_000_000;

/**
 * The widget's row each of a view's calls was in flight (`flights`, "~…"): the same call, by the span id its
 * traceparent carried where the widget saw it; else the same name and the nearest start and end, as the browser timed
 * both (calls made at once, the browser queueing some, start together and end apart). A call keeps that row's
 * identity (its key) as its chain's row takes over, never another call's.
 */
function matchFlights(calls: readonly ChainCall[], flights: readonly TraceRow[]): Map<string, TraceRow> {
  const matched = bySpan(calls, flights);
  const taken = new Set(matched.values());
  const free = new Set(flights.filter((flight) => !taken.has(flight)));
  for (const call of [...calls].sort((a, b) => callStart(a) - callStart(b) || callEnd(a) - callEnd(b))) {
    if (matched.has(call.key)) continue;
    const best = nearest(call, free);
    if (!best) continue;
    free.delete(best);
    matched.set(call.key, best);
  }
  return matched;
}

/** Each call whose span id a row the widget listed carries: that row, by the call's key. */
function bySpan(calls: readonly ChainCall[], flights: readonly TraceRow[]): Map<string, TraceRow> {
  const rows = new Map(flights.flatMap((flight) => (flight.span ? [[flight.span, flight] as const] : [])));
  return new Map(
    calls.flatMap((call) => {
      const flight = call.w3c ? rows.get(call.w3c) : undefined;
      return flight ? [[call.key, flight] as const] : [];
    }),
  );
}

/**
 * The free row nearest a call by when it started and ended, of its name and within SAME_CALL_US of its start; a row
 * whose span id the widget knows is another call's when the call has one too.
 */
function nearest(call: ChainCall, free: ReadonlySet<TraceRow>): TraceRow | undefined {
  const name = callName(call.type === "trace" ? call.summary.name : waitingSummary(call).name);
  const apart = (flight: TraceRow) =>
    Math.abs(flight.trace.start - callStart(call)) + Math.abs(flightEnd(flight) - callEnd(call));
  const same = [...free].filter(
    (flight) =>
      !(flight.span && call.w3c) &&
      callName(flight.trace.name) === name &&
      Math.abs(flight.trace.start - callStart(call)) <= SAME_CALL_US,
  );
  return same.reduce<TraceRow | undefined>(
    (best, flight) => (!best || apart(flight) < apart(best) ? flight : best),
    undefined,
  );
}

/** A view's call as a row of the list, one step under its view, the same row as it was in flight. */
function callRow(call: ChainCall, view: string, flight: TraceRow | undefined): TraceRow {
  const key = flight?.key ?? flight?.trace.id ?? call.key;
  // The host its row was grouped by in flight, so its group stays the same row.
  const host = flight?.host ?? call.host;
  const to = host ? { host } : {};
  // The time its row said once answered (the widget's clock): never less now, the view's trace timing it a hair apart.
  const said = flight && !flight.open ? flight.trace.duration : 0;
  if (call.type === "trace") {
    const runtime = traceRuntime(call.trace.attrs);
    const ended = call.ended ?? call.called + call.summary.duration;
    // Its time as the view made the call, as its row said in flight: the trace that served it says its own.
    const trace = { ...call.summary, duration: Math.max(ended - call.called, said) };
    return {
      trace,
      depth: 1,
      key,
      call: "trace",
      counted: true,
      folded: true,
      ...to,
      runtime,
      clock: clockOf(call, flight, trace.duration),
    };
  }
  const summary = waitingSummary(call);
  // Its status as its answer said it, when the span doesn't.
  const status = summary.http_status ?? (call.cut === null ? (flight?.trace.http_status ?? null) : null);
  const duration = call.cut === null ? Math.max(summary.duration, said) : summary.duration;
  // biome-ignore lint/style/useNamingConvention: wire format.
  const trace = { ...summary, duration, http_status: status };
  const clock = call.cut === null ? { clock: clockOf(call, flight, duration) } : {};
  const state =
    call.failed !== undefined
      ? { call: "failed" as const, failed: call.failed }
      : call.untraced
        ? { call: "untraced" as const, host: call.untraced }
        : { call: "waiting" as const };
  return { trace, depth: 1, key, opens: view, cut: call.cut, ...to, ...clock, ...state };
}

/**
 * A view's call on its group's clock: from when its row started in flight (the widget's clock, as its group's time
 * ran then), else the view's trace's, for as long as its row says. Its group's time never drops as the view's trace
 * times its calls a hair apart from the widget.
 */
function clockOf(call: ChainCall, flight: TraceRow | undefined, duration: number): { start: number; end: number } {
  const start = flight?.trace.start ?? callStart(call);
  return { start, end: start + duration };
}

/**
 * The list with each view's calls from its chain (chainCalls), once it loaded: in place of the widget's rows of them
 * (in flight "~…", or answered untraced), each in its row's place, keeping its key; a call still in flight keeps its
 * running row. The rows under each call (what its trace called) by its trace's id, in `apps`.
 */
export function withViewCalls(
  rows: readonly TraceRow[],
  { calls, counters }: Pick<RowChains, "calls" | "counters">,
  apps: ReadonlyMap<string, ChainEntry[]>,
  { settled, known }: Pick<Grouping, "settled" | "known">,
): { rows: TraceRow[]; apps: ReadonlyMap<string, ChainEntry[]> } {
  const under = new Map(apps);
  const out: TraceRow[] = [];
  let at = 0;
  while (at < rows.length) {
    const head = rows[at] as TraceRow;
    let end = at + 1;
    while (end < rows.length && (rows[end] as TraceRow).depth) end += 1;
    const children = rows.slice(at + 1, end);
    const own = calls.get(head.trace.id);
    const placed = own ? placeCalls(head.trace.id, own, children, under) : children;
    const view = head.trace.id;
    const grouping = { view, settled, known, counter: counters.get(view), loaded: loadedIn(settled, view) };
    if (head.trace.kind === "page")
      out.push(own ? awaiting(head, placed, grouping) : head, ...byHost(placed, grouping));
    else out.push(head, ...placed);
    at = end;
  }
  return { rows: out, apps: under };
}

/** Whether a row's chain has loaded (or can't, or chains don't load): the numbers it doesn't count are their own. */
function loadedIn(settled: ReadonlySet<string> | undefined, id: string): boolean {
  return settled === undefined || settled.has(id);
}

/**
 * A view's row, its numbers pending (its time as it is) while one of its calls' are, or its chain doesn't count all
 * of its calls' traces yet: its whole chain's numbers then, never a part of them that grows.
 */
function awaiting(head: TraceRow, placed: readonly TraceRow[], grouping: Grouping): TraceRow {
  // Its calls: not a task run one of them led to, nor the page's own load (its document), no call of the view's.
  const calls = placed.filter((row) => !(row.run || row.loadHost));
  const { settled } = grouping;
  const pending = calls.some(
    (call) =>
      call.open ||
      call.call === "waiting" ||
      !(call.counted || call.call === "untraced" || call.failed !== undefined || settled?.has(call.trace.id) !== false),
  );
  return pending || !together(calls, grouping).known ? { ...head, awaiting: true } : head;
}

/** A view's rows under it with its calls from its chain in the widget's rows' places, in the order they started. */
function placeCalls(
  view: string,
  calls: readonly ChainCall[],
  children: readonly TraceRow[],
  under: Map<string, ChainEntry[]>,
): TraceRow[] {
  const flights = children.filter((row) => row.trace.id.startsWith("~"));
  const matched = matchFlights(calls, flights);
  const running = new Set(flights.filter((row) => row.open));
  const placed: Placed[] = children
    .filter((row) => !row.trace.id.startsWith("~") || running.has(row))
    .map((row) => ({ at: row.trace.start, row }));
  for (const call of calls) {
    const flight = matched.get(call.key);
    // Still in flight in the widget (cut short in the view's trace): its running row says it.
    if (flight && running.has(flight)) continue;
    if (call.type === "trace" && call.apps.length > 0) under.set(call.id, call.apps);
    // In the place its row had: by when the widget saw it start.
    placed.push({ at: flight?.trace.start ?? callStart(call), row: callRow(call, view, flight) });
  }
  const made = (row: TraceRow) => madeAt(row.key ?? row.trace.id);
  return placed.sort((a, b) => a.at - b.at || made(a.row) - made(b.row)).map((each) => each.row);
}

/**
 * A view's calls with those to one host (two or more) under one row (TraceRow.group), where the first of them is,
 * from in flight on: the row is named by the host until a trace of theirs names the app ("graphql-router ×5"), and
 * the calls stay its rows, in their order, as they fill in. A task run stays under the request it came from.
 */
function byHost(rows: readonly TraceRow[], grouping: Grouping): TraceRow[] {
  const units = unitsOf(rows);
  const hosts = new Map<string, TraceRow[][]>();
  for (const unit of units) {
    const host = unit[0]?.host ?? "";
    hosts.set(host, [...(hosts.get(host) ?? []), unit]);
  }
  const out: TraceRow[] = [];
  for (const unit of units) {
    const host = unit[0]?.host ?? "";
    const members = hosts.get(host) ?? [];
    if (!host || members.length < 2) out.push(...unit);
    // Where the first of them is, once.
    else if (members[0] === unit) out.push(...grouped(host, members, grouping));
  }
  return out;
}

/** Each request with the task runs it led to after it: they stay together. */
function unitsOf(rows: readonly TraceRow[]): TraceRow[][] {
  const units: TraceRow[][] = [];
  for (const row of rows) {
    const last = units.at(-1);
    if (row.run && last) last.push(row);
    else units.push([row]);
  }
  return units;
}

/** A host's calls under their row, a step deeper. */
function grouped(host: string, members: readonly TraceRow[][], grouping: Grouping): TraceRow[] {
  const calls = members.map((each) => each[0] as TraceRow);
  const group = groupRow(host, calls, grouping);
  return [group, ...members.flat().map((row) => ({ ...row, depth: 2 as const }))];
}

/**
 * What some of a view's calls' traces did, as its chain counts it; "later" while one of them, of the view's trace
 * (W3C), isn't its chain's yet and the chain still loads again; null when one of them won't be its chain's.
 */
export type Counter = (ids: readonly string[]) => ChainCounts | "later" | null;

/** The app a host's calls were served by before (useKnownApps), and what it runs on. */
export type KnownApp = { app: string; runtime: string | undefined };

/**
 * What a view's calls are grouped with: the view, the rows whose numbers are known, its chain's counts, and the app
 * each host was served by before.
 */
interface Grouping {
  view: string;
  settled: ReadonlySet<string> | undefined;
  counter: Counter | undefined;
  known: ReadonlyMap<string, KnownApp>;
  /** Its chain has loaded once, or can't: where it has no counter, its calls' own numbers are all there are. */
  loaded: boolean;
}

/** A call answered by a trace of its own: its chain's row, or the list's (an app with an SDK named it). */
function ownTrace(call: TraceRow): boolean {
  return call.call === "trace" || !(call.call || call.open || inFlight(call.trace.id));
}

/**
 * What a group's calls did: as the view's chain counts their traces and all under them, once it has them all (a
 * finding of the chain's across them said once, as the tabs say it), whether its chain made them its rows or they are
 * the list's own (an app with an SDK answered them: its trace's id came with the answer); their own numbers added up
 * when it won't. `known`: these are their numbers for good, never a sum the chain counts otherwise a moment later.
 */
function together(calls: readonly TraceRow[], { counter, loaded }: Pick<Grouping, "counter" | "loaded">) {
  const traced = calls.filter(ownTrace);
  const answered = calls.every((call) => ownTrace(call) || call.call === "untraced" || call.failed !== undefined);
  const counted = answered && traced.length > 0 ? counter?.(traced.map((call) => call.trace.id)) : undefined;
  if (counted && counted !== "later") {
    // biome-ignore lint/style/useNamingConvention: wire format.
    return { queries: counted.queries, issues: counted.issues, issue_kinds: counted.kinds, known: true };
  }
  const traces = calls.map((call) => call.trace);
  return {
    queries: traces.reduce((sum, trace) => sum + trace.queries, 0),
    issues: traces.reduce((sum, trace) => sum + trace.issues, 0),
    // biome-ignore lint/style/useNamingConvention: wire format.
    issue_kinds: [...new Set(traces.flatMap((trace) => trace.issue_kinds ?? []))],
    known: answered && (traced.length === 0 || (counter ? counted === null : loaded)),
  };
}

/** The app most of a group's calls' traces name, once any does. */
function appOf(calls: readonly TraceRow[]): string | null {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const traced = call.call === "trace" || !(call.call || inFlight(call.trace.id));
    if (traced && call.trace.service) counts.set(call.trace.service, (counts.get(call.trace.service) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** The row over a view's calls to one host: their time on the clock, what they did, together. */
function groupRow(
  host: string,
  calls: readonly TraceRow[],
  { view, settled, counter, known, loaded }: Grouping,
): TraceRow {
  const traces = calls.map((call) => call.trace);
  // The calls' own times, as the browser made them: in flight, answered and stored alike.
  const clocks = calls.map(
    (call) => call.clock ?? { start: call.trace.start, end: call.trace.start + call.trace.duration },
  );
  const start = Math.min(...clocks.map((clock) => clock.start));
  const end = Math.max(...clocks.map((clock) => clock.end));
  // Their traces' app once one came (it wins); before, the app that host was served by last.
  const served = appOf(calls);
  const before = served === null ? known.get(host) : undefined;
  const app = served ?? before?.app ?? null;
  const id = `${view}/calls/${host}`;
  const { known: said, ...numbers } = together(calls, { counter, loaded });
  const summary: TraceSummary = {
    ...(traces[0] as TraceSummary),
    id,
    service: app ?? "",
    name: app ?? host,
    start,
    duration: end - start,
    status: traces.some((trace) => trace.status === "error") ? "error" : "ok",
    // biome-ignore lint/style/useNamingConvention: wire format.
    http_status: null,
    ...numbers,
  };
  const runtime = calls.find((call) => call.runtime && call.trace.service === app)?.runtime ?? before?.runtime;
  return {
    trace: summary,
    depth: 1,
    key: id,
    group: {
      view,
      host,
      app,
      count: calls.length,
      ...(runtime ? { runtime } : {}),
      ...(calls.every((call) => call.call === "untraced" || call.failed !== undefined) ? { untraced: true } : {}),
    },
    ...(calls.some((call) => call.open) ? { open: true } : {}),
    // A call no trace answered has no numbers to wait for: its group's are known without it. Theirs added up are
    // never said while the view's chain may still count them (a finding they share once).
    counted:
      said &&
      calls.every(
        (call) =>
          call.counted || call.call === "untraced" || call.failed !== undefined || settled?.has(call.trace.id) === true,
      ),
  };
}

/**
 * The apps known to serve each host, with the page's own load's: the host that served the page's document is its
 * trace's app's (a Next app that served /docs serves the /openapi.json its view asked for), as a service map's link
 * names the app a host's calls reached. Its runtime is the page's, as the pill says it.
 */
export function withLoads(
  known: ReadonlyMap<string, KnownApp>,
  rows: readonly TraceRow[],
  runtime: string | undefined,
): ReadonlyMap<string, KnownApp> {
  const loads = rows.filter((row) => row.loadHost && row.trace.service);
  if (loads.length === 0) return known;
  const out = new Map(known);
  for (const row of loads) out.set(row.loadHost as string, { app: row.trace.service, runtime });
  return out;
}

/** Each HTTP host's app in a service map: the one seen last where several served it. */
export function knownApps(map: ServiceMap): ReadonlyMap<string, KnownApp> {
  const apps = new Map(map.apps.map((app) => [app.service, app]));
  const known = new Map<string, KnownApp & { seen: number }>();
  for (const link of map.links) {
    const host = /^http:[a-z]+\/(.+)$/.exec(link.peer ?? "")?.[1]?.replace(/:(80|443)$/, "");
    const app = apps.get(link.to_service);
    const seen = app?.last_seen ?? 0;
    if (!host || (known.get(host)?.seen ?? -1) >= seen) continue;
    known.set(host, { app: link.to_service, runtime: app?.runtime ?? undefined, seen });
  }
  return known;
}

/**
 * The rows whose numbers are known: their chain loaded (or can't be), or a row the agent doesn't have and won't any
 * more (not stored, not on its way): its own numbers are all there are, never "…" for good. Undefined where chains
 * don't load.
 */
export function settledIn(
  loaded: ReadonlySet<string> | undefined,
  rows: readonly TraceRow[],
  stored: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  if (!loaded) return undefined;
  const gone = rows.filter(
    (row) => !(stored.has(row.trace.id) || inFlight(row.trace.id) || arrivingIn(rows, stored, row.trace.id)),
  );
  return gone.length === 0 ? loaded : new Set([...loaded, ...gone.map((row) => row.trace.id)]);
}

/** Each chain's counts, by its row's trace id. */
export function countsOf(chains: ReadonlyMap<string, Chain>): ReadonlyMap<string, ChainCounts> {
  const counts = new Map<string, ChainCounts>();
  for (const [id, chain] of chains) {
    const counted = chainCounts(chain);
    if (counted) counts.set(id, counted);
  }
  return counts;
}

/** Where each row's own trace was cut, for those that were. */
export function cutsOf(chains: ReadonlyMap<string, Chain>): ReadonlyMap<string, number> {
  const cuts = new Map<string, number>();
  for (const [id, chain] of chains) {
    const at = chainCutAt(chain);
    if (at !== null) cuts.set(id, at);
  }
  return cuts;
}

/**
 * What some of a view's calls' traces did, as its chain counts it (Counter): "later" while one of them is of the
 * view's trace, as its own chain (`chains`) says, and the view's chain is loaded again (`fresh`): it comes with it.
 */
export function chainCounter(
  chain: Chain,
  view: string,
  listed: ReadonlySet<string>,
  { chains, fresh }: { chains: ReadonlyMap<string, Chain>; fresh: () => boolean },
): Counter {
  const known = new Set(chain.traces.map((each) => each.id));
  const w3c = w3cOf(chain, view);
  return (ids) => {
    if (ids.every((each) => known.has(each))) return callsCounted(chain, view, listed, ids);
    const coming = ids.some((each) => !known.has(each) && w3c !== undefined && w3cOf(chains.get(each), each) === w3c);
    return coming && fresh() ? "later" : null;
  };
}

/** The W3C trace a trace of a chain was part of, as its trace says. */
function w3cOf(chain: Chain | undefined, id: string): string | undefined {
  const value = chain?.traces.find((each) => each.id === id)?.trace?.attrs?.["w3c.trace_id"];
  return typeof value === "string" ? value : undefined;
}

/** The rows under the list's rows: the apps each one's trace called, and the rows whose first load is slow. */
export interface RowChains {
  apps: ReadonlyMap<string, ChainEntry[]>;
  /** By a view's or an action's id: its calls, one row each (chainCalls), once its chain loaded. */
  calls: ReadonlyMap<string, ChainCall[]>;
  /** By a view's or an action's id: what some of its calls' traces did, as its chain counts it (callsCounted). */
  counters: ReadonlyMap<string, Counter>;
  loading: ReadonlySet<string>;
  /** What each row's whole chain did, as the pill and the trace's tabs count it: the row says the same. */
  counts: ReadonlyMap<string, ChainCounts>;
  /** The rows whose chain has loaded once: the others' numbers are pending. Undefined where chains don't load. */
  settled: ReadonlySet<string> | undefined;
  /** Where each row's trace was cut with a call still unanswered (lib/live). */
  cut: ReadonlyMap<string, number>;
}
