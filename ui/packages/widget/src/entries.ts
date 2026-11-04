import { REDIRECT_MS } from "@tracepanel/ui/lib/page";
import type { EntrySummary, TabEntry } from "@tracepanel/ui/lib/tabEntry";
import type { UntracedCall } from "./card";
import type { PageAnnouncement, TraceInfo } from "./index";
import type { Flight } from "./network";
import { type Counted, flightInfo, title } from "./pill";
import type { ChainFacts } from "./viewChain";

/**
 * The tab's list with this view or action in it: a new row (an empty view of the same page leaves, and so does a view
 * the SPA redirected from at once, the new one saying so), or its own updated. `load`: the page's first view.
 */
export function withPage(
  tab: TabEntry[],
  announced: PageAnnouncement,
  load: string | null,
  called: ReadonlySet<string>,
): TabEntry[] {
  const entry = pageEntry(announced);
  const at = tab.findIndex((item) => item.id === announced.id);
  if (at === -1) return foldRedirect(dropEmptyView(tab, announced.name, called), entry, { load, called });
  const from = tab[at]?.summary?.redirectedFrom;
  if (from && entry.summary) entry.summary.redirectedFrom = from;
  return tab.map((item, index) => (index === at ? entry : item));
}

/**
 * A new view after one the SPA redirected from at once: that one leaves the list, the new one says where it came from
 * (the first of a chain of redirects). Such a view ended, made no call and failed nothing, and the new one started
 * as it ended, within REDIRECT_MS of its start; the page's load (`load`, which has the load's time) and a view that
 * did anything stay.
 * The agent folds it in the store by the same measure.
 */
function foldRedirect(
  tab: TabEntry[],
  entry: TabEntry,
  { load, called }: { load: string | null; called: ReadonlySet<string> },
): TabEntry[] {
  const last = tab.at(-1);
  const before = last?.summary;
  const next = entry.summary;
  if (!(last && before && next && isView(last) && isView(entry) && last.id !== load)) return [...tab, entry];
  const empty = !(before.open || before.failed) && !madeCalls(tab, last.id, called);
  const atOnce = next.start - before.start <= REDIRECT_MS * 1000 && before.start + before.duration <= next.start;
  if (!(empty && atOnce)) return [...tab, entry];
  next.redirectedFrom = before.redirectedFrom ?? before.name;
  return [...tab.slice(0, -1), entry];
}

/** A view or an action as the tab's list has it: a row of its own, running while open. */
function pageEntry(announced: PageAnnouncement): TabEntry {
  return {
    id: announced.id,
    parent: null,
    summary: {
      name: announced.name,
      status: null,
      start: announced.start,
      duration: announced.duration,
      queries: 0,
      issues: 0,
      kind: "page",
      failed: announced.status === "error",
      open: announced.open || undefined,
    },
  };
}

/**
 * A request's numbers by what its chain says (`facts`): pending while it isn't counted yet (undefined), its findings
 * with them; its own where it called no app or the console can't say ("own"); else its whole chain's.
 */
export function countedBy(info: TraceInfo, facts: ChainFacts | "own" | undefined): Counted {
  if (facts === undefined || (facts !== "own" && facts.counts === null)) return { queries: null, issues: 0 };
  if (facts === "own" || facts.counts === null || facts.counts.traces < 2) return ownCounts(info);
  return { queries: facts.counts.queries, issues: facts.counts.issues };
}

/** A request's own numbers, as its Server-Timing says them. */
function ownCounts(info: TraceInfo): Counted {
  return { queries: info.queries ?? 0, issues: info.issues ?? 0 };
}

/** A request in flight as the panel lists it: under this page, its time ticking, until its answer names its trace. */
export function flightEntry(flight: Flight, parent: string | null): TabEntry {
  return {
    id: flight.id,
    parent,
    summary: {
      name: title(flightInfo(flight)),
      status: null,
      start: flight.start * 1000,
      duration: 0,
      queries: 0,
      issues: 0,
      open: true,
      host: hostOf(flight.url),
      span: flight.span,
    },
  };
}

export function summaryOf(info: TraceInfo): EntrySummary {
  const duration = Math.round((info.totalMs ?? 0) * 1000);
  // A request that flew starts where the page made it (a queued one before its server saw it); else it just ended.
  const clock = info.clock && { start: info.clock.start * 1000, end: info.clock.end * 1000 };
  return {
    name: title(info),
    status: info.status ?? null,
    start: clock?.start ?? Date.now() * 1000 - duration,
    duration,
    queries: info.queries ?? 0,
    issues: info.issues ?? 0,
    htmx: info.htmx,
    key: info.flight,
    host: hostOf(info.url),
    clock,
    span: info.span,
  };
}

/** The host a URL names, with its port ("127.0.0.1:8043"); none for no URL. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, location.href).host;
  } catch {
    return undefined;
  }
}

/**
 * A call that answered untraced (Answer), as the panel lists it under the view or action that made it: its name, its
 * status, its time; its numbers come with the view's trace.
 */
export function landedEntry(call: Landed): TabEntry {
  const end = call.flight.end ?? call.end;
  return {
    id: call.flight.id,
    parent: call.parent,
    summary: {
      name: title(flightInfo(call.flight)),
      status: call.status ?? null,
      start: call.flight.start * 1000,
      duration: Math.max(0, end - call.flight.start) * 1000,
      queries: 0,
      issues: 0,
      failed: call.status === undefined || call.status >= 500,
      untraced: true,
      host: hostOf(call.flight.url),
      clock: { start: call.flight.start * 1000, end: end * 1000 },
      span: call.flight.span,
    },
  };
}

/** A call that answered untraced or not at all, as the hover card lists it among the page's other requests. */
export function untracedCall(call: Landed): UntracedCall {
  const end = call.flight.end ?? call.end;
  return {
    info: { ...flightInfo(call.flight), status: call.status, totalMs: Math.max(0, end - call.flight.start) },
    parent: call.parent,
    failed: call.status === undefined,
  };
}

/** A call of a view or an action that answered untraced: where it is listed, when it ended (epoch ms), its status. */
export interface Landed {
  flight: Flight;
  parent: string;
  end: number;
  status: number | undefined;
}

/** How long a call that answered untraced stays listed after it ended, its view closed: its trace has it by then. */
export const LANDED_KEEP_MS = 120_000;

/** The most of them kept. */
export const LANDED_MAX = 200;

/** A view's name has no action after its path: "/books", not "/books › click "Save"". */
function isView(entry: TabEntry | undefined): boolean {
  return entry?.summary?.kind === "page" && !entry.summary.name.includes(" › ");
}

/** Whether an entry is a view of the page `name` (a view, not an action on it). */
function isViewOf(entry: TabEntry, name: string): boolean {
  return isView(entry) && entry.summary?.name === name;
}

/**
 * Whether a view or an action made calls: a traced request under it, or one that answered untraced or flies still
 * (`called`: those that made such calls, which the tab doesn't list).
 */
function madeCalls(tab: readonly TabEntry[], id: string, called: ReadonlySet<string>): boolean {
  return called.has(id) || tab.some((item) => item.parent === id);
}

/**
 * Before a new view goes in: the last one, when it is of the same page and nothing came after it (no request, no
 * action), leaves the list. Reloads of an SPA's page would otherwise stack views with nothing under them. A route
 * change is a view of another page: it goes in after the last one, which stays, with or without requests.
 */
function dropEmptyView(tab: TabEntry[], name: string, called: ReadonlySet<string>): TabEntry[] {
  const last = tab.at(-1);
  if (last && isViewOf(last, name) && !madeCalls(tab, last.id, called)) return tab.slice(0, -1);
  return tab;
}
