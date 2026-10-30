// Corner badge, fetch and XHR capture, slide-out panel (iframe inside Shadow DOM).

import TOKENS from "virtual:tracepanel-tokens";
import type { ChainCounts } from "@tracepanel/ui/lib/chainCounts";
import { plural } from "@tracepanel/ui/lib/plural";
import { APP_ICON_SVG, runtimeKind, runtimeMark, runtimeName, traceRuntime } from "@tracepanel/ui/lib/runtime";
import { CARD_STYLE, mountCard, nameWithMethod } from "./card";
import { countsKey, followViewChain } from "./viewChain";

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
 * server page's load), with no time while it still loads.
 */
function addView(parent: HTMLElement, view: PageAnnouncement, counts: ChainCounts | null): void {
  addName(parent, { name: `VIEW ${view.name}` }, false);
  if (view.open) return;
  addTime(parent, view.duration / 1000);
  // What its calls did in the apps they reached, as the panel's tabs count it: a request's numbers, for a view.
  if (!counts) return;
  addQueries(parent, counts.queries);
  addCalls(parent, counts.calls);
  if (counts.issues) addIssues(parent, counts.issues, "warn");
}

/** Nothing on this page yet: its server didn't trace it and nothing records it in the browser. */
function addWaiting(parent: HTMLElement): void {
  const idle = document.createElement("span");
  idle.className = "idle";
  idle.textContent = "Waiting for requests";
  segment(parent).append(idle);
}

function idleLabel(view: PageAnnouncement | null, runtime: string | undefined, counts: ChainCounts | null): string {
  const shown = view ? `view of ${view.name}${countsLine(counts)}` : "no requests yet";
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
  @media (prefers-reduced-motion: reduce) { .panel, .badge, .resize::after { transition: none; } .name[data-pulse] { animation: none; } }
`;

const PENDING = "pending";
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
      if (desc === PENDING) info.issuesPending = true;
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
 * fetch/XHR are wrapped as soon as widget.min.js runs, at the top of <head>: pages that keep a reference to fetch while
 * loading (GraphiQL, Swagger, SPA clients) still go through the wrapper. Requests seen before the badge exists wait
 * here and show up when it mounts.
 */
const pending: TraceInfo[] = [];
// The widget's own calls to the console go around the wrapper: they are not the page's requests.
const nativeFetch = window.fetch.bind(window);
let deliver: ((info: TraceInfo) => void) | null = null;
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  watchHtmx();
  intercept((info) => (deliver ? deliver(info) : pending.push(info)));
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

function intercept(onRequest: (info: TraceInfo) => void): void {
  const originalFetch = window.fetch;
  window.fetch = async function (this: unknown, input: globalThis.RequestInfo | URL, init?: RequestInit) {
    const response = await originalFetch.call(this, input, init);
    try {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const info = fromResponse(method, response.url, response.status, (name) => response.headers.get(name));
      // A recording that wrapped fetch after the widget (one started by the app's code, once the widget loaded)
      // marks the Response only once this call has returned to it: read the mark after that, in the next task.
      if (info) afterMark(response, () => onRequest({ ...info, page: pageOf(response) }));
    } catch {
      // Never break the page because of the widget.
    }
    return response;
  } as typeof window.fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.addEventListener("loadend", () => {
      try {
        const info = fromResponse(method.toUpperCase(), this.responseURL || String(url), this.status, (name) =>
          this.getResponseHeader(name),
        );
        if (info) onRequest({ ...info, htmx: htmxRequests.get(this), page: pageOf(this) });
      } catch {
        // Never break the page because of the widget.
      }
    });
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
}

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

function line(info: TraceInfo): string {
  const issues = info.issues ? ` · ${info.issues} issue${info.issues === 1 ? "" : "s"}` : "";
  return `${title(info)} → ${info.status ?? "?"} · ${Math.round(info.totalMs ?? 0)} ms · ${info.queries ?? 0} q${issues}${tasksPart(info)}`;
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

/** Time, colored by how it feels in development: under 300 ms fine, under 1 s slow, beyond very slow. */
function addTime(parent: HTMLElement, ms: number): void {
  const seg = segment(parent);
  if (ms >= 1000) seg.dataset["speed"] = "very-slow";
  else if (ms >= 300) seg.dataset["speed"] = "slow";
  seg.innerHTML = ICONS.clock;
  const value = document.createElement("b");
  value.textContent = ms >= 1000 ? (ms / 1000).toFixed(1) : String(Math.round(ms));
  const unit = document.createElement("span");
  unit.className = "unit";
  unit.textContent = ms >= 1000 ? "s" : "ms";
  seg.append(value, unit);
}

function addQueries(parent: HTMLElement, queries: number): void {
  const seg = segment(parent);
  seg.innerHTML = ICONS.db;
  const value = document.createElement("b");
  value.textContent = String(queries);
  seg.append(value);
  seg.title = `${queries} SQL ${queries === 1 ? "query" : "queries"}`;
}

/** A view's calls down its chain: the panel's HTTP calls tab's count, under its icon. */
function addCalls(parent: HTMLElement, calls: number): void {
  const seg = segment(parent);
  seg.innerHTML = ICONS.calls;
  const value = document.createElement("b");
  value.textContent = String(calls);
  seg.append(value);
  seg.title = `${plural(calls, "HTTP call", "HTTP calls")} down its calls`;
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
function addPage(parent: HTMLElement, all: readonly TraceInfo[]): void {
  const count = all.length;
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
function pageLine(all: readonly TraceInfo[]): string[] {
  if (all.length < 2) return [];
  const failed = othersFailed(all);
  return [
    `${all.length} requests on this page${failed ? `, ${plural(failed, "other one", "other ones")} failed` : ""}`,
  ];
}

/** The pill read aloud: the shown request, the page's count, the runtime. */
function pillLabel(all: readonly TraceInfo[], runtime: string | undefined): string {
  const summary = [line(all.at(-1) ?? {}), ...pageLine(all), ...(runtime ? [`Served by ${runtime}`] : [])];
  return `tracepanel: ${summary.join(". ")}`;
}

/** Which request the pill is about: its method and path (a GraphQL operation by its name). */
/** The worst state of the page's requests: an error, else a finding, else ok. */
function verdict(all: readonly TraceInfo[]): "ok" | "warn" | "error" {
  return all.map(state).reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "ok");
}

/** One request's segments: its name, status, time, queries and findings. */
function addRequest(parent: HTMLElement, shown: TraceInfo, pulse: boolean): void {
  addName(parent, shown, pulse);
  addStatus(parent, shown.status);
  addTime(parent, shown.totalMs ?? 0);
  addQueries(parent, shown.queries ?? 0);
  // Findings are amber whatever else happened: a failure says so in its status, and in the page's count.
  if (shown.issues) addIssues(parent, shown.issues, "warn");
  addTaskIssues(parent, shown);
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
}

/** A traced request made in this browser tab: a page load (parent null) or a fetch/XHR of that page. */
export interface TabEntry {
  id: string;
  parent: string | null;
  summary?: EntrySummary | undefined;
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
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "parent" in value &&
    (value.parent === null || typeof value.parent === "string")
  );
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
 * What served the page, as the console's RuntimeIcon draws it: its owner's mark where allowed, else the plain app icon,
 * and its name. An unknown runtime keeps its language's first word.
 */
function showRuntime(element: HTMLElement, label: string | undefined): void {
  if (!label) return;
  const kind = runtimeKind(label);
  if (kind === null) {
    element.textContent = label.split(" · ")[0]?.split(" ")[0] ?? "";
    return;
  }
  const mark = runtimeMark(kind);
  if (!mark) {
    element.innerHTML = APP_ICON_SVG;
    element.append(runtimeName(kind));
    return;
  }
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", mark.path);
  path.setAttribute("fill", mark.color ?? "currentColor");
  svg.append(path);
  element.append(svg, runtimeName(kind));
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
  // What the view's calls did down its chain, once it ended and the console answered: by the view's id.
  let viewCounts: { id: string; counts: ChainCounts } | null = null;
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
    return pageCleared ? null : firstOf(page?.trace, view?.id);
  }

  function sendTab(): void {
    if (frame?.contentWindow && panelUrl) {
      frame.contentWindow.postMessage(
        {
          type: "tracepanel:tab",
          entries: tab,
          current: currentPage(),
          runtime: runtime ?? null,
        },
        panelUrl.origin,
      );
    }
  }

  /** This tab's requests on this page, oldest first: the page (unless cleared) and its AJAX calls. */
  function requests(): TraceInfo[] {
    return [...(page && !pageCleared ? [page] : []), ...later];
  }

  /**
   * The pill describes one request, named, and every number on it is that request's: the latest (the page when it
   * loads, then each AJAX call), as the panel's Follow new shows it. On the right, the rest of this page: how many
   * requests, how many failed; the ring is the worst of them all.
   */
  function render(): void {
    const all = requests();
    if (all.length === 0) renderIdle();
    else renderPill(all);
  }

  /** The latest request, with the page's count and verdict. */
  function renderPill(all: TraceInfo[]): void {
    stats.textContent = "";
    addRequest(stats, all.at(-1) ?? {}, pulse);
    if (all.length > 1) addPage(stats, all);
    fitBadge();
    badge.dataset["verdict"] = verdict(all);
    // No title: the hover card shows all of it (and more); screen readers get the summary.
    badge.setAttribute("aria-label", pillLabel(all, runtime));
  }

  /**
   * Nothing traced on this page yet: its server didn't trace it (an SPA's dev server served it) and it made no calls.
   * The pill says so, with no request, time or queries to show.
   */
  function renderIdle(): void {
    stats.textContent = "";
    const counts = view && viewCounts?.id === view.id ? viewCounts.counts : null;
    if (view) addView(stats, view, counts);
    else addWaiting(stats);
    fitBadge();
    badge.dataset["verdict"] = view?.status === "error" ? "error" : counts?.issues ? "warn" : "ok";
    badge.setAttribute("aria-label", idleLabel(view, runtime, counts));
  }

  /** Once a view ends: what its calls did down its chain, asked from the console while the pill shows it. */
  function followView(ended: PageAnnouncement): void {
    if (!panelUrl) return;
    const wanted = () => view?.id === ended.id && requests().length === 0;
    void followViewChain(
      fetchJson,
      panelUrl,
      ended.id,
      wanted,
      (counts) => {
        if (viewCounts?.id === ended.id && countsKey(viewCounts.counts) === countsKey(counts)) return;
        viewCounts = { id: ended.id, counts };
        render();
      },
      UNREACHABLE,
    );
  }

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
    if (!announced.name.includes(" › ")) {
      view = announced;
      render();
      if (!announced.open) followView(announced);
    }
    const entry: TabEntry = {
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
      },
    };
    const at = tab.findIndex((item) => item.id === announced.id);
    tab =
      at === -1
        ? [...dropEmptyView(tab, announced.name), entry]
        : tab.map((item, index) => (index === at ? entry : item));
    saveTab(tab);
    sendTab();
  }

  /** What a request is listed under: the view or action that made it, else the page it was made on. */
  function parentOf(info: TraceInfo): string | null {
    return info.page ?? page?.trace ?? null;
  }

  function record(info: TraceInfo): void {
    void resolveIssues(info);
    void resolveRuntime(info);
    void followRuns(info);
    if (info.htmx?.boosted) {
      navigate(info);
      return;
    }
    later.push(info);
    if (info.trace) {
      tab = [...tab, { id: info.trace, parent: parentOf(info), summary: summaryOf(info) }];
      saveTab(tab);
    }
    // The latest request takes the pill (and keeps it until the next one), with a short pulse.
    pulse = true;
    render();
    pulse = false;
    sendTab();
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
  }

  function close(): void {
    panel.toggleAttribute("data-open", false);
    badge.setAttribute("aria-expanded", "false");
    makeRoom();
    savePanel(panelState());
  }

  // Hover (or keyboard focus): the request at a glance, before opening the panel.
  mountCard(root, badge, {
    requests,
    page: () => (pageCleared ? null : page),
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
      sendTab();
    }
  });

  render();
  if (page) {
    void resolveIssues(page);
    void followRuns(page);
  }
  listen();
  // The browser recording's views and actions: those announced before the widget mounted, then each as it comes.
  followPages(recordPage);
  deliver = record;
  for (const info of pending.splice(0)) record(info);

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
        issues: data["tracepanelIssues"] === PENDING ? undefined : number(data["tracepanelIssues"]),
        issuesPending: data["tracepanelIssues"] === PENDING,
      },
      runtime: data["tracepanelRuntime"],
    });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
