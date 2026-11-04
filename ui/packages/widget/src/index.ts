import TOKENS from "virtual:tracepanel-tokens";
import type { ChainCounts } from "@tracepanel/ui/lib/chainCounts";
import { clockOf, runningLabel, TICK_MS } from "@tracepanel/ui/lib/live";
import { plural } from "@tracepanel/ui/lib/plural";
import {
  BROWSER_ICON_SVG,
  type RuntimeMark,
  runtimeKind,
  runtimeMark,
  runtimeName,
  traceRuntime,
} from "@tracepanel/ui/lib/runtime";
import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import type { EntrySummary, HtmxInfo, TabEntry } from "@tracepanel/ui/lib/tabEntry";
import { CARD_STYLE, mountCard } from "./card";
import {
  countedBy,
  flightEntry,
  LANDED_KEEP_MS,
  LANDED_MAX,
  type Landed,
  landedEntry,
  summaryOf,
  untracedCall,
  withPage,
} from "./entries";
import {
  type Answer,
  type Flight,
  flying,
  listen,
  nativeFetch,
  PENDING_ISSUES,
  pending,
  query,
  setWatcher,
  waitedMs,
} from "./network";
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  type Dock,
  learnedRuntime,
  learnRuntime,
  loadPanel,
  loadTab,
  MIN_HEIGHT,
  MIN_WIDTH,
  type PanelState,
  savePanel,
  saveTab,
  withRedirects,
} from "./persist";
import {
  addCalls,
  addFlight,
  addIssues,
  addName,
  addNoAnswer,
  addPage,
  addQueries,
  addRequest,
  addRunning,
  addTime,
  type Counted,
  pillLabel,
  segment,
  tasksPart,
  verdict,
} from "./pill";
import { STYLE } from "./style";
import { type ChainFacts, factsKey, followChain } from "./viewChain";

export interface TraceInfo {
  /** The trace's own name when it says more than the request line (a GraphQL operation). */
  name?: string | undefined;
  method?: string | undefined;
  url?: string | undefined;
  status?: number | undefined;
  trace?: string | undefined;
  totalMs?: number | undefined;
  dbMs?: number | undefined;
  queries?: number | undefined;
  /** Issues tracepanel detected in the request: N+1, duplicates, slow SQL, errors. */
  issues?: number | undefined;
  /** Issues not known when the response went out (the agent finds them): the widget asks the console. */
  issuesPending?: boolean | undefined;
  /** Issues the task runs it led to found, apart from its own: asked from the console as the workers record them. */
  taskIssues?: number | undefined;
  /** How many of those task runs failed, asked with them. */
  taskFailed?: number | undefined;
  /** Sent by htmx: what triggered it and where the answer goes. */
  htmx?: HtmxInfo | undefined;
  /** The page's view or the action on it that made the call, as tracepanel-js records them in the browser. */
  page?: string | undefined;
  /** The widget's id of the request while it flew ("~…"): its row in the panel's list keeps it as its key. */
  flight?: string | undefined;
  /**
   * When the page made it and when its answer came (epoch ms), as the browser timed it: the time the page waited for
   * it, a call the browser queued behind others included. Its time is never less (waitedMs).
   */
  clock?: { start: number; end: number } | undefined;
  /** The W3C span id the call carried on (its traceparent), as the browser recording sent it: the call's identity. */
  span?: string | undefined;
}

/** A view or an action tracepanel-js records in the browser, as it announces them (tracepanel:page). */
export interface PageAnnouncement {
  id: string;
  name: string;
  start: number;
  duration: number;
  status: "ok" | "error";
  open: boolean;
}

// The views and actions it announced before the widget listened.
const ANNOUNCED = Symbol.for("tracepanel.pages");

/** Each view and action the browser recording announces: those before the widget listened, then each as it comes. */
function followPages(onPage: (announced: PageAnnouncement) => void): void {
  for (const item of announcedPages()) onPage(item);
  window.addEventListener("tracepanel:page", (event) => onPage((event as CustomEvent<PageAnnouncement>).detail));
}

/**
 * Before the page's first request: its own view, as the browser recording timed it (the SPA's counterpart of a
 * server page's load). While it is open, its time so far, ticking, by the ring every running thing turns (lib/live);
 * its numbers pending until its chain is counted; cut with a call unanswered, "no answer yet".
 */
function addView(
  parent: HTMLElement,
  view: PageAnnouncement,
  facts: ChainFacts | null,
  until: number | undefined,
): void {
  addName(parent, { name: `VIEW ${view.name}` }, false);
  if (view.open) addRunning(parent, view.start / 1000, until);
  else addEnded(parent, view, facts);
}

/** An ended view: its time (where it was cut, "no answer yet", if it was), then what its calls did. */
function addEnded(parent: HTMLElement, view: PageAnnouncement, facts: ChainFacts | null): void {
  const cut = facts?.cut ?? null;
  addTime(parent, view.duration / 1000, cut !== null);
  if (cut !== null) addNoAnswer(parent, cut);
  addChainCounts(parent, facts);
}

/** What a view's calls did in the apps they reached, as the panel's tabs count it; pending until counted. */
function addChainCounts(parent: HTMLElement, facts: ChainFacts | null): void {
  const counts = facts?.counts;
  if (!counts) {
    addQueries(parent, null);
    return;
  }
  addQueries(parent, counts.queries);
  addCalls(parent, counts.calls, counts.ownCalls);
  if (counts.issues) addIssues(parent, counts.issues, "warn");
}

/** Nothing on this page yet: its server didn't trace it and nothing records it in the browser. */
function addWaiting(parent: HTMLElement): void {
  const idle = document.createElement("span");
  idle.className = "idle";
  idle.textContent = "Waiting for requests";
  segment(parent).append(idle);
}

function idleLabel(
  view: PageAnnouncement | null,
  runtime: string | undefined,
  counts: ChainCounts | null,
  until: number | undefined,
): string {
  const shown = view
    ? `view of ${view.name}${view.open ? `, ${runningLabel(view.start, clockOf(until))}` : countsLine(counts)}`
    : "no requests yet";
  return `tracepanel: ${shown}${runtime ? `. Served by ${runtime}` : ""}`;
}

/** ": 3 queries, 19 HTTP calls, 8 issues down its calls", or ", no requests yet" before its chain is known. */
function countsLine(counts: ChainCounts | null): string {
  if (!counts) return ", no requests yet";
  const parts = [
    plural(counts.queries, "query", "queries"),
    plural(counts.calls, "HTTP call", "HTTP calls"),
    ...(counts.issues ? [plural(counts.issues, "issue", "issues")] : []),
  ];
  return `: ${parts.join(", ")} down its calls`;
}

function firstOf(...ids: (string | undefined)[]): string | null {
  return ids.find((id) => id !== undefined) ?? null;
}

/** What the browser recording announced before the widget listened, oldest first. */
function announcedPages(): PageAnnouncement[] {
  const announced = (globalThis as unknown as Record<symbol, Map<string, PageAnnouncement> | undefined>)[ANNOUNCED];
  return announced ? [...announced.values()] : [];
}

export interface WidgetOptions {
  /** Data source for the panel: an app's /__tracepanel__/ or the agent. Without it only the badge works. */
  api?: string | undefined;
  /** The request that rendered the current page. */
  initial?: TraceInfo | undefined;
  /** What served the page, e.g. "Python 3.12 · Django 6.0" or "Go 1.27 · net/http": shown in the panel. */
  runtime?: string | undefined;
}

export interface Widget {
  /** Add a request made by the page after it loaded (fetch, XHR). */
  record(info: TraceInfo): void;
  /** Open the panel; `hash` picks a screen, e.g. "#/t/<id>". */
  open(hash?: string): void;
  close(): void;
}

const THEME_KEY = "tracepanel:theme";

const DARK = "(prefers-color-scheme: dark)";

/** The panel's theme choice ("light", "dark", "system"), kept in this page's storage for the badge. */
function storeTheme(choice: string): void {
  if (choice === "light" || choice === "dark" || choice === "system") writeItem(THEME_KEY, choice);
}

/** Follows the console's theme choice (dark when there is none), or the OS when it is Auto. */

function watchTheme(host: HTMLElement): () => void {
  const apply = () => {
    const choice = readItem(THEME_KEY);
    const light = choice === "light" || (choice === "system" && !window.matchMedia(DARK).matches);
    host.dataset["theme"] = light ? "light" : "dark";
  };
  apply();
  window.matchMedia(DARK).addEventListener("change", apply);
  // Fired here when the panel (an iframe on this origin) or another tab changes the theme.
  window.addEventListener("storage", (event) => event.key === THEME_KEY && apply());
  return apply;
}

// A request in flight shows on the pill (and in the list) once it has run this long: a quick one never blinks.
const FLIGHT_SHOWN_MS = 150;

// Asking the console what the pill's request's task runs found: they run after it, in a worker, so the asks are
// spread over the next seconds, while it is still the pill's.
const RUN_ASKS_MS = [1000, 2000, 4000, 8000, 15000];

// Asking the console for a request's issues: it may not have stored the request yet.
const ISSUE_TRIES = 6;

const ISSUE_RETRY_MS = 300;

const SVG = "http://www.w3.org/2000/svg";

/** The console could not be reached from this page: asking again won't help. */
const UNREACHABLE = Symbol("unreachable");

/** A console answer's JSON: undefined while it isn't there yet (not stored), UNREACHABLE when the fetch failed. */
async function fetchJson(url: URL): Promise<unknown> {
  try {
    const response = await nativeFetch(url, { credentials: "same-origin" });
    return response.ok ? await response.json() : undefined;
  } catch {
    return UNREACHABLE;
  }
}

/** Whether to stop asking: the console is unreachable, or it answered and the answer was used. */
function settled(body: unknown, use: (body: unknown) => boolean): boolean {
  if (body === UNREACHABLE) return true;
  return body !== undefined && use(body);
}

/** `duration` in microseconds: the root span's, as the panel shows it. */
// biome-ignore lint/style/useNamingConvention: the API's field name.
type ListedTrace = { id: string; issues?: number; issue_kinds?: string[]; duration?: number; status?: string };

/** What the task runs a listed trace led to found, together: their issues counted. */
/** What a request's task runs ran into: their findings, and how many of them failed. */
function runsOf(body: unknown, id: string): { issues: number; failed: number } {
  const runs = (body as { runs?: Record<string, ListedTrace[]> } | undefined)?.runs?.[id] ?? [];
  return { issues: runs.reduce(sumIssues, 0), failed: runs.filter((run) => run.status === "error").length };
}

function sumIssues(sum: number, run: ListedTrace): number {
  return sum + (run.issues ?? 0);
}

/** One trace from a listing of traces by id, if the agent has stored it. */
function listedTrace(body: unknown, id: string | undefined): ListedTrace | undefined {
  return (body as { traces?: ListedTrace[] }).traces?.find((trace) => trace.id === id);
}

/**
 * A request's time once the agent stored it: the root span's, as the panel shows it. The header's is taken before the
 * response is sent, the span's after: near .5 ms the two would read a millisecond apart.
 */
function storedMs(row: ListedTrace, info: TraceInfo): number | undefined {
  return row.duration === undefined ? info.totalMs : waitedMs(info.clock, row.duration / 1000);
}

/**
 * A tab entry's summary with what the agent found: its issues, their kinds and the stored time; for a request that
 * flew, the time the page waited for it, which the stored time never shortens (waitedMs).
 */
function stored(summary: EntrySummary, row: ListedTrace): EntrySummary {
  const server = row.duration ?? summary.duration;
  const clock = summary.clock;
  const duration = clock ? Math.max(clock.end - clock.start, server) : server;
  return { ...summary, issues: row.issues ?? 0, kinds: row.issue_kinds, duration };
}

/**
 * What served the page, as the console's RuntimeIcon draws it: its owner's logo where allowed, the globe for the
 * browser, else our monogram; and its name. An unknown runtime keeps its language's first word.
 */
function showRuntime(element: HTMLElement, label: string | undefined): void {
  if (!label) return;
  const kind = runtimeKind(label);
  if (kind === null) {
    element.textContent = label.split(" · ")[0]?.split(" ")[0] ?? "";
    return;
  }
  element.append(runtimeElement(runtimeMark(kind)), runtimeName(kind));
}

let logoIds = 0;

/** A runtime's mark as an element, the shapes RuntimeIcon renders. */
function runtimeElement(mark: RuntimeMark): Element {
  if (mark.type === "browser") return svgOf(BROWSER_ICON_SVG);
  if (mark.type === "monogram") {
    // The console's .dt-monogram: CSS draws the letters.
    const monogram = document.createElement("span");
    monogram.className = "monogram";
    monogram.dataset["mark"] = "monogram";
    monogram.dataset["letters"] = mark.letters;
    return monogram;
  }
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.dataset["mark"] = mark.type;
  const { logo } = mark;
  logoIds += 1;
  const id = `dt-logo-${logoIds}`;
  const { cx, cy, r, stops } = logo.gradient;
  const gradient = svgElement("radialGradient", { id, cx, cy, r, gradientUnits: "userSpaceOnUse" });
  gradient.append(...stops.map(([offset, color]) => svgElement("stop", { offset, "stop-color": color })));
  const defs = svgElement("defs", {});
  defs.append(gradient);
  svg.setAttribute("viewBox", logo.viewBox);
  svg.append(defs, svgElement("path", { d: logo.path, fill: `url(#${id})` }));
  return svg;
}

function svgElement(name: string, attrs: Record<string, string | number>): Element {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function svgOf(markup: string): Element {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content.firstElementChild as Element;
}

export { type Answer, type Flight, parseServerTiming } from "./network";
export type { Counted } from "./pill";
export { flightInfo, noAnswer } from "./pill";

export function mount(options: WidgetOptions = {}): Widget {
  const host = document.createElement("tracepanel-widget");
  const root = host.attachShadow({ mode: "open" });
  const applyTheme = watchTheme(host);
  root.innerHTML = `
    <style>${TOKENS}${STYLE}${CARD_STYLE}</style>
    <div class="panel" part="panel"><div class="resize" title="Drag to resize · double-click to reset"></div></div>
    <button class="badge" part="badge" type="button" aria-expanded="false">
      <span class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><rect class="logo-1" x="3" y="6" width="26" height="5.5" rx="2.75"/><rect class="logo-2" x="9" y="13.25" width="18" height="5.5" rx="2.75"/><rect class="logo-3" x="15" y="20.5" width="10" height="5.5" rx="2.75"/></svg><span class="runtime"></span></span>
      <span class="stats"></span>
    </button>`;
  document.body.append(host);
  // A boosted link swaps the whole body (and a history restore puts back an old copy): stay on the page.
  new MutationObserver(() => {
    if (!host.isConnected) document.body.append(host);
  }).observe(document.body, { childList: true });

  const badge = query<HTMLButtonElement>(root, ".badge");
  const stats = query<HTMLElement>(root, ".stats");
  // What served the page, as the panel shows it (Django, FastAPI, Flask, Python, Go): which backend, at a glance.
  const runtimeChip = query<HTMLElement>(root, ".runtime");
  // A page its server didn't label (an SPA from a dev server): what answered this tab's first traced call.
  let runtime = learnedRuntime(options.runtime);
  showRuntime(runtimeChip, runtime);
  // This page's latest view, from the browser recording: what the pill shows before the page's first request.
  let view: PageAnnouncement | null = null;
  // The recording's first view on this page: the browser's side of its load.
  let loadView: string | null = null;
  // What each view's or request's chain says (its counts, where it was cut), once the console answered: by its id.
  // "own": the console couldn't say (unreachable, never stored): a request's own numbers are all there are.
  const chained = new Map<string, ChainFacts | "own">();
  // This page's scope (lib/live: the same in the pill, its card and the panel's list): the view of the route the SPA
  // is on and the actions done on it. A route change starts a new one: the pill no longer counts the last view's.
  const scope = new Set<string>();
  let runtimeAsked = Boolean(runtime);
  const panel = query<HTMLElement>(root, ".panel");
  const panelUrl = options.api ? new URL(options.api, location.href) : null;
  const handle = query<HTMLElement>(root, ".resize");
  let width = DEFAULT_WIDTH;
  let height = DEFAULT_HEIGHT;
  let dock: Dock = "right";

  function setWidth(value: number): void {
    width = Math.round(Math.min(Math.max(value, MIN_WIDTH), window.innerWidth - 40));
    host.style.setProperty("--tracepanel-width", `${width}px`);
    fitBadge();
  }

  /** Whether the badge fits left of the right-docked panel, measured unfolded (no paint in between). */
  function fitBadge(): void {
    host.removeAttribute("data-crowded");
    host.toggleAttribute("data-crowded", window.innerWidth - width < badge.offsetWidth + 32);
  }
  window.addEventListener("resize", fitBadge);

  // The page's own bottom padding, kept while the panel docked at the bottom takes its place, as devtools do.
  // Room under the page for the panel docked at the bottom, so its end scrolls into view above it: a block placed
  // where the page's scrolling ends. Padding or a block after the content is lost on pages whose root is as tall as
  // the window and whose content overflows it (Django's admin).
  const room = document.createElement("div");
  room.setAttribute("aria-hidden", "true");
  room.dataset["tracepanelRoom"] = "";
  room.style.cssText = "position:absolute;left:0;top:0;width:1px;margin:0;padding:0;pointer-events:none";

  /** Moves the room to where the page's own scrolling ends: measured with the room out of the way, at the top. */
  function placeRoom(): void {
    room.style.top = "0";
    room.style.top = `${document.documentElement.scrollHeight}px`;
  }

  function makeRoom(): void {
    const covering = dock === "bottom" && panel.hasAttribute("data-open");
    if (!covering) {
      room.remove();
      return;
    }
    room.style.height = `${Math.min(height, window.innerHeight)}px`;
    if (!room.isConnected) document.body.append(room);
    placeRoom();
  }

  // The page grows (a list loads more, a section opens): near its end, the room follows it.
  let placing = false;
  window.addEventListener(
    "scroll",
    () => {
      if (placing || !room.isConnected) return;
      placing = true;
      requestAnimationFrame(() => {
        placing = false;
        if (window.scrollY + window.innerHeight * 2 > document.documentElement.scrollHeight) placeRoom();
      });
    },
    { passive: true },
  );
  window.addEventListener("resize", () => room.isConnected && placeRoom(), { passive: true });

  function setHeight(value: number): void {
    height = Math.round(Math.min(Math.max(value, MIN_HEIGHT), window.innerHeight - 40));
    host.style.setProperty("--tracepanel-height", `${height}px`);
    makeRoom();
  }

  function setDock(value: Dock): void {
    dock = value;
    host.dataset["dock"] = value;
    frame?.contentWindow?.postMessage({ type: "tracepanel:dock", dock }, "*");
    makeRoom();
  }

  function panelState(): PanelState {
    return { open: panel.hasAttribute("data-open"), dock, width, height };
  }

  // The page's own request is the headline; later fetch/XHR requests are counted, not shown instead.
  // A boosted link (hx-boost) replaces it without a page load.
  let page: TraceInfo | null = options.initial?.trace ? options.initial : null;
  const later: TraceInfo[] = [];
  // The page's requests still in flight, oldest first (lib/live).
  const inFlight: Flight[] = [];
  // Where each was listed as it took off: the view or action that made it, even once another one opened.
  const listedUnder = new WeakMap<Flight, string | null>();
  // The view open as it took off: a call that got no answer has no Response for the recording to mark with it.
  const madeIn = new WeakMap<Flight, string>();
  // The calls of views and actions that answered untraced: rows until their view's trace lists them.
  let landed: Landed[] = [];
  // This page's calls that answered untraced or not at all, as many as the panel's list has rows for: the pill counts
  // them among the page's requests, as the list does, however long ago they landed, and its hover card lists them.
  let untraced: Landed[] = [];
  // Its trace was deleted from the store: the panel and the badge no longer show it.
  let pageCleared = false;
  let frame: HTMLIFrameElement | null = null;
  let tab = withRedirects(loadTab());
  const initial = page;
  if (initial?.trace && !tab.some((entry) => entry.id === initial.trace)) {
    tab = [...tab, { id: initial.trace, parent: null, summary: summaryOf(initial) }];
    saveTab(tab);
  }
  // Set while drawing the pill for a new AJAX call: its name pulses once.
  let pulse = false;

  /** The list's "this page" row: the page's own load, else its view in the browser (an SPA), as the pill shows. */
  function currentPage(): string | null {
    return firstOf(ownPage()?.trace, view?.id);
  }

  /** Whether the page's own request is part of this page still: no route change since it loaded. */
  function pageInScope(): boolean {
    return !view || view.id === loadView;
  }

  /** The page's own request (the document its server rendered) while it is this page's. */
  function ownPage(): TraceInfo | null {
    return page && !pageCleared && pageInScope() ? page : null;
  }

  /** The requests in flight the pill shows: those of this page, past a moment (a quick one never blinks). */
  function flights(): Flight[] {
    const now = Date.now();
    const since = view && !pageInScope() ? view.start / 1000 : 0;
    return inFlight.filter((flight) => flight.start >= since - 50 && now - flight.start >= FLIGHT_SHOWN_MS);
  }

  /**
   * What the panel lists: the tab's requests, the calls that answered untraced, then those in flight (the last two
   * never stored: a reload ends them). A call stays under the view or action it was made in.
   */
  function entries(): TabEntry[] {
    const current = currentPage();
    const listed = new Set(tab.map((entry) => entry.id));
    const parentOf = (flight: Flight) => {
      const at = listedUnder.get(flight);
      return at && listed.has(at) ? at : current;
    };
    return [
      ...tab.map(withQuiet),
      // Shown with those in flight, past the same moment: a quick one never comes before the calls made with it.
      ...landed
        .filter((call) => listed.has(call.parent) && Date.now() - call.flight.start >= FLIGHT_SHOWN_MS)
        .map(landedEntry),
      ...flights().map((flight) => flightEntry(flight, parentOf(flight))),
    ];
  }

  /** Where a call that takes off is listed (the page now), and the view open as it does, which made it. */
  function noteWhere(flight: Flight): void {
    listedUnder.set(flight, currentPage());
    if (view?.open) madeIn.set(flight, view.id);
  }

  /** A call that answered untraced, kept as its view's row when the browser recording made it (Answer). */
  function land(flight: Flight, answer: Answer): void {
    const parent = answer.page ?? madeIn.get(flight) ?? listedUnder.get(flight) ?? undefined;
    const recorded = tab.some((entry) => entry.id === parent && entry.summary?.kind === "page");
    if (!(parent && recorded && flight.id)) return;
    const now = Date.now();
    if (ofThisPage({ page: parent })) untraced = [...untraced, { flight, parent, end: now, status: answer.status }];
    const open = new Set(tab.filter((entry) => entry.summary?.open).map((entry) => entry.id));
    landed = [
      ...landed.filter((call) => open.has(call.parent) || now - call.end < LANDED_KEEP_MS),
      { flight, parent, end: now, status: answer.status },
    ].slice(-LANDED_MAX);
  }

  /**
   * When an open view went quiet (epoch µs): its calls have all answered, none is in flight, and it waits a moment
   * for its end, which comes with its last call's. Its time stops at that last answer, never past what it will be.
   * Undefined while a call runs, or before it made one. The page's own document, listed under the view that loaded
   * it, is no call of the view's.
   */
  function quietSince(id: string): number | undefined {
    if (inFlight.length > 0) return undefined;
    const own = page?.trace;
    const ends = [
      ...tab.flatMap((entry) =>
        entry.parent === id && entry.id !== own && entry.summary ? [answeredAt(entry.summary)] : [],
      ),
      // Its calls that answered untraced (through a gateway): their answers count as much.
      ...landed.filter((call) => call.parent === id).map((call) => (call.flight.end ?? call.end) * 1000),
    ];
    return ends.length > 0 ? Math.max(...ends) : undefined;
  }

  /**
   * When a call's answer came (epoch µs): the browser's end of it where it flew (its stored time, taken after the
   * answer was sent, ends later), else its start and its time.
   */
  function answeredAt(summary: EntrySummary): number {
    return summary.clock?.end ?? summary.start + summary.duration;
  }

  /** A view still open, its time stopped where it went quiet (quietSince), as the panel's list shows it. */
  function withQuiet(entry: TabEntry): TabEntry {
    const until = entry.summary?.open && entry.summary.kind === "page" ? quietSince(entry.id) : undefined;
    return until === undefined || !entry.summary ? entry : { ...entry, summary: { ...entry.summary, until } };
  }

  /**
   * What "this page" is, as the pill counts it: the page, the actions done on it, and the view its load is listed
   * under (underLoadView), whose calls are this page's as much as the document is.
   */
  function pageScope(current: string | null): string[] {
    if (!current) return [];
    const load = view && view.id === loadView && current !== view.id ? [view.id] : [];
    return [current, ...load, ...scope];
  }

  function sendTab(): void {
    if (frame?.contentWindow && panelUrl) {
      const current = currentPage();
      frame.contentWindow.postMessage(
        {
          type: "tracepanel:tab",
          entries: entries(),
          current,
          scope: pageScope(current),
          runtime: runtime ?? null,
        },
        panelUrl.origin,
      );
    }
  }

  /** This tab's requests on this page, oldest first: the page (unless cleared, or a route changed) and its AJAX calls. */
  function requests(): TraceInfo[] {
    const own = ownPage();
    return [...(own ? [own] : []), ...later];
  }

  /**
   * A request's numbers as the pill, its card and the list say them (lib/live): its chain's once the console counted
   * it, its own where it called no app or the console can't say; its queries pending until then.
   */
  function counted(info: TraceInfo): Counted {
    const facts = panelUrl && info.trace ? chained.get(info.trace) : "own";
    return countedBy(info, facts);
  }

  // A press on the pill holds its redraws until it ends: a redraw replaces what was pressed, and the browser then
  // fires no click, so a click as a time ticked or a request's numbers came in opened nothing.
  let pressed = false;
  let heldDraw = false;

  /**
   * The pill describes one request, named, and every number on it is that request's: the newest still in flight,
   * else the latest done (the page when it loads, then each AJAX call), as the panel's Follow new shows it. On the
   * right, the rest of this page: how many requests, how many failed; the ring is the worst of them all.
   */
  function render(): void {
    // Pressed: drawn once the press ends (pressing() below).
    if (pressed) {
      heldDraw = true;
      return;
    }
    const all = requests();
    const flying = flights();
    if (all.length === 0 && flying.length === 0) renderIdle();
    else renderPill(all, flying);
    card.refresh();
    keepTicking();
  }

  /** The newest request in flight or the latest done, with the page's count and verdict. */
  function renderPill(all: TraceInfo[], flying: Flight[]): void {
    stats.textContent = "";
    const flight = flying.at(-1);
    if (flight) addFlight(stats, flight);
    else {
      const shown = all.at(-1) ?? {};
      addRequest(stats, shown, pulse, counted(shown));
    }
    const count = all.length + untraced.length + flying.length;
    if (count > 1) addPage(stats, all, count);
    fitBadge();
    badge.dataset["verdict"] = verdict(all, counted);
    // No title: the hover card shows all of it (and more); screen readers get the summary.
    badge.setAttribute("aria-label", pillLabel(all, flying, count, runtime, counted));
  }

  /** What the view's chain says, once the console answered. */
  function viewFacts(): ChainFacts | null {
    const facts = view ? chained.get(view.id) : undefined;
    return facts && facts !== "own" ? facts : null;
  }

  /**
   * Nothing traced on this page yet: its server didn't trace it (an SPA's dev server served it) and it made no calls.
   * The pill says so: its view (running while open), or that it waits.
   */
  function renderIdle(): void {
    stats.textContent = "";
    const facts = viewFacts();
    const until = view?.open ? quietSince(view.id) : undefined;
    if (view) addView(stats, view, facts, until);
    else addWaiting(stats);
    fitBadge();
    badge.dataset["verdict"] = view?.status === "error" ? "error" : facts?.counts?.issues ? "warn" : "ok";
    badge.setAttribute("aria-label", idleLabel(view, runtime, facts?.counts ?? null, until));
  }

  // While something runs (a request in flight, a view open), the pill and the card draw again every TICK_MS: its
  // time ticks, and a request past FLIGHT_SHOWN_MS shows.
  let ticking: number | undefined;
  function keepTicking(): void {
    const running = somethingRuns();
    if (running && ticking === undefined) ticking = window.setInterval(tick, TICK_MS);
    if (!running) stopTicking();
  }

  function stopTicking(): void {
    window.clearInterval(ticking);
    ticking = undefined;
  }

  /** A request in flight, or a view still open. */
  function somethingRuns(): boolean {
    return inFlight.length > 0 || view?.open === true;
  }

  /** The pill and the card drawn again; a request in flight shows up in the panel's list once it is past its moment. */
  function tick(): void {
    const shownBefore = flights().length;
    render();
    const passing = [...inFlight, ...landed.map((call) => call.flight)].some(
      (flight) => Date.now() - flight.start < FLIGHT_SHOWN_MS + TICK_MS,
    );
    if (flights().length !== shownBefore || passing) sendTab();
  }

  /**
   * Once a view or a request ends: what its calls did down its chain, asked from the console while the pill shows it.
   * Its numbers are pending until the first answer; with none (unreachable, never stored) its own are all there are.
   */
  function followFacts(id: string, wanted: () => boolean, view = false): void {
    if (!panelUrl) return;
    void followChain(
      fetchJson,
      panelUrl,
      id,
      { wanted, view },
      (facts) => {
        const before = chained.get(id);
        if (before && before !== "own" && factsKey(before) === factsKey(facts)) return;
        chained.set(id, facts);
        render();
      },
      UNREACHABLE,
      (answered) => {
        if (answered || chained.has(id)) return;
        chained.set(id, "own");
        render();
      },
    );
  }

  /** Once a view ends: its chain, while the pill shows it (its own, no request of its own on the pill yet). */
  function followView(ended: PageAnnouncement): void {
    if (!ended.open) followFacts(ended.id, () => view?.id === ended.id, true);
  }

  /** A request just answered: its chain, while it is the pill's. */
  function followRequest(info: TraceInfo): void {
    const id = info.trace;
    if (!id) return;
    followFacts(id, () => requests().includes(info));
  }

  /** A request of the page left: it takes off, or lands with what its answer said. */
  setWatcher({
    start: (flight) => {
      inFlight.push(flight);
      noteWhere(flight);
      keepTicking();
      // An open view's time runs again with its new call (quietSince), in the panel's list too.
      if (view?.open) sendTab();
    },
    end: (flight, info, answer) => {
      const at = inFlight.indexOf(flight);
      if (at !== -1) inFlight.splice(at, 1);
      if (info) record(info);
      else {
        if (answer) land(flight, answer);
        render();
        sendTab();
      }
    },
  });

  /** A page htmx loaded (a boosted link or form): it heads the list, and what follows is its requests. */
  function navigate(info: TraceInfo): void {
    page = info;
    pageCleared = false;
    later.length = 0;
    untraced = [];
    if (info.trace) {
      tab = [...tab, { id: info.trace, parent: null, summary: summaryOf(info) }];
      saveTab(tab);
    }
    render();
    sendTab();
  }

  /**
   * Asks the console about a request once the agent stored it: `use` takes the answer, and says whether it was
   * there. Gives up quietly when the console is unreachable from this page.
   */
  async function askConsole(path: string, use: (body: unknown) => boolean): Promise<void> {
    if (!panelUrl) return;
    const url = new URL(path, panelUrl);
    for (let attempt = 1; attempt <= ISSUE_TRIES; attempt++) {
      if (settled(await fetchJson(url), use)) return;
      await new Promise((resolve) => window.setTimeout(resolve, ISSUE_RETRY_MS * attempt));
    }
  }

  /** Issues found after the response (by the agent): asked from the console once the request is stored. */
  async function resolveIssues(info: TraceInfo): Promise<void> {
    if (!info.issuesPending || !info.trace) return;
    await askConsole(`api/traces?ids=${encodeURIComponent(info.trace)}`, (body) => {
      const row = listedTrace(body, info.trace);
      if (row) applyIssues(info, row);
      return row !== undefined;
    });
  }

  function applyIssues(info: TraceInfo, row: ListedTrace): void {
    info.issues = row.issues ?? 0;
    info.issuesPending = false;
    info.totalMs = storedMs(row, info);
    const entry = tab.find((item) => item.id === info.trace);
    if (entry?.summary) entry.summary = stored(entry.summary, row);
    saveTab(tab);
    render();
    sendTab();
  }

  /**
   * What the task runs a request led to found, asked over the next seconds while the pill shows it (the workers
   * record them after the response): the pill and its card say so beside the request's own issues.
   */
  async function followRuns(info: TraceInfo): Promise<void> {
    const ask = runsAsk(info.trace);
    if (!ask) return;
    for (const wait of RUN_ASKS_MS) {
      await new Promise((resolve) => window.setTimeout(resolve, wait));
      if (!(await askRuns(info, ask))) return;
    }
  }

  /** What to ask the console for a request's runs: none without a console or a trace. */
  function runsAsk(id: string | undefined): { id: string; url: URL } | null {
    if (!panelUrl || !id) return null;
    return { id, url: new URL(`api/traces?ids=${encodeURIComponent(id)}&runs=1`, panelUrl) };
  }

  /** One ask; false when asking again is no use: another request took the pill, or the console is unreachable. */
  async function askRuns(info: TraceInfo, ask: { id: string; url: URL }): Promise<boolean> {
    if (requests().at(-1) !== info) return false;
    const body = await fetchJson(ask.url);
    if (body === UNREACHABLE) return false;
    showTaskIssues(info, runsOf(body, ask.id));
    return true;
  }

  function showTaskIssues(info: TraceInfo, found: { issues: number; failed: number }): void {
    if (tasksPart(info) === tasksPart({ taskIssues: found.issues, taskFailed: found.failed })) return;
    info.taskIssues = found.issues;
    info.taskFailed = found.failed;
    render();
  }

  /** The runtime of the app that answered a call, from its trace: for a page its server didn't label. */
  async function resolveRuntime(info: TraceInfo): Promise<void> {
    if (runtimeAsked || !info.trace) return;
    runtimeAsked = true;
    await askConsole(`api/traces/${encodeURIComponent(info.trace)}`, (body) => {
      runtime = traceRuntime((body as { attrs?: Record<string, unknown> }).attrs ?? {});
      learnRuntime(runtime);
      showRuntime(runtimeChip, runtime);
      render();
      sendTab();
      return true;
    });
    // Not stored in time (an agent just started): the next request asks again.
    runtimeAsked = runtime !== undefined;
  }

  /** A view or an action from the browser recording: a row of its own, its requests under it; updated as it ends. */
  function recordPage(announced: PageAnnouncement): void {
    if (announced.name.includes(" › ")) takeAction(announced);
    else takeView(announced);
    // The views whose calls the tab doesn't list (through a gateway, untraced): not empty.
    const called = new Set([
      ...landed.map((call) => call.parent),
      ...inFlight.flatMap((flight) => listedUnder.get(flight) ?? []),
    ]);
    tab = underLoadView(withPage(tab, announced, loadView, called), announced);
    saveTab(tab);
    sendTab();
  }

  /** An action done on this page: its requests count on it. */
  function takeAction(announced: PageAnnouncement): void {
    if (view && announced.start >= view.start) scope.add(announced.id);
  }

  /** A view of the page: the pill's while it has no request; another route starts a new page (pill, count, list). */
  function takeView(announced: PageAnnouncement): void {
    loadView ??= announced.id;
    if (view?.id !== announced.id) newPage(announced.id);
    view = announced;
    render();
    followView(announced);
  }

  /** Another route (or the same again): this page's scope starts over, the last view's requests no longer its own. */
  function newPage(id: string): void {
    scope.clear();
    if (id !== loadView) {
      later.length = 0;
      untraced = [];
    }
  }

  /**
   * The page's own request (the document its server rendered) under the view that loaded it: the recording's first
   * view on this page is the browser's side of the same load, its calls listed under it. Else the two would be rows
   * side by side, GET /docs and VIEW /docs, for one page load.
   */
  function underLoadView(entries: TabEntry[], announced: PageAnnouncement): TabEntry[] {
    if (announced.name.includes(" › ")) return entries;
    loadView ??= announced.id;
    const own = page && !pageCleared ? page.trace : undefined;
    if (loadView !== announced.id || !own) return entries;
    // The document is the load, not a call of the view's: never in a group of its calls to one host. Its host is
    // still the one its app served: a group of the view's calls to it is named by that app.
    const asLoad = (summary: EntrySummary | undefined) =>
      summary && { ...summary, host: undefined, loadHost: summary.host ?? summary.loadHost };
    return entries.map((item) =>
      item.id === own && item.parent === null ? { ...item, parent: announced.id, summary: asLoad(item.summary) } : item,
    );
  }

  /** What a request is listed under: the view or action that made it, else the page it was made on. */
  function parentOf(info: TraceInfo): string | null {
    return info.page ?? page?.trace ?? null;
  }

  /** Whether a request is this page's: made by its view or an action on it, or by no view (none recorded). */
  function ofThisPage(info: TraceInfo): boolean {
    if (!info.page || !view) return true;
    return info.page === view.id || scope.has(info.page);
  }

  function record(info: TraceInfo): void {
    void resolveIssues(info);
    void resolveRuntime(info);
    void followRuns(info);
    if (info.htmx?.boosted) {
      navigate(info);
      return;
    }
    // A request the last view made, answered after a route change: listed under it, not counted on this page.
    if (ofThisPage(info)) {
      later.push(info);
      followRequest(info);
    }
    listRequest(info);
    // The latest request takes the pill (and keeps it until the next one), with a short pulse.
    pulse = true;
    render();
    pulse = false;
    sendTab();
  }

  /** A traced request in the tab's list, under what made it. */
  function listRequest(info: TraceInfo): void {
    if (!info.trace) return;
    tab = [...tab, { id: info.trace, parent: parentOf(info), summary: summaryOf(info) }];
    saveTab(tab);
  }

  /**
   * Like Clear in the browser's Network tab: forget this tab's requests and keep the page itself. `all` (the store was
   * deleted) forgets the page too.
   */
  function clear(all: boolean): void {
    pageCleared = all;
    tab = all ? [] : tab.filter((entry) => entry.id === page?.trace);
    saveTab(tab);
    later.length = 0;
    untraced = [];
    render();
    sendTab();
  }

  function open(hash = "#/"): void {
    if (!panelUrl) return;
    const url = new URL(hash, panelUrl).href;
    if (!frame) {
      frame = document.createElement("iframe");
      frame.title = "Tracepanel";
      frame.src = url;
      panel.append(frame);
    } else if (hash !== "#/") {
      frame.src = url;
    }
    panel.toggleAttribute("data-open", true);
    badge.setAttribute("aria-expanded", "true");
    makeRoom();
    savePanel(panelState());
    tellShown();
  }

  function close(): void {
    panel.toggleAttribute("data-open", false);
    badge.setAttribute("aria-expanded", "false");
    makeRoom();
    savePanel(panelState());
    tellShown();
  }

  /** Tells the panel whether it shows: closed, nothing in it moves (an hourglass of a trace on its way). */
  function tellShown(): void {
    frame?.contentWindow?.postMessage({ type: "tracepanel:shown", shown: panel.hasAttribute("data-open") }, "*");
  }

  // Hover (or keyboard focus): the request at a glance, before opening the panel; drawn again as it changes.
  const card = mountCard(root, badge, {
    requests,
    untraced: () => untraced.map(untracedCall),
    flights,
    view: () => (view ? { view, facts: viewFacts(), until: view.open ? quietSince(view.id) : undefined } : null),
    counted,
    page: ownPage,
    api: panelUrl,
    panelOpen: () => panel.hasAttribute("data-open"),
    open,
    fetch: nativeFetch,
  });

  badge.addEventListener("pointerdown", (event) => {
    if (event.isPrimary) pressed = true;
  });
  const released = () => {
    if (!pressed) return;
    pressed = false;
    if (!heldDraw) return;
    heldDraw = false;
    // After the click the release makes.
    window.setTimeout(render);
  };
  for (const type of ["pointerup", "pointercancel", "blur"]) window.addEventListener(type, released, true);

  // The panel opens on the request the pill shows.
  badge.addEventListener("click", () => {
    const shown = requests().at(-1);
    if (panel.hasAttribute("data-open")) close();
    else open(shown?.trace ? `#/t/${shown.trace}` : "#/");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    // The panel asks for the tab's traces once its app has loaded.
    const data = event.data;
    if (
      frame &&
      event.source === frame.contentWindow &&
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      (data.type === "tracepanel:close" ||
        data.type === "tracepanel:reload" ||
        data.type === "tracepanel:dock" ||
        data.type === "tracepanel:clear")
    ) {
      // After switching the user the page must render again for them; the panel stays open across the reload.
      if (data.type === "tracepanel:reload") location.reload();
      else if (data.type === "tracepanel:close") close();
      else if (data.type === "tracepanel:clear") clear("all" in data && data.all === true);
      else {
        setDock(dock === "right" ? "bottom" : "right");
        savePanel(panelState());
      }
      return;
    }
    if (
      frame &&
      event.source === frame.contentWindow &&
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      data.type === "tracepanel:theme" &&
      "theme" in data &&
      typeof data.theme === "string"
    ) {
      // The panel on another origin (the console's port) can't reach this page's storage: it says its choice.
      storeTheme(data.theme);
      applyTheme();
      return;
    }
    if (
      frame &&
      event.source === frame.contentWindow &&
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      data.type === "tracepanel:ready"
    ) {
      frame.contentWindow?.postMessage({ type: "tracepanel:dock", dock }, "*");
      tellShown();
      sendTab();
    }
  });

  render();
  if (page) {
    void resolveIssues(page);
    void followRuns(page);
    followRequest(page);
  }
  listen();
  // The browser recording's views and actions: those announced before the widget mounted, then each as it comes.
  followPages(recordPage);
  for (const info of pending.splice(0)) record(info);
  // Those still in flight from before it mounted show as they are.
  inFlight.push(...flying);
  render();

  // Reopen the panel after a navigation if it was open, without the slide-in animation.
  const saved = loadPanel();
  setWidth(saved.width ?? DEFAULT_WIDTH);
  setHeight(saved.height ?? DEFAULT_HEIGHT);
  setDock(saved.dock);

  // Window-level listeners (no pointer capture): the iframe ignores the pointer while resizing.
  // One size change per frame, however fast the pointer events come.
  let resizeTo: { x: number; y: number } | null = null;
  const applyResize = (): void => {
    if (!resizeTo) return;
    if (dock === "bottom") setHeight(window.innerHeight - resizeTo.y);
    else setWidth(window.innerWidth - resizeTo.x);
    resizeTo = null;
  };
  const onResizeMove = (event: PointerEvent): void => {
    if (!resizeTo) requestAnimationFrame(applyResize);
    resizeTo = { x: event.clientX, y: event.clientY };
  };
  const stopResize = (): void => {
    applyResize();
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
    panel.removeAttribute("data-resizing");
    savePanel(panelState());
  };
  handle.addEventListener("pointerdown", (event: PointerEvent) => {
    event.preventDefault();
    panel.toggleAttribute("data-resizing", true);
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  });
  handle.addEventListener("dblclick", () => {
    if (dock === "bottom") setHeight(DEFAULT_HEIGHT);
    else setWidth(DEFAULT_WIDTH);
    savePanel(panelState());
  });
  if (saved.open) {
    panel.toggleAttribute("data-instant", true);
    open();
    requestAnimationFrame(() => requestAnimationFrame(() => panel.removeAttribute("data-instant")));
  }
  return { record, open, close };
}

export function number(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

// Auto-mount when loaded via <script data-tracepanel-api="..."> (data-tracepanel-* carries the page's own request).
const script = document.currentScript as HTMLScriptElement | null;

// Once per page, even if the script runs again (a page swapped in by htmx that carries it).
const mounted = "__tracepanel" in window;
if (script && !mounted) {
  Object.defineProperty(window, "__tracepanel", { value: true });
  listen();
  const data = script.dataset;
  const start = (): Widget =>
    mount({
      api: data["tracepanelApi"],
      initial: {
        name: data["tracepanelName"],
        method: data["tracepanelMethod"],
        url: location.pathname,
        status: number(data["tracepanelStatus"]),
        trace: data["tracepanelId"],
        totalMs: number(data["tracepanelTotal"]),
        dbMs: number(data["tracepanelDb"]),
        queries: number(data["tracepanelQueries"]),
        issues: data["tracepanelIssues"] === PENDING_ISSUES ? undefined : number(data["tracepanelIssues"]),
        issuesPending: data["tracepanelIssues"] === PENDING_ISSUES,
      },
      runtime: data["tracepanelRuntime"],
    });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
