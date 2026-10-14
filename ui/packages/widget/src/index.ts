// Corner badge, fetch and XHR capture, slide-out panel (iframe inside Shadow DOM).
import { RUNTIME_PATHS, runtimeKind, runtimeName, traceRuntime } from "@tracepanel/ui/lib/runtime";
import { CARD_STYLE, mountCard, plural } from "./card";

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
function addView(parent: HTMLElement, view: PageAnnouncement): void {
  addName(parent, { name: `VIEW ${view.name}` }, false);
  if (!view.open) addTime(parent, view.duration / 1000);
}

/** Nothing on this page yet: its server didn't trace it and nothing records it in the browser. */
function addWaiting(parent: HTMLElement): void {
  const idle = document.createElement("span");
  idle.className = "idle";
  idle.textContent = "Waiting for requests";
  segment(parent).append(idle);
}

function idleLabel(view: PageAnnouncement | null, runtime: string | undefined): string {
  const shown = view ? `view of ${view.name}, no requests yet` : "no requests yet";
  return `tracepanel: ${shown}${runtime ? `. Served by ${runtime}` : ""}`;
}

function firstOf(...ids: (string | undefined)[]): string | null {
  return ids.find((id) => id !== undefined) ?? null;
}

/** A view's name has no action after its path: "/books", not "/books › click "Save"". */
function isView(entry: TabEntry | undefined): boolean {
  return entry?.summary?.kind === "page" && !entry.summary.name.includes(" › ");
}

/**
 * Before a new view goes in: the last one, when nothing came after it (no request, no action), leaves the list. A
 * reload of an SPA's page would otherwise stack views with nothing under them; the latest view always stays.
 */
function dropEmptyView(tab: TabEntry[], name: string): TabEntry[] {
  const last = tab.at(-1);
  if (!name.includes(" › ") && isView(last) && !tab.some((item) => item.parent === last?.id)) return tab.slice(0, -1);
  return tab;
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

/** Follows the console's theme choice (same origin, so the same localStorage) or the OS when it is Auto. */
/** The panel's theme choice ("light", "dark", "system"), kept in this page's storage for the badge. */
function storeTheme(choice: string): void {
  try {
    if (choice === "light" || choice === "dark") localStorage.setItem(THEME_KEY, choice);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    // Blocked storage: the badge follows the OS.
  }
}

function watchTheme(host: HTMLElement): () => void {
  const apply = () => {
    let choice: string | null = null;
    try {
      choice = localStorage.getItem(THEME_KEY);
    } catch {
      // Blocked storage: follow the OS.
    }
    const dark = choice === "dark" || (choice !== "light" && window.matchMedia(DARK).matches);
    host.dataset["theme"] = dark ? "dark" : "light";
  };
  apply();
  window.matchMedia(DARK).addEventListener("change", apply);
  // Fired here when the panel (an iframe on this origin) or another tab changes the theme.
  window.addEventListener("storage", (event) => event.key === THEME_KEY && apply());
  return apply;
}

const STYLE = `
  :host { all: initial; }
  /* A dark pill in the corner: the request's verdict at a glance. Its ring is the verdict: none when all is well,
     amber when something wants a look, coral when it failed. */
  .badge {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    display: flex; align-items: center; gap: 0; max-width: calc(100vw - 32px);
    height: 42px; padding: 0 6px 0 10px; border: 1px solid rgb(255 255 255 / 0.09); border-radius: 999px;
    background: #0e1117; color: #e7e9ef;
    box-shadow: 0 12px 32px rgb(10 12 17 / 0.32), 0 2px 6px rgb(10 12 17 / 0.2), inset 0 1px rgb(255 255 255 / 0.05);
    font: 500 13px/1 "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums; cursor: pointer;
    transition: right 180ms ease-out, box-shadow 180ms ease-out, border-color 120ms ease-out;
  }
  .badge[data-verdict="warn"] { border-color: rgb(245 181 68 / 0.45); box-shadow: 0 0 0 4px rgb(245 181 68 / 0.16), 0 12px 32px rgb(10 12 17 / 0.32); }
  /* A failure is the one thing not to miss: a solid coral edge and a stronger halo. */
  .badge[data-verdict="error"] { border-color: rgb(255 107 94 / 0.9); box-shadow: 0 0 0 4px rgb(255 107 94 / 0.3), 0 12px 32px rgb(10 12 17 / 0.32); }
  /* Hover answers in place: the border, in the verdict's colour, gets stronger; the pill stays where it is. */
  .badge:hover { border-color: rgb(255 255 255 / 0.24); }
  .badge[data-verdict="warn"]:hover { border-color: rgb(245 181 68 / 0.85); }
  .badge[data-verdict="error"]:hover { border-color: rgb(255 107 94); }
  /* From the keyboard: the accent, thin, as everywhere in the UI (not the logo's lime, which read as a verdict). */
  .badge:focus-visible { outline: 1.5px solid #a587ff; outline-offset: 3px; }
  .brand { display: flex; align-items: center; padding-right: 8px; }
  .brand svg { width: 22px; height: 22px; }
  .runtime { align-self: center; display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; padding: 4px 7px; border-radius: 999px; background: rgb(255 255 255 / 0.07); color: #b9bfcd; font-size: 11px; font-weight: 600; letter-spacing: 0.01em; }
  .brand .runtime svg { width: 12px; height: 12px; }
  .runtime:empty { display: none; }
  .stats { display: inline-flex; align-items: center; min-width: 0; height: 100%; }
  .seg { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; white-space: nowrap; }
  .seg + .seg { border-left: 1px solid rgb(255 255 255 / 0.1); }
  .seg svg { width: 13px; height: 13px; color: #8c93a6; flex: none; }
  .seg b { color: #fff; font-weight: 600; }
  .unit { color: #8c93a6; }
  .status { padding: 3px 7px; border-radius: 999px; font: 600 11.5px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; background: rgb(184 242 92 / 0.13); color: #b8f25c; }
  .status[data-tone="redirect"] { background: rgb(157 178 255 / 0.15); color: #9db2ff; }
  .status[data-tone="client"] { background: rgb(245 181 68 / 0.15); color: #f5b544; }
  .status[data-tone="server"] { background: rgb(255 107 94 / 0.16); color: #ff8a7a; }
  .seg[data-speed="slow"] b { color: #f5b544; }
  .seg[data-speed="very-slow"] b { color: #ff8a7a; }
  .issues { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; background: rgb(245 181 68 / 0.15); color: #f5b544; font-weight: 600; font-size: 12px; }
  .seg .issues svg { color: currentColor; }
  .issues[data-tone="error"] { background: rgb(255 107 94 / 0.16); color: #ff8a7a; }
  /* The page's count: a step back from the latest request's numbers; its failures stand out on their own. */
  .page .unit { margin-left: -1px; }
  .failed { display: inline-flex; align-items: center; gap: 4px; margin-left: 3px; padding: 3px 8px; border-radius: 999px; background: rgb(255 107 94 / 0.16); color: #ff8a7a; font-weight: 600; font-size: 12px; }
  .seg .failed svg { width: 12px; height: 12px; color: currentColor; }
  .name {
    max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 6px;
    font: 500 12.5px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; color: #fff;
  }
  .name[data-pulse] { animation: pulse 700ms ease-out; }
  .idle { color: #9aa1af; font-size: 12.5px; white-space: nowrap; }
  :host([data-theme="light"]) .idle { color: #6b7280; }
  @keyframes pulse {
    from { box-shadow: 0 0 0 0 rgb(165 135 255 / 0.6); }
    to { box-shadow: 0 0 0 8px rgb(165 135 255 / 0); }
  }
  .panel {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483646;
    width: min(var(--tracepanel-width, 600px), 100vw); border-left: 1px solid rgb(255 255 255 / 0.08);
    background: #0a0c11;
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    box-shadow: -24px 0 60px rgb(10 12 17 / 0.4);
    transform: translateX(100%); visibility: hidden;
    transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), width 200ms ease-out, visibility 0s 200ms;
  }
  .panel[data-open] { transform: none; visibility: visible; transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), width 200ms ease-out; }
  .panel[data-open] ~ .badge { right: calc(min(var(--tracepanel-width, 600px), 100vw) + 16px); }
  /* No room beside the panel (a narrow window): the panel shows the request, the badge folds to its logo,
     its ring still the verdict. */
  :host([data-crowded]:not([data-dock="bottom"])) .panel[data-open] ~ .badge { width: 42px; padding: 0; justify-content: center; }
  :host([data-crowded]:not([data-dock="bottom"])) .panel[data-open] ~ .badge :is(.stats, .runtime) { display: none; }
  :host([data-crowded]:not([data-dock="bottom"])) .panel[data-open] ~ .badge .brand { padding: 0; }
  .panel iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; color-scheme: dark; }
  /* Light theme (the console's Auto / Light / Dark choice, shared through localStorage). */
  :host([data-theme="light"]) .badge {
    border-color: #e2e2dc; background: #ffffff; color: #16181d;
    box-shadow: 0 10px 28px rgb(22 24 29 / 0.12), 0 1px 3px rgb(22 24 29 / 0.08);
  }
  :host([data-theme="light"]) .badge:hover { border-color: #b9b9b1; }
  :host([data-theme="light"]) .badge:focus-visible { outline-color: #6d3fe0; }
  :host([data-theme="light"]) .badge[data-verdict="warn"] { border-color: rgb(217 119 6 / 0.45); box-shadow: 0 0 0 4px rgb(217 119 6 / 0.13), 0 10px 28px rgb(22 24 29 / 0.12); }
  :host([data-theme="light"]) .badge[data-verdict="error"] { border-color: rgb(208 52 44 / 0.85); box-shadow: 0 0 0 4px rgb(208 52 44 / 0.22), 0 10px 28px rgb(22 24 29 / 0.12); }
  :host([data-theme="light"]) .badge[data-verdict="warn"]:hover { border-color: rgb(217 119 6 / 0.85); }
  :host([data-theme="light"]) .badge[data-verdict="error"]:hover { border-color: rgb(208 52 44); }
  :host([data-theme="light"]) .seg + .seg { border-left-color: #e2e2dc; }
  :host([data-theme="light"]) .seg svg, :host([data-theme="light"]) .unit { color: #5f6470; }
  :host([data-theme="light"]) .runtime { background: #f0f0ed; color: #3a3e47; }
  :host([data-theme="light"]) .seg b, :host([data-theme="light"]) .name { color: #16181d; }
  :host([data-theme="light"]) .seg[data-speed="slow"] b { color: #b45309; }
  :host([data-theme="light"]) .seg[data-speed="very-slow"] b { color: #d0342c; }
  :host([data-theme="light"]) .status { background: rgb(98 160 20 / 0.12); color: #3d7a0c; }
  :host([data-theme="light"]) .status[data-tone="redirect"] { background: rgb(52 86 214 / 0.09); color: #3456d6; }
  :host([data-theme="light"]) .status[data-tone="client"] { background: rgb(217 119 6 / 0.1); color: #b45309; }
  :host([data-theme="light"]) .status[data-tone="server"] { background: rgb(208 52 44 / 0.09); color: #d0342c; }
  :host([data-theme="light"]) .issues { background: rgb(217 119 6 / 0.1); color: #b45309; }
  :host([data-theme="light"]) .issues[data-tone="error"] { background: rgb(208 52 44 / 0.09); color: #d0342c; }
  :host([data-theme="light"]) .failed { background: rgb(208 52 44 / 0.09); color: #d0342c; }
  :host([data-theme="light"]) .panel {
    border-left-color: #e2e2dc; background: #ffffff;
    box-shadow: -16px 0 40px rgb(22 24 29 / 0.12);
  }
  :host([data-theme="light"]) .panel iframe { color-scheme: light; }
  .panel[data-instant], .panel[data-instant] ~ .badge, .panel[data-resizing], .panel[data-resizing] ~ .badge { transition: none; }
  .panel[data-resizing] iframe { pointer-events: none; }
  .resize { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: ew-resize; z-index: 1; }
  /* As the console's sidebar: the whole edge lights up, faint on hover, full while dragging. */
  .resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: transparent; transition: background 120ms; }
  .resize:hover::after { background: rgb(165 135 255 / 0.5); }
  .panel[data-resizing] .resize::after { background: #a587ff; }
  /* Docked at the bottom, like browser devtools: full width, the height is dragged from the top edge. */
  :host([data-dock="bottom"]) .panel {
    top: auto; left: 0; width: 100vw; height: min(var(--tracepanel-height, 360px), 100vh);
    border-left: 0; border-top: 1px solid rgb(255 255 255 / 0.08);
    box-shadow: 0 -24px 60px rgb(10 12 17 / 0.3);
    transform: translateY(100%);
    transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), height 200ms ease-out, visibility 0s 200ms;
  }
  :host([data-dock="bottom"]) .panel[data-open] { transform: none; transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), height 200ms ease-out; }
  :host([data-dock="bottom"]) .panel[data-open] ~ .badge { right: 16px; bottom: calc(min(var(--tracepanel-height, 360px), 100vh) + 12px); }
  :host([data-dock="bottom"]) .resize { top: -4px; bottom: auto; left: 0; right: 0; width: auto; height: 8px; cursor: ns-resize; }
  :host([data-dock="bottom"]) .resize::after { top: 3px; bottom: auto; left: 0; right: 0; width: auto; height: 2px; }
  /* While dragging, the size follows the pointer: no transition (these selectors outrank the dock rules). */
  :host .panel[data-resizing], :host .panel[data-resizing][data-open], :host .panel[data-resizing] ~ .badge,
  :host([data-dock="bottom"]) .panel[data-resizing][data-open] { transition: none; }
  :host([data-theme="light"][data-dock="bottom"]) .panel { border-top-color: #e2e2dc; box-shadow: 0 -16px 40px rgb(22 24 29 / 0.12); }
  @media (prefers-reduced-motion: reduce) { .panel, .badge { transition: none; } .name[data-pulse] { animation: none; } }
`;

const PENDING = "pending";
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

function intercept(onRequest: (info: TraceInfo) => void): void {
  const originalFetch = window.fetch;
  window.fetch = async function (this: unknown, input: globalThis.RequestInfo | URL, init?: RequestInit) {
    const response = await originalFetch.call(this, input, init);
    try {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const info = fromResponse(method, response.url, response.status, (name) => response.headers.get(name));
      if (info) onRequest({ ...info, page: pageOf(response) });
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

function line(info: TraceInfo): string {
  const issues = info.issues ? ` · ${info.issues} issue${info.issues === 1 ? "" : "s"}` : "";
  return `${title(info)} → ${info.status ?? "?"} · ${Math.round(info.totalMs ?? 0)} ms · ${info.queries ?? 0} q${issues}`;
}

function state(info: TraceInfo): "ok" | "warn" | "error" {
  if ((info.status ?? 200) >= 500) return "error";
  return info.issues ? "warn" : "ok";
}

const SEVERITY = { ok: 0, warn: 1, error: 2 } as const;

const ICONS = {
  db: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  layers:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>',
  failed:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v4M12 17.5h.01"/></svg>',
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

function addIssues(parent: HTMLElement, issues: number, tone: "warn" | "error"): void {
  const pill = document.createElement("span");
  pill.className = "issues";
  pill.dataset["tone"] = tone;
  pill.innerHTML = ICONS.alert;
  pill.append(`${issues} ${issues === 1 ? "issue" : "issues"}`);
  segment(parent).append(pill);
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
}

function addName(parent: HTMLElement, info: TraceInfo, pulse: boolean): void {
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = title(info);
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

// biome-ignore lint/style/useNamingConvention: the API's field name.
type ListedTrace = { id: string; issues?: number; issue_kinds?: string[] };

/** One trace from a listing of traces by id, if the agent has stored it. */
function listedTrace(body: unknown, id: string | undefined): ListedTrace | undefined {
  return (body as { traces?: ListedTrace[] }).traces?.find((trace) => trace.id === id);
}

/** The mark and name of what served the page; an unknown runtime keeps its language's first word. */
function showRuntime(element: HTMLElement, label: string | undefined): void {
  if (!label) return;
  const kind = runtimeKind(label);
  if (kind === null) {
    element.textContent = label.split(" · ")[0]?.split(" ")[0] ?? "";
    return;
  }
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", RUNTIME_PATHS[kind]);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  element.append(svg, runtimeName(kind));
}

export function mount(options: WidgetOptions = {}): Widget {
  const host = document.createElement("tracepanel-widget");
  const root = host.attachShadow({ mode: "open" });
  const applyTheme = watchTheme(host);
  root.innerHTML = `
    <style>${STYLE}${CARD_STYLE}</style>
    <div class="panel" part="panel"><div class="resize" title="Drag to resize · double-click to reset"></div></div>
    <button class="badge" part="badge" type="button" aria-expanded="false">
      <span class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="6" width="26" height="5.5" rx="2.75" fill="#7c4ff0"/><rect x="9" y="13.25" width="18" height="5.5" rx="2.75" fill="#a587ff"/><rect x="15" y="20.5" width="10" height="5.5" rx="2.75" fill="#b6e24a"/></svg><span class="runtime"></span></span>
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
  const runtimeMark = query<HTMLElement>(root, ".runtime");
  // A page its server didn't label (an SPA from a dev server): what answered this tab's first traced call.
  let runtime = learnedRuntime(options.runtime);
  showRuntime(runtimeMark, runtime);
  // This page's latest view, from the browser recording: what the pill shows before the page's first request.
  let view: PageAnnouncement | null = null;
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

  function setHeight(value: number): void {
    height = Math.round(Math.min(Math.max(value, MIN_HEIGHT), window.innerHeight - 40));
    host.style.setProperty("--tracepanel-height", `${height}px`);
  }

  function setDock(value: Dock): void {
    dock = value;
    host.dataset["dock"] = value;
    frame?.contentWindow?.postMessage({ type: "tracepanel:dock", dock }, "*");
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
  let tab = loadTab();
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
    if (view) addView(stats, view);
    else addWaiting(stats);
    fitBadge();
    badge.dataset["verdict"] = view?.status === "error" ? "error" : "ok";
    badge.setAttribute("aria-label", idleLabel(view, runtime));
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
    const entry = tab.find((item) => item.id === info.trace);
    if (entry?.summary) entry.summary = { ...entry.summary, issues: info.issues, kinds: row.issue_kinds };
    saveTab(tab);
    render();
    sendTab();
  }

  /** The runtime of the app that answered a call, from its trace: for a page its server didn't label. */
  async function resolveRuntime(info: TraceInfo): Promise<void> {
    if (runtimeAsked || !info.trace) return;
    runtimeAsked = true;
    await askConsole(`api/traces/${encodeURIComponent(info.trace)}`, (body) => {
      runtime = traceRuntime((body as { attrs?: Record<string, unknown> }).attrs ?? {});
      learnRuntime(runtime);
      showRuntime(runtimeMark, runtime);
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
    savePanel(panelState());
  }

  function close(): void {
    panel.toggleAttribute("data-open", false);
    badge.setAttribute("aria-expanded", "false");
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
  if (page) void resolveIssues(page);
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
