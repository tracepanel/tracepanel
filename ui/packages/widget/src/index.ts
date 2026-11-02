// Corner badge, fetch and XHR capture, slide-out panel (iframe inside Shadow DOM).

import TOKENS from "virtual:tracepanel-tokens";
import { duration } from "@tracepanel/ui/format";
import { type ChainCounts, chainScope } from "@tracepanel/ui/lib/chainCounts";
import { graphqlName, namesOperation } from "@tracepanel/ui/lib/graphql";
import { clockOf, cutNote, NO_ANSWER, PENDING, runningLabel, runningTime, TICK_MS } from "@tracepanel/ui/lib/live";
import { REDIRECT_MS } from "@tracepanel/ui/lib/page";
import { plural } from "@tracepanel/ui/lib/plural";
import {
  BROWSER_ICON_SVG,
  type RuntimeMark,
  runtimeKind,
  runtimeMark,
  runtimeName,
  traceRuntime,
} from "@tracepanel/ui/lib/runtime";
import { CARD_STYLE, mountCard, nameWithMethod } from "./card";
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
}

/** A view or an action tracepanel-js records in the browser, as it announces them (tracepanel:page). */
interface PageAnnouncement {
  id: string;
  name: string;
  start: number;
  duration: number;
  status: "ok" | "error";
  open: boolean;
}

// tracepanel-js's browser recording marks each Response and XMLHttpRequest with the view or action that made it.
const PAGE = Symbol.for("tracepanel.page");
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
  if (!facts) {
    addQueries(parent, null);
    return;
  }
  addQueries(parent, facts.counts.queries);
  addCalls(parent, facts.counts.calls, facts.counts.ownCalls);
  if (facts.counts.issues) addIssues(parent, facts.counts.issues, "warn");
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

/** A view's name has no action after its path: "/books", not "/books › click "Save"". */
function isView(entry: TabEntry | undefined): boolean {
  return entry?.summary?.kind === "page" && !entry.summary.name.includes(" › ");
}

/**
 * Before a new view goes in: the last one, when it is of the same page and nothing came after it (no request, no
 * action), leaves the list. Reloads of an SPA's page would otherwise stack views with nothing under them. A route
 * change is a view of another page: it goes in after the last one, which stays, with or without requests.
 */
function dropEmptyView(tab: TabEntry[], name: string): TabEntry[] {
  const last = tab.at(-1);
  if (last && isViewOf(last, name) && !tab.some((item) => item.parent === last.id)) return tab.slice(0, -1);
  return tab;
}

/** Whether an entry is a view of the page `name` (a view, not an action on it). */
function isViewOf(entry: TabEntry, name: string): boolean {
  return isView(entry) && entry.summary?.name === name;
}

/** What the browser recording announced before the widget listened, oldest first. */
function announcedPages(): PageAnnouncement[] {
  const announced = (globalThis as unknown as Record<symbol, Map<string, PageAnnouncement> | undefined>)[ANNOUNCED];
  return announced ? [...announced.values()] : [];
}

function pageOf(carrier: object): string | undefined {
  const page = (carrier as Record<symbol, unknown>)[PAGE];
  return typeof page === "string" ? page : undefined;
}

export interface HtmxInfo {
  /** The element that sent it, as people see it: its label, its text, its id. */
  trigger?: string | undefined;
  /** Where htmx swaps the answer: "#rows-todo". */
  target?: string | undefined;
  /** A boosted link or form: a page load done by htmx. */
  boosted?: boolean | undefined;
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
  try {
    if (choice === "light" || choice === "dark" || choice === "system") localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Blocked storage: the badge stays dark.
  }
}

/** Follows the console's theme choice (dark when there is none), or the OS when it is Auto. */

function watchTheme(host: HTMLElement): () => void {
  const apply = () => {
    let choice: string | null = null;
    try {
      choice = localStorage.getItem(THEME_KEY);
    } catch {
      // Blocked storage: dark.
    }
    const light = choice === "light" || (choice === "system" && !window.matchMedia(DARK).matches);
    host.dataset["theme"] = light ? "light" : "dark";
  };
  apply();
  window.matchMedia(DARK).addEventListener("change", apply);
  // Fired here when the panel (an iframe on this origin) or another tab changes the theme.
  window.addEventListener("storage", (event) => event.key === THEME_KEY && apply());
  return apply;
}

const STYLE = `
  :host { all: initial; }
  /* The tones the pill and the card tint with, from the tokens: a verdict's amber and coral, the accent's violet.
     The light theme's tints are lighter and take their hue from the stronger ink. */
  :host {
    --amber: rgb(from var(--dt-warn-bg) r g b / 1);
    --coral: rgb(from var(--dt-error-bg) r g b / 1);
    --violet: var(--dt-violet);
    --tint-ok: rgb(from var(--dt-ok-bg) r g b / 0.13);
    --tint-info: rgb(from var(--dt-info-bg) r g b / 0.15);
    --tint-warn: rgb(from var(--amber) r g b / 0.15);
    --tint-error: rgb(from var(--coral) r g b / 0.16);
    --tint-violet: rgb(from var(--violet) r g b / 0.16);
    --ring-warn: rgb(from var(--amber) r g b / 0.16);
    --ring-error: rgb(from var(--coral) r g b / 0.3);
    --edge-error: rgb(from var(--coral) r g b / 0.9);
    --k-django: rgb(from var(--dt-k-django) r g b / 0.4);
  }
  :host([data-theme="light"]) {
    --coral: var(--dt-error);
    --violet: var(--dt-accent);
    --tint-ok: rgb(from var(--dt-ok-bg) r g b / 0.12);
    --tint-info: rgb(from var(--dt-info-bg) r g b / 0.09);
    --tint-warn: rgb(from var(--amber) r g b / 0.1);
    --tint-error: rgb(from var(--coral) r g b / 0.09);
    --tint-violet: rgb(from var(--violet) r g b / 0.1);
    --ring-warn: rgb(from var(--amber) r g b / 0.13);
    --ring-error: rgb(from var(--coral) r g b / 0.22);
    --edge-error: rgb(from var(--coral) r g b / 0.85);
    --k-django: rgb(from var(--dt-k-django) r g b / 0.3);
  }
  /* A dark pill in the corner: the request's verdict at a glance. Its ring is the verdict: none when all is well,
     amber when something wants a look, coral when it failed. */
  .badge {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    display: flex; align-items: center; gap: 0; max-width: calc(100vw - 32px);
    height: 40px; padding: 0 6px 0 9px; border: 1px solid var(--dt-float-border); border-radius: 999px;
    background: var(--dt-float); color: var(--dt-float-text);
    box-shadow: var(--dt-float-shadow);
    font: 500 12.5px/1 "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums; cursor: pointer;
    transition: right 180ms ease-out, box-shadow 180ms ease-out, border-color 120ms ease-out;
  }
  .badge[data-verdict="warn"] { border-color: rgb(from var(--amber) r g b / 0.45); box-shadow: 0 0 0 4px var(--ring-warn), var(--dt-float-drop); }
  /* A failure is the one thing not to miss: a solid coral edge and a stronger halo. */
  .badge[data-verdict="error"] { border-color: var(--edge-error); box-shadow: 0 0 0 4px var(--ring-error), var(--dt-float-drop); }
  /* Hover answers in place: the border, in the verdict's colour, gets stronger; the pill stays where it is. */
  .badge:hover { border-color: var(--dt-float-border-hover); }
  .badge[data-verdict="warn"]:hover { border-color: rgb(from var(--amber) r g b / 0.85); }
  .badge[data-verdict="error"]:hover { border-color: var(--coral); }
  /* From the keyboard: the accent, thin, as everywhere in the UI (not the logo's lime, which read as a verdict). */
  .badge:focus-visible { outline: none; filter: brightness(1.25); }
  .brand { display: flex; align-items: center; padding-right: 8px; }
  .brand svg { width: 21px; height: 21px; }
  .logo-1 { fill: var(--dt-accent-strong); }
  .logo-2 { fill: var(--dt-violet); }
  .logo-3 { fill: var(--dt-lime); }
  .runtime { align-self: center; display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; padding: 4px 7px; border-radius: 999px; background: var(--dt-float-chip); color: var(--dt-text-2); font-size: 10.5px; font-weight: 600; letter-spacing: 0.01em; }
  .brand .runtime svg { width: 12px; height: 12px; }
  .monogram { display: inline-grid; place-items: center; width: 12px; height: 12px; container-type: size; border-radius: 25%; background: color-mix(in srgb, currentColor 16%, transparent); font-weight: 700; line-height: 1; letter-spacing: -0.02em; }
  .monogram::before { content: attr(data-letters); font-size: 56cqh; }
  .monogram[data-letters="J"]::before { font-size: 72cqh; }
  .runtime:empty { display: none; }
  .stats { display: inline-flex; align-items: center; min-width: 0; height: 100%; }
  .seg { display: inline-flex; align-items: center; gap: 5px; height: 21px; padding: 0 8.5px; white-space: nowrap; }
  .seg + .seg { border-left: 1px solid var(--dt-float-divider); }
  .seg svg { width: 12.5px; height: 12.5px; color: var(--dt-text-3); flex: none; }
  .seg b { color: var(--dt-float-strong); font-weight: 600; }
  .unit { color: var(--dt-text-3); }
  /* In the light theme every icon in the pill is grey, a finding's and a failure's too. */
  :host([data-theme="light"]) .seg svg { color: var(--dt-text-3); }
  .status { padding: 3px 7px; border-radius: 999px; font: 600 11px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; background: var(--tint-ok); color: var(--dt-ok); }
  .status[data-tone="redirect"] { background: var(--tint-info); color: var(--dt-info); }
  .status[data-tone="client"] { background: var(--tint-warn); color: var(--dt-warn); }
  .status[data-tone="server"] { background: var(--tint-error); color: var(--dt-error); }
  /* In the light theme a status is a dot of its tone before the code, as in the console's lists and the panel. */
  :host([data-theme="light"]) .status { display: inline-flex; align-items: center; gap: 5px; padding: 0; background: none; font-weight: 500; }
  :host([data-theme="light"]) .status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .seg[data-speed="slow"] b { color: var(--dt-warn); }
  .seg[data-speed="very-slow"] b { color: var(--dt-error); }
  /* lib/live's states, as the panel draws them: in flight, a ring that turns and the time so far; no answer yet, the
     hourglass and its words; a number not known yet, "…". */
  .running { display: inline-block; flex: none; width: 11px; height: 11px; box-sizing: border-box; border: 1.5px solid rgb(from var(--dt-accent) r g b / 0.28); border-top-color: var(--dt-accent); border-radius: 50%; animation: running 0.8s linear infinite; }
  @keyframes running { to { transform: rotate(360deg); } }
  .seg[data-state="running"] b { color: var(--dt-float-strong); }
  .no-answer { display: inline-flex; align-items: center; gap: 4px; color: var(--dt-text-3); font-size: 11.5px; white-space: nowrap; }
  .seg .no-answer svg { width: 12px; height: 12px; color: currentColor; }
  .pending { color: var(--dt-text-3); }
  .flying { color: var(--dt-text-2); }
  .issues { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; background: var(--tint-warn); color: var(--dt-warn); font-weight: 600; font-size: 11.5px; }
  .seg .issues svg { color: currentColor; }
  /* Its tasks': the Tasks icon, then the same chips as its own failures and issues. */
  .tasks { gap: 5px; }
  .tasks .failed { margin-left: 0; }
  .issues[data-tone="error"] { background: var(--tint-error); color: var(--dt-error); }
  /* The page's count: a step back from the latest request's numbers; its failures stand out on their own. */
  .page .unit { margin-left: -1px; }
  .failed { display: inline-flex; align-items: center; gap: 4px; margin-left: 3px; padding: 3px 8px; border-radius: 999px; background: var(--tint-error); color: var(--dt-error); font-weight: 600; font-size: 11.5px; }
  .seg .failed svg { width: 12px; height: 12px; color: currentColor; }
  .name {
    max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 6px;
    font: 500 12px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; color: var(--dt-float-strong);
  }
  .name[data-pulse] { animation: pulse 700ms ease-out; }
  .idle { color: var(--dt-float-muted); font-size: 12px; white-space: nowrap; }
  @keyframes pulse {
    from { box-shadow: 0 0 0 0 rgb(from var(--dt-violet) r g b / 0.6); }
    to { box-shadow: 0 0 0 8px rgb(from var(--dt-violet) r g b / 0); }
  }
  .panel {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483646;
    width: min(var(--tracepanel-width, 600px), 100vw); border-left: 1px solid var(--dt-float-edge);
    background: var(--dt-panel);
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    box-shadow: var(--dt-float-panel-shadow);
    transform: translateX(100%); visibility: hidden;
    transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), width 200ms ease-out, visibility 0s 200ms;
  }
  .panel[data-open] { transform: none; visibility: visible; transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), width 200ms ease-out; }
  .panel[data-open] ~ .badge { right: calc(min(var(--tracepanel-width, 600px), 100vw) + 16px); }
  /* No room beside the panel (a narrow window): the panel shows the request, the badge folds to its logo,
     its ring still the verdict. */
  :host([data-crowded]:not([data-dock="bottom"])) .panel[data-open] ~ .badge { width: 40px; padding: 0; justify-content: center; }
  :host([data-crowded]:not([data-dock="bottom"])) .panel[data-open] ~ .badge :is(.stats, .runtime) { display: none; }
  :host([data-crowded]:not([data-dock="bottom"])) .panel[data-open] ~ .badge .brand { padding: 0; }
  /* The theme (the console's Dark / Light / Auto choice, shared through localStorage) is the :host's data-theme. */
  .panel iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; color-scheme: dark; }
  :host([data-theme="light"]) .panel iframe { color-scheme: light; }
  .panel[data-instant], .panel[data-instant] ~ .badge, .panel[data-resizing], .panel[data-resizing] ~ .badge { transition: none; }
  .panel[data-resizing] iframe { pointer-events: none; }
  /* 10px to grab, centred on the panel's 1px edge. What shows is that edge, a step stronger under the pointer and
     while dragging: never thicker, never the brand's colour (as the console's sidebar and split panes). */
  .resize { position: absolute; top: 0; bottom: 0; left: -6px; width: 10px; cursor: ew-resize; z-index: 1; }
  .resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 5px; width: 1px; background: transparent; transition: background 120ms; }
  .resize:hover::after, .panel[data-resizing] .resize::after { background: var(--dt-divider-active); }
  /* Docked at the bottom, like browser devtools: full width, the height is dragged from the top edge. */
  :host([data-dock="bottom"]) .panel {
    top: auto; left: 0; width: 100vw; height: min(var(--tracepanel-height, 360px), 100vh);
    border-left: 0; border-top: 1px solid var(--dt-float-edge);
    box-shadow: var(--dt-float-panel-shadow-bottom);
    transform: translateY(100%);
    transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), height 200ms ease-out, visibility 0s 200ms;
  }
  :host([data-dock="bottom"]) .panel[data-open] { transform: none; transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), height 200ms ease-out; }
  :host([data-dock="bottom"]) .panel[data-open] ~ .badge { right: 16px; bottom: calc(min(var(--tracepanel-height, 360px), 100vh) + 12px); }
  :host([data-dock="bottom"]) .resize { top: -6px; bottom: auto; left: 0; right: 0; width: auto; height: 10px; cursor: ns-resize; }
  :host([data-dock="bottom"]) .resize::after { top: 5px; bottom: auto; left: 0; right: 0; width: auto; height: 1px; }
  /* While dragging, the size follows the pointer: no transition (these selectors outrank the dock rules). */
  :host .panel[data-resizing], :host .panel[data-resizing][data-open], :host .panel[data-resizing] ~ .badge,
  :host([data-dock="bottom"]) .panel[data-resizing][data-open] { transition: none; }
  @media (prefers-reduced-motion: reduce) { .panel, .badge, .resize::after { transition: none; } .name[data-pulse] { animation: none; } .running { animation: none; } }
`;

const PENDING_ISSUES = "pending";
// A request in flight shows on the pill (and in the list) once it has run this long: a quick one never blinks.
const FLIGHT_SHOWN_MS = 150;
// Asking the console what the pill's request's task runs found: they run after it, in a worker, so the asks are
// spread over the next seconds, while it is still the pill's.
const RUN_ASKS_MS = [1000, 2000, 4000, 8000, 15000];
// Asking the console for a request's issues: it may not have stored the request yet.
const ISSUE_TRIES = 6;
const ISSUE_RETRY_MS = 300;

/** Parses the Server-Timing header written by tracepanel. Returns null for responses tracepanel didn't see. */
export function parseServerTiming(header: string | null): TraceInfo | null {
  if (!header) return null;
  const info: TraceInfo = {};
  let seen = false;
  for (const metric of header.split(",")) {
    const [name, ...params] = metric.trim().split(";");
    const values = new Map(
      params.map((param) => {
        const [key = "", value = ""] = param.trim().split("=");
        return [key, value.replace(/^"|"$/g, "")];
      }),
    );
    if (name === "db") {
      info.dbMs = Number(values.get("dur"));
      info.queries = Number.parseInt(values.get("desc") ?? "", 10);
      seen = true;
    } else if (name === "total") {
      info.totalMs = Number(values.get("dur"));
    } else if (name === "tracepanel-issues") {
      const desc = values.get("desc") ?? "";
      if (desc === PENDING_ISSUES) info.issuesPending = true;
      else info.issues = Number.parseInt(desc, 10);
    }
  }
  return seen ? info : null;
}

function fromResponse(
  method: string,
  url: string,
  status: number,
  headers: (name: string) => string | null,
): TraceInfo | null {
  const info = parseServerTiming(headers("Server-Timing"));
  if (!info) return null;
  const name = headers("Tracepanel-Name");
  return {
    ...info,
    name: name ? decodeURIComponent(name) : undefined,
    method,
    url,
    status,
    trace: headers("Tracepanel-Id") ?? undefined,
    issues: info.issues ?? 0,
  };
}

const LABEL_MAX = 40;

/** An element as people know it: its aria-label, its text, its id, else its tag. */
function describe(element: Element | null | undefined): string | undefined {
  if (!element) return undefined;
  const text = (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
  return element.id ? `#${element.id}` : element.tagName.toLowerCase();
}

function selector(element: Element | null | undefined): string | undefined {
  if (!element) return undefined;
  return element.id ? `#${element.id}` : element.tagName.toLowerCase();
}

/** What htmx says about each of its requests (htmx:beforeSend), until the request ends. */
const htmxRequests = new WeakMap<XMLHttpRequest, HtmxInfo>();

function watchHtmx(): void {
  document.addEventListener("htmx:beforeSend", (event) => {
    try {
      const detail = (event as CustomEvent).detail as {
        xhr?: XMLHttpRequest;
        elt?: Element;
        target?: Element;
        boosted?: boolean;
        requestConfig?: { headers?: Record<string, string> };
      };
      if (!detail.xhr) return;
      htmxRequests.set(detail.xhr, {
        trigger: describe(detail.elt),
        target: selector(detail.target),
        boosted: detail.boosted === true || detail.requestConfig?.headers?.["HX-Boosted"] === "true",
      });
    } catch {
      // Never break the page because of the widget.
    }
  });
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`tracepanel widget: missing ${selector}`);
  return element;
}

/**
 * A request of the page still in flight (lib/live): from the moment the page made it (a call the browser queues
 * behind others is in flight too) until its answer came. Its id is the widget's own ("~" and a number) until the
 * answer names its trace.
 */
export interface Flight {
  id: string;
  method: string;
  url: string;
  /** A GraphQL operation, read from the request's body as its trace will name it ("GraphQL query Books"). */
  name?: string | undefined;
  /** Epoch ms. */
  start: number;
}

/** What follows the page's requests: each as it starts, and as it ends with what its answer said (null: untraced). */
interface Watcher {
  start(flight: Flight): void;
  end(flight: Flight, info: TraceInfo | null): void;
}

/**
 * fetch/XHR are wrapped as soon as widget.min.js runs, at the top of <head>: pages that keep a reference to fetch while
 * loading (GraphiQL, Swagger, SPA clients) still go through the wrapper. Requests seen before the badge exists wait
 * here and show up when it mounts; those still in flight then show as they are.
 */
const pending: TraceInfo[] = [];
const flying = new Set<Flight>();
// The widget's own calls to the console go around the wrapper: they are not the page's requests.
const nativeFetch = window.fetch.bind(window);
let watcher: Watcher | null = null;
let listening = false;
let flights = 0;

function listen(): void {
  if (listening) return;
  listening = true;
  watchHtmx();
  intercept({
    start: (flight) => {
      flying.add(flight);
      watcher?.start(flight);
    },
    end: (flight, info) => {
      flying.delete(flight);
      const landed = info && namedAsItFlew(flight, info);
      if (watcher) watcher.end(flight, landed);
      else if (landed) pending.push(landed);
    },
  });
}

/**
 * A request keeps the name it ran under once it answers: the GraphQL operation its body carried, where the answer
 * names none (its server answered before the operation ran, a 503), as the agent names its trace (lib/graphql).
 */
function namedAsItFlew(flight: Flight, info: TraceInfo): TraceInfo {
  return flight.name && !namesOperation(info.name) ? { ...info, name: flight.name } : info;
}

/** The console's own calls (the panel's, the browser recording's) are not the page's requests. */
function ownCall(url: string): boolean {
  return url.includes("/__tracepanel__/");
}

/** A request the page just made, in flight; null for the console's own. */
function takeOff(method: string, url: string, body: unknown): Flight | null {
  const absolute = new URL(url, location.href).href;
  if (ownCall(absolute)) return null;
  flights += 1;
  return { id: `~${flights}`, method: method.toUpperCase(), url: absolute, name: graphqlName(body), start: Date.now() };
}

/** Runs `use` once the Response can carry its mark: now when it has it, else in the next task. */
function afterMark(response: Response, use: () => void): void {
  if (pageOf(response) !== undefined) {
    use();
    return;
  }
  window.setTimeout(() => {
    try {
      use();
    } catch {
      // Never break the page because of the widget.
    }
  });
}

/** Starts following a request: never breaks the page. */
function safely<T>(work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    return fallback;
  }
}

function intercept(watch: Watcher): void {
  const originalFetch = window.fetch;
  window.fetch = async function (this: unknown, input: globalThis.RequestInfo | URL, init?: RequestInit) {
    const method = safely(
      () => (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
      "GET",
    );
    const flight = safely(() => {
      const url = input instanceof Request ? input.url : String(input);
      const started = takeOff(method, url, init?.body);
      if (started) watch.start(started);
      return started;
    }, null);
    const land = (info: TraceInfo | null) => flight && safely(() => watch.end(flight, info), undefined);
    let response: Response;
    try {
      response = await originalFetch.call(this, input, init);
    } catch (error) {
      land(null);
      throw error;
    }
    try {
      const info = fromResponse(method, response.url, response.status, (name) => response.headers.get(name));
      // A recording that wrapped fetch after the widget (one started by the app's code, once the widget loaded)
      // marks the Response only once this call has returned to it: read the mark after that, in the next task.
      if (info)
        afterMark(response, () =>
          flight
            ? land({ ...info, page: pageOf(response) })
            : watch.end(NO_FLIGHT, { ...info, page: pageOf(response) }),
        );
      else land(null);
    } catch {
      // Never break the page because of the widget.
      land(null);
    }
    return response;
  } as typeof window.fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  // In flight from its send: the request it opened, with its body.
  const opened = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  const sent = new WeakMap<XMLHttpRequest, Flight>();
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    opened.set(this, { method, url: String(url) });
    this.addEventListener("loadend", () => {
      const flight = sent.get(this) ?? NO_FLIGHT;
      sent.delete(this);
      safely(() => watch.end(flight, xhrInfo(this, method, String(url))), undefined);
    });
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    safely(() => {
      const request = opened.get(this);
      const flight = request ? takeOff(request.method, request.url, body) : null;
      if (flight) {
        sent.set(this, flight);
        watch.start(flight);
      }
    }, undefined);
    return originalSend.call(this, body);
  };
}

/** What an XMLHttpRequest's answer says, as the pill shows it; null for one tracepanel didn't see. */
function xhrInfo(xhr: XMLHttpRequest, method: string, url: string): TraceInfo | null {
  const info = fromResponse(method.toUpperCase(), xhr.responseURL || url, xhr.status, (name) =>
    xhr.getResponseHeader(name),
  );
  return info ? { ...info, htmx: htmxRequests.get(xhr), page: pageOf(xhr) } : null;
}

/** For a request that answered with no flight followed (the console's own address, read again): nothing to land. */
const NO_FLIGHT: Flight = { id: "", method: "", url: "", start: 0 };

/** The request as people know it: the GraphQL operation, else the method and the actual path. */
function title(info: TraceInfo): string {
  if (info.name) return info.name;
  const path = info.url ? new URL(info.url, location.href).pathname : location.pathname;
  return `${info.method ?? "GET"} ${path}`;
}

/** " · 5 failed, 2 issues in its tasks", or nothing when its tasks all went well. */
function tasksPart(info: TraceInfo): string {
  const parts = [
    info.taskFailed ? `${info.taskFailed} failed` : "",
    info.taskIssues ? plural(info.taskIssues, "issue", "issues") : "",
  ].filter(Boolean);
  return parts.length ? ` · ${parts.join(", ")} in its tasks` : "";
}

function line(info: TraceInfo, counted: Counted): string {
  const issues = counted.issues ? ` · ${counted.issues} issue${counted.issues === 1 ? "" : "s"}` : "";
  const queries = counted.queries === null ? "queries not known yet" : `${counted.queries} q`;
  return `${title(info)} → ${info.status ?? "?"} · ${duration((info.totalMs ?? 0) * 1000)} · ${queries}${issues}${tasksPart(info)}`;
}

/** Its own findings, or its tasks': either wants a look. */
function wantsLook(info: TraceInfo): boolean {
  return Boolean(info.issues || info.taskIssues);
}

/** A finding in its tasks wants a look too: the ring is amber, the request's own count stays its own. */
function state(info: TraceInfo): "ok" | "warn" | "error" {
  if (broke(info)) return "error";
  return wantsLook(info) ? "warn" : "ok";
}

/** It failed, or one of its tasks did. */
function broke(info: TraceInfo): boolean {
  return (info.status ?? 200) >= 500 || Boolean(info.taskFailed);
}

const SEVERITY = { ok: 0, warn: 1, error: 2 } as const;

const ICONS = {
  db: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  // The sidebar's Tasks icon (lucide list-checks).
  tasks:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 5h8M13 12h8M13 19h8M3 17l2 2 4-4M3 7l2 2 4-4"/></svg>',
  layers:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>',
  failed:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v4M12 17.5h.01"/></svg>',
  // The panel's HTTP calls tab's (lucide arrow-up-right).
  calls:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>',
  // Something with no answer yet (lucide hourglass), as the panel's.
  hourglass:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>',
  // The corner its task runs hang from in the panel's list.
  below:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>',
} as const;

function segment(parent: HTMLElement): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "seg";
  parent.append(span);
  return span;
}

function addStatus(parent: HTMLElement, status: number | null | undefined): void {
  if (status === null || status === undefined) return;
  const chip = document.createElement("span");
  chip.className = "status";
  chip.textContent = String(status);
  if (status >= 500) chip.dataset["tone"] = "server";
  else if (status >= 400) chip.dataset["tone"] = "client";
  else if (status >= 300) chip.dataset["tone"] = "redirect";
  segment(parent).append(chip);
}

/**
 * Time, colored by how it feels in development: under 300 ms fine, under 1 s slow, beyond very slow. A time where a
 * trace was cut (`cut`) isn't how slow it was: never colored.
 */
function addTime(parent: HTMLElement, ms: number, cut = false): void {
  const seg = segment(parent);
  const speed = cut ? undefined : speedOf(ms);
  if (speed) seg.dataset["speed"] = speed;
  seg.innerHTML = ICONS.clock;
  seg.append(...timeParts(ms));
}

/** As on the panel's list: under 300 ms fine, under a second slow, beyond very slow. */
function speedOf(ms: number): "slow" | "very-slow" | undefined {
  if (ms >= 1000) return "very-slow";
  return ms >= 300 ? "slow" : undefined;
}

/** A time as the panel's list and the card say it ("0.5 ms", "88 ms", "1.2 s"): its number bold, its unit after. */
function timeParts(ms: number): HTMLElement[] {
  const [number = "", word = ""] = duration(ms * 1000).split(" ");
  const value = document.createElement("b");
  value.textContent = number;
  const unit = document.createElement("span");
  unit.className = "unit";
  unit.textContent = word;
  return [value, unit];
}

/**
 * A running thing's time so far (from `start`, epoch ms) as the pill writes a time: PENDING on its first frame;
 * stopped at `until` (epoch µs: lib/live clockOf).
 */
function runningParts(start: number, until: number | undefined): HTMLElement[] {
  const now = clockOf(until);
  const time = runningTime(start * 1000, now);
  if (time !== PENDING) return timeParts(Math.max(0, now - start));
  const value = document.createElement("b");
  value.textContent = PENDING;
  return [value];
}

/** In flight: the ring and the time so far (from `start`, epoch ms), ticking as the pill draws again, up to `until`. */
function addRunning(parent: HTMLElement, start: number, until?: number): void {
  const seg = segment(parent);
  seg.dataset["state"] = "running";
  const ring = document.createElement("span");
  ring.className = "running";
  ring.setAttribute("aria-hidden", "true");
  seg.append(ring, ...runningParts(start, until));
  seg.title = runningLabel(start * 1000, clockOf(until));
}

/** Cut with a call unanswered: the hourglass and "no answer yet", its note in the tooltip. */
function addNoAnswer(parent: HTMLElement, at: number | null): void {
  const seg = segment(parent);
  seg.append(noAnswer(at));
}

/** The hourglass and "no answer yet": the pill's and the card's. */
export function noAnswer(at: number | null): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "no-answer";
  mark.dataset["state"] = "cut";
  mark.innerHTML = ICONS.hourglass;
  mark.append(NO_ANSWER);
  mark.title = cutNote(at);
  return mark;
}

/** Its queries, "…" while they aren't known (its chain not counted yet). */
function addQueries(parent: HTMLElement, queries: number | null): void {
  const seg = segment(parent);
  seg.innerHTML = ICONS.db;
  const value = document.createElement("b");
  if (queries === null) {
    value.className = "pending";
    value.textContent = PENDING;
    seg.append(value);
    seg.title = "SQL queries: not known yet";
    return;
  }
  value.textContent = String(queries);
  seg.append(value);
  seg.title = `${queries} SQL ${queries === 1 ? "query" : "queries"}`;
}

/** A view's calls down its chain: the panel's HTTP calls tab's count, under its icon; its own among them in its title. */
function addCalls(parent: HTMLElement, calls: number, own: number): void {
  const seg = segment(parent);
  seg.innerHTML = ICONS.calls;
  const value = document.createElement("b");
  value.textContent = String(calls);
  seg.append(value);
  seg.title = chainScope("http", calls, own, "this view");
}

function addIssues(parent: HTMLElement, issues: number, tone: "warn" | "error"): void {
  const pill = document.createElement("span");
  pill.className = "issues";
  pill.dataset["tone"] = tone;
  pill.innerHTML = ICONS.alert;
  pill.append(`${issues} ${issues === 1 ? "issue" : "issues"}`);
  segment(parent).append(pill);
}

/**
 * What its tasks ran into, apart from its own: the Tasks icon, as each segment has its own, then the chips its own
 * failures and issues have, red ones first. The tooltip says whose they are.
 */
function addTaskIssues(parent: HTMLElement, info: TraceInfo): void {
  const chips = [
    info.taskFailed ? chip("failed", ICONS.failed, `${info.taskFailed} failed`) : null,
    info.taskIssues ? chip("issues", ICONS.alert, plural(info.taskIssues, "issue", "issues")) : null,
  ].filter((item) => item !== null);
  if (!chips.length) return;
  const seg = segment(parent);
  seg.className = "seg tasks";
  seg.innerHTML = ICONS.tasks;
  seg.append(...chips);
  seg.title = `${tasksPart(info).slice(3)}, the ones this request enqueued: open the panel to see them`;
}

function chip(className: string, icon: string, text: string): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  element.innerHTML = icon;
  element.append(text);
  return element;
}

/**
 * The rest of the page, after the latest request's numbers: how many requests it made, in the same neutral style as
 * the other numbers, and how many of the others failed in red, as their own chip, so "16" never reads as 16
 * failures. No tooltip: the hover card lists them.
 */
function addPage(parent: HTMLElement, all: readonly TraceInfo[], flights: number): void {
  const count = all.length + flights;
  const failed = othersFailed(all);
  const more = isFailure(all.at(-1));
  const seg = segment(parent);
  seg.className = "seg page";
  seg.innerHTML = ICONS.layers;
  const value = document.createElement("b");
  value.textContent = String(count);
  const unit = document.createElement("span");
  unit.className = "unit";
  unit.textContent = "requests";
  seg.append(value, unit);
  if (failed) {
    const chip = document.createElement("span");
    chip.className = "failed";
    chip.innerHTML = ICONS.failed;
    // Next to a red status: "1 more failed", so it isn't read as that one again.
    chip.append(more ? `${failed} more failed` : `${failed} failed`);
    seg.append(chip);
  }
}

function isFailure(info: TraceInfo | undefined): boolean {
  return (info?.status ?? 200) >= 500;
}

/** The shown (latest) request's failure is already its status: the page count names the others' failures. */
function othersFailed(all: readonly TraceInfo[]): number {
  return all.slice(0, -1).filter(isFailure).length;
}

/** "5 requests on this page, 1 other one failed", or nothing for a page alone. */
function pageLine(all: readonly TraceInfo[], flights: number): string[] {
  const count = all.length + flights;
  if (count < 2) return [];
  const failed = othersFailed(all);
  return [
    `${count} requests on this page${flights ? `, ${flights} in flight` : ""}${failed ? `, ${plural(failed, "other one", "other ones")} failed` : ""}`,
  ];
}

/** The pill read aloud: the shown request (one in flight first), the page's count, the runtime. */
function pillLabel(
  all: readonly TraceInfo[],
  flights: readonly Flight[],
  runtime: string | undefined,
  counted: (info: TraceInfo) => Counted,
): string {
  const flight = flights.at(-1);
  const shown = all.at(-1) ?? {};
  const head = flight
    ? `${title(flightInfo(flight))}, ${runningLabel(flight.start * 1000)}`
    : line(shown, counted(shown));
  const summary = [head, ...pageLine(all, flights.length), ...(runtime ? [`Served by ${runtime}`] : [])];
  return `tracepanel: ${summary.join(". ")}`;
}

/** The worst state of the page's requests: an error, else a finding, else ok. */
function verdict(all: readonly TraceInfo[], counted: (info: TraceInfo) => Counted): "ok" | "warn" | "error" {
  return all
    .map((info) => state({ ...info, issues: counted(info).issues }))
    .reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "ok");
}

/**
 * A request's numbers as the pill says them, the panel's list's: its whole chain's once counted (a BFF's request ran no
 * query itself, the services it called did), its own where it called no app; queries null while not known yet.
 */
export interface Counted {
  queries: number | null;
  issues: number;
}

/** One request's segments: its name, status, time, queries and findings. */
function addRequest(parent: HTMLElement, shown: TraceInfo, pulse: boolean, counted: Counted): void {
  addName(parent, shown, pulse);
  addStatus(parent, shown.status);
  addTime(parent, shown.totalMs ?? 0);
  addQueries(parent, counted.queries);
  // Findings are amber whatever else happened: a failure says so in its status, and in the page's count.
  if (counted.issues) addIssues(parent, counted.issues, "warn");
  addTaskIssues(parent, shown);
}

/** A request still in flight: its name, the ring and its time so far; no status, its numbers pending. */
function addFlight(parent: HTMLElement, flight: Flight): void {
  addName(parent, flightInfo(flight), false);
  addRunning(parent, flight.start);
  addQueries(parent, null);
}

/** A request in flight as a request is named: its GraphQL operation, else its method and path. */
export function flightInfo(flight: Flight): TraceInfo {
  return { name: flight.name, method: flight.method, url: flight.url };
}

function addName(parent: HTMLElement, info: TraceInfo, pulse: boolean): void {
  const name = document.createElement("span");
  name.className = "name";
  // A request's method in its badge, as in the console's lists; a GraphQL operation by its name.
  name.append(...nameWithMethod(title(info)));
  name.title = title(info);
  if (pulse) name.dataset["pulse"] = "";
  segment(parent).append(name);
}

/** What the widget already knows from response headers: lets the panel show a request before it is stored. */
export interface EntrySummary {
  name: string;
  status: number | null;
  /** Unix epoch microseconds. */
  start: number;
  /** Microseconds. */
  duration: number;
  queries: number;
  issues: number;
  /** Which findings (n+1, duplicates…), once the agent has them: the panel's row names them before its trace loads. */
  kinds?: string[] | undefined;
  htmx?: HtmxInfo | undefined;
  /** A view or an action recorded in the browser, not a request: its requests are listed under it. */
  kind?: "page" | undefined;
  failed?: boolean | undefined;
  /** In flight (lib/live): a request the page still waits for, a view still open. Its time ticks from `start`. */
  open?: boolean | undefined;
  /** An open view whose calls have all answered: its time stops here (epoch µs, the last answer) until it ends. */
  until?: number | undefined;
  /** A view the SPA was sent to at once from another route ("/sms-campaigns"), which left the list for it. */
  redirectedFrom?: string | undefined;
}

/** A traced request made in this browser tab: a page load (parent null) or a fetch/XHR of that page. */
export interface TabEntry {
  id: string;
  parent: string | null;
  summary?: EntrySummary | undefined;
}

/**
 * The tab's list with this view or action in it: a new row (an empty view of the same page leaves, and so does a view
 * the SPA redirected from at once, the new one saying so), or its own updated. `load`: the page's first view.
 */
function withPage(tab: TabEntry[], announced: PageAnnouncement, load: string | null): TabEntry[] {
  const entry = pageEntry(announced);
  const at = tab.findIndex((item) => item.id === announced.id);
  if (at === -1) return foldRedirect(dropEmptyView(tab, announced.name), entry, load);
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
function foldRedirect(tab: TabEntry[], entry: TabEntry, load: string | null): TabEntry[] {
  const last = tab.at(-1);
  const before = last?.summary;
  const next = entry.summary;
  if (!(last && before && next && isView(last) && isView(entry) && last.id !== load)) return [...tab, entry];
  const empty = !(before.open || before.failed) && !tab.some((item) => item.parent === last.id);
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
function countedBy(info: TraceInfo, facts: ChainFacts | "own" | undefined): Counted {
  if (facts === undefined) return { queries: null, issues: 0 };
  if (facts === "own" || facts.counts.traces < 2) return ownCounts(info);
  return { queries: facts.counts.queries, issues: facts.counts.issues };
}

/** A request's own numbers, as its Server-Timing says them. */
function ownCounts(info: TraceInfo): Counted {
  return { queries: info.queries ?? 0, issues: info.issues ?? 0 };
}

/** A request in flight as the panel lists it: under this page, its time ticking, until its answer names its trace. */
function flightEntry(flight: Flight, parent: string | null): TabEntry {
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
    },
  };
}

function summaryOf(info: TraceInfo): EntrySummary {
  const duration = Math.round((info.totalMs ?? 0) * 1000);
  return {
    name: title(info),
    status: info.status ?? null,
    start: Date.now() * 1000 - duration,
    duration,
    queries: info.queries ?? 0,
    issues: info.issues ?? 0,
    htmx: info.htmx,
  };
}

const PANEL_KEY = "tracepanel:panel";

/** Where the panel sits, like browser devtools: along the bottom (the default) or along the right edge. */
type Dock = "right" | "bottom";

interface PanelState {
  open: boolean;
  dock: Dock;
  /** Width in px chosen by dragging the panel edge (docked right). */
  width?: number | undefined;
  /** Height in px chosen by dragging the panel edge (docked at the bottom). */
  height?: number | undefined;
}

const DEFAULT_WIDTH = 600;
const MIN_WIDTH = 360;
const DEFAULT_HEIGHT = 360;
const MIN_HEIGHT = 200;

/** Panel state survives navigations within the browser tab. */
function loadPanel(): PanelState {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(PANEL_KEY) ?? "{}");
    if (typeof parsed === "object" && parsed !== null) {
      const width = "width" in parsed && typeof parsed.width === "number" ? parsed.width : undefined;
      const height = "height" in parsed && typeof parsed.height === "number" ? parsed.height : undefined;
      return {
        open: "open" in parsed && parsed.open === true,
        dock: "dock" in parsed && parsed.dock === "right" ? "right" : "bottom",
        width,
        height,
      };
    }
  } catch {
    // Unreadable storage: start closed.
  }
  return { open: false, dock: "bottom" };
}

function savePanel(state: PanelState): void {
  try {
    sessionStorage.setItem(PANEL_KEY, JSON.stringify(state));
  } catch {
    // Storage can be blocked: the state then lasts only for this page.
  }
}

/** How long a just-finished fetch/XHR stays on the badge. */

const TAB_KEY = "tracepanel:tab";
const TAB_LIMIT = 200;

function isEntry(value: unknown): value is TabEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { id?: unknown; parent?: unknown };
  return typeof entry.id === "string" && (entry.parent === null || typeof entry.parent === "string");
}

const RUNTIME_KEY = "tracepanel:runtime";

/**
 * What served the page: as its server says, else what answered this tab's calls, learned from the first one's trace
 * (an SPA) and kept for the tab, so a reload shows the mark before its first request.
 */
function learnedRuntime(given: string | undefined): string | undefined {
  if (given) return given;
  try {
    return sessionStorage.getItem(RUNTIME_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function learnRuntime(label: string | undefined): void {
  try {
    if (label) sessionStorage.setItem(RUNTIME_KEY, label);
  } catch {
    // Storage blocked: the next page learns it again.
  }
}

/** Tab history lives in sessionStorage: per browser tab, survives navigations, gone when the tab closes. */
// The requests that answered with a redirect on the way to this page (a form's POST, then 302): the app names them in
// this cookie, as the page they led to is the first this widget sees.
const REDIRECTS = "tracepanel_redirect";

/** The ids the redirect cookie names, the cookie gone once read: each request shows once. */
function takeRedirects(): string[] {
  const pair = document.cookie.split("; ").find((item) => item.startsWith(`${REDIRECTS}=`));
  if (!pair) return [];
  document.cookie = `${REDIRECTS}=; Max-Age=0; Path=/; SameSite=Lax`;
  return decodeURIComponent(pair.slice(REDIRECTS.length + 1))
    .split(",")
    .filter((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id));
}

/** The tab's requests with those that redirected to this page, in the order they came, before it. */
function withRedirects(entries: TabEntry[]): TabEntry[] {
  const known = new Set(entries.map((entry) => entry.id));
  const added = takeRedirects().filter((id) => !known.has(id));
  if (!added.length) return entries;
  const next = [...entries, ...added.map((id) => ({ id, parent: null }))];
  saveTab(next);
  return next;
}

function loadTab(): TabEntry[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(TAB_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function saveTab(entries: readonly TabEntry[]): void {
  try {
    sessionStorage.setItem(TAB_KEY, JSON.stringify(entries.slice(-TAB_LIMIT)));
  } catch {
    // Storage can be full or blocked: the history then lasts only for this page.
  }
}

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
function storedMs(row: ListedTrace, header: number | undefined): number | undefined {
  return row.duration === undefined ? header : row.duration / 1000;
}

/** A tab entry's summary with what the agent found: its issues, their kinds and the stored time. */
function stored(summary: EntrySummary, row: ListedTrace): EntrySummary {
  return { ...summary, issues: row.issues ?? 0, kinds: row.issue_kinds, duration: row.duration ?? summary.duration };
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

  /** What the panel lists: the tab's requests, then those in flight (never stored: a reload ends them). */
  function entries(): TabEntry[] {
    const parent = currentPage();
    return [...tab.map(withQuiet), ...flights().map((flight) => flightEntry(flight, parent))];
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
    const ends = tab.flatMap((entry) =>
      entry.parent === id && entry.id !== own && entry.summary ? [entry.summary.start + entry.summary.duration] : [],
    );
    return ends.length > 0 ? Math.max(...ends) : undefined;
  }

  /** A view still open, its time stopped where it went quiet (quietSince), as the panel's list shows it. */
  function withQuiet(entry: TabEntry): TabEntry {
    const until = entry.summary?.open && entry.summary.kind === "page" ? quietSince(entry.id) : undefined;
    return until === undefined || !entry.summary ? entry : { ...entry, summary: { ...entry.summary, until } };
  }

  function sendTab(): void {
    if (frame?.contentWindow && panelUrl) {
      const current = currentPage();
      frame.contentWindow.postMessage(
        {
          type: "tracepanel:tab",
          entries: entries(),
          current,
          scope: current ? [current, ...scope] : [],
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

  /**
   * The pill describes one request, named, and every number on it is that request's: the newest still in flight,
   * else the latest done (the page when it loads, then each AJAX call), as the panel's Follow new shows it. On the
   * right, the rest of this page: how many requests, how many failed; the ring is the worst of them all.
   */
  function render(): void {
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
    if (all.length + flying.length > 1) addPage(stats, all, flying.length);
    fitBadge();
    badge.dataset["verdict"] = verdict(all, counted);
    // No title: the hover card shows all of it (and more); screen readers get the summary.
    badge.setAttribute("aria-label", pillLabel(all, flying, runtime, counted));
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
    badge.dataset["verdict"] = view?.status === "error" ? "error" : facts?.counts.issues ? "warn" : "ok";
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
    const passing = inFlight.some((flight) => Date.now() - flight.start < FLIGHT_SHOWN_MS + TICK_MS);
    if (flights().length !== shownBefore || passing) sendTab();
  }

  /**
   * Once a view or a request ends: what its calls did down its chain, asked from the console while the pill shows it.
   * Its numbers are pending until the first answer; with none (unreachable, never stored) its own are all there are.
   */
  function followFacts(id: string, wanted: () => boolean): void {
    if (!panelUrl) return;
    void followChain(
      fetchJson,
      panelUrl,
      id,
      wanted,
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
    if (!ended.open) followFacts(ended.id, () => view?.id === ended.id);
  }

  /** A request just answered: its chain, while it is the pill's. */
  function followRequest(info: TraceInfo): void {
    const id = info.trace;
    if (!id) return;
    followFacts(id, () => requests().includes(info));
  }

  /** A request of the page left: it takes off, or lands with what its answer said. */
  watcher = {
    start: (flight) => {
      inFlight.push(flight);
      keepTicking();
      // An open view's time runs again with its new call (quietSince), in the panel's list too.
      if (view?.open) sendTab();
    },
    end: (flight, info) => {
      const at = inFlight.indexOf(flight);
      if (at !== -1) inFlight.splice(at, 1);
      if (info) record(info);
      else {
        render();
        sendTab();
      }
    },
  };

  /** A page htmx loaded (a boosted link or form): it heads the list, and what follows is its requests. */
  function navigate(info: TraceInfo): void {
    page = info;
    pageCleared = false;
    later.length = 0;
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
    info.totalMs = storedMs(row, info.totalMs);
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
    tab = underLoadView(withPage(tab, announced, loadView), announced);
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
    if (id !== loadView) later.length = 0;
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
    return entries.map((item) => (item.id === own && item.parent === null ? { ...item, parent: announced.id } : item));
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
    flights,
    view: () => (view ? { view, facts: viewFacts(), until: view.open ? quietSince(view.id) : undefined } : null),
    counted,
    page: ownPage,
    api: panelUrl,
    panelOpen: () => panel.hasAttribute("data-open"),
    open,
    fetch: nativeFetch,
  });

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

function number(value: string | undefined): number | undefined {
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
