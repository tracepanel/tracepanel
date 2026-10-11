// Corner badge, fetch and XHR capture, slide-out panel (iframe inside Shadow DOM).
import { RUNTIME_PATHS, runtimeKind, runtimeName } from "@tracepanel/ui/lib/runtime";

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
  .badge[data-verdict="error"] { border-color: rgb(255 107 94 / 0.5); box-shadow: 0 0 0 4px rgb(255 107 94 / 0.17), 0 12px 32px rgb(10 12 17 / 0.32); }
  /* Hover answers in place: the border, in the verdict's colour, gets stronger; the pill stays where it is. */
  .badge:hover { border-color: rgb(255 255 255 / 0.24); }
  .badge[data-verdict="warn"]:hover { border-color: rgb(245 181 68 / 0.85); }
  .badge[data-verdict="error"]:hover { border-color: rgb(255 107 94 / 0.9); }
  .badge:focus-visible { outline: 2px solid #b6e24a; outline-offset: 3px; }
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
  .more { padding: 3px 8px; border-radius: 999px; background: rgb(255 255 255 / 0.09); color: #e7e9ef; font-size: 12px; }
  .flash-name {
    max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 500 12px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; color: #fff;
  }
  .badge[data-flash] { animation: flash 900ms ease-out; border-color: rgb(165 135 255 / 0.7); }
  .badge[data-flash="warn"] { border-color: rgb(245 181 68 / 0.7); }
  .badge[data-flash="error"] { border-color: rgb(255 107 94 / 0.7); }
  @keyframes flash {
    from { box-shadow: 0 0 0 0 rgb(165 135 255 / 0.5), 0 12px 32px rgb(10 12 17 / 0.32); }
    to { box-shadow: 0 0 0 12px rgb(165 135 255 / 0), 0 12px 32px rgb(10 12 17 / 0.32); }
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
  @media (max-width: 720px) { .panel[data-open] ~ .badge { display: none; } }
  .panel iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; color-scheme: dark; }
  /* Light theme (the console's Auto / Light / Dark choice, shared through localStorage). */
  :host([data-theme="light"]) .badge {
    border-color: #e2e2dc; background: #ffffff; color: #16181d;
    box-shadow: 0 10px 28px rgb(22 24 29 / 0.12), 0 1px 3px rgb(22 24 29 / 0.08);
  }
  :host([data-theme="light"]) .badge:hover { border-color: #b9b9b1; }
  :host([data-theme="light"]) .badge[data-verdict="warn"] { border-color: rgb(217 119 6 / 0.45); box-shadow: 0 0 0 4px rgb(217 119 6 / 0.13), 0 10px 28px rgb(22 24 29 / 0.12); }
  :host([data-theme="light"]) .badge[data-verdict="error"] { border-color: rgb(208 52 44 / 0.45); box-shadow: 0 0 0 4px rgb(208 52 44 / 0.12), 0 10px 28px rgb(22 24 29 / 0.12); }
  :host([data-theme="light"]) .badge[data-verdict="warn"]:hover { border-color: rgb(217 119 6 / 0.85); }
  :host([data-theme="light"]) .badge[data-verdict="error"]:hover { border-color: rgb(208 52 44 / 0.85); }
  :host([data-theme="light"]) .seg + .seg { border-left-color: #e2e2dc; }
  :host([data-theme="light"]) .seg svg, :host([data-theme="light"]) .unit { color: #5f6470; }
  :host([data-theme="light"]) .runtime { background: #f0f0ed; color: #3a3e47; }
  :host([data-theme="light"]) .seg b, :host([data-theme="light"]) .flash-name { color: #16181d; }
  :host([data-theme="light"]) .seg[data-speed="slow"] b { color: #b45309; }
  :host([data-theme="light"]) .seg[data-speed="very-slow"] b { color: #d0342c; }
  :host([data-theme="light"]) .status { background: rgb(98 160 20 / 0.12); color: #3d7a0c; }
  :host([data-theme="light"]) .status[data-tone="redirect"] { background: rgb(52 86 214 / 0.09); color: #3456d6; }
  :host([data-theme="light"]) .status[data-tone="client"] { background: rgb(217 119 6 / 0.1); color: #b45309; }
  :host([data-theme="light"]) .status[data-tone="server"] { background: rgb(208 52 44 / 0.09); color: #d0342c; }
  :host([data-theme="light"]) .issues { background: rgb(217 119 6 / 0.1); color: #b45309; }
  :host([data-theme="light"]) .issues[data-tone="error"] { background: rgb(208 52 44 / 0.09); color: #d0342c; }
  :host([data-theme="light"]) .more { background: #f0f0ed; color: #16181d; }
  :host([data-theme="light"]) .panel {
    border-left-color: #e2e2dc; background: #ffffff;
    box-shadow: -16px 0 40px rgb(22 24 29 / 0.12);
  }
  :host([data-theme="light"]) .panel iframe { color-scheme: light; }
  .panel[data-instant], .panel[data-instant] ~ .badge, .panel[data-resizing], .panel[data-resizing] ~ .badge { transition: none; }
  .panel[data-resizing] iframe { pointer-events: none; }
  .resize { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: ew-resize; z-index: 1; }
  .resize::after { content: ""; position: absolute; top: 50%; left: 2px; width: 4px; height: 40px; margin-top: -20px; border-radius: 2px; background: rgb(167 139 250 / 0.0); transition: background 120ms; }
  .resize:hover::after, .panel[data-resizing] .resize::after { background: rgb(165 135 255 / 0.7); }
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
  :host([data-dock="bottom"]) .resize::after { top: 2px; left: 50%; width: 40px; height: 4px; margin-top: 0; margin-left: -20px; }
  /* While dragging, the size follows the pointer: no transition (these selectors outrank the dock rules). */
  :host .panel[data-resizing], :host .panel[data-resizing][data-open], :host .panel[data-resizing] ~ .badge,
  :host([data-dock="bottom"]) .panel[data-resizing][data-open] { transition: none; }
  :host([data-theme="light"][data-dock="bottom"]) .panel { border-top-color: #e2e2dc; box-shadow: 0 -16px 40px rgb(22 24 29 / 0.12); }
  @media (prefers-reduced-motion: reduce) { .panel, .badge { transition: none; } .badge[data-flash] { animation: none; } }
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
      if (info) onRequest(info);
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
        if (info) onRequest({ ...info, htmx: htmxRequests.get(this) });
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

function addPill(parent: HTMLElement, text: string, className: string): void {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  segment(parent).append(span);
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
  htmx?: HtmxInfo | undefined;
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
const FLASH_MS = 5000;

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
    <style>${STYLE}</style>
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
  showRuntime(query<HTMLElement>(root, ".runtime"), options.runtime);
  const panel = query<HTMLElement>(root, ".panel");
  const panelUrl = options.api ? new URL(options.api, location.href) : null;
  const handle = query<HTMLElement>(root, ".resize");
  let width = DEFAULT_WIDTH;
  let height = DEFAULT_HEIGHT;
  let dock: Dock = "right";

  function setWidth(value: number): void {
    width = Math.round(Math.min(Math.max(value, MIN_WIDTH), window.innerWidth - 40));
    host.style.setProperty("--tracepanel-width", `${width}px`);
  }

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
  // The latest fetch/XHR, shown on the badge for a few seconds so it is caught as it happens.
  let flash: TraceInfo | null = null;
  let flashTimer: number | undefined;

  function sendTab(): void {
    if (frame?.contentWindow && panelUrl) {
      frame.contentWindow.postMessage(
        {
          type: "tracepanel:tab",
          entries: tab,
          current: pageCleared ? null : (page?.trace ?? null),
          runtime: options.runtime ?? null,
        },
        panelUrl.origin,
      );
    }
  }

  function render(): void {
    if (flash) {
      renderFlash(flash);
      return;
    }
    badge.removeAttribute("data-flash");
    const shown = pageCleared ? null : page;
    const headline = shown ?? later[0] ?? {};
    const others = shown ? later : later.slice(1);
    const worst = [headline, ...others].map(state).reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "ok");

    stats.textContent = "";
    addStatus(stats, headline.status);
    addTime(stats, headline.totalMs ?? 0);
    addQueries(stats, headline.queries ?? 0);
    const issues = [headline, ...others].reduce((sum, info) => sum + (info.issues ?? 0), 0);
    if (issues > 0) addIssues(stats, issues, worst === "error" ? "error" : "warn");
    if (others.length > 0) addPill(stats, `+${others.length}`, "more");
    badge.dataset["verdict"] = worst;

    const recent = others.slice(-3).map(line);
    const summary = [
      line(headline),
      ...(recent.length ? ["", `Later requests (${others.length}):`, ...recent] : []),
      ...(options.runtime ? ["", `Served by ${options.runtime}`] : []),
    ];
    badge.title = summary.join("\n");
    badge.setAttribute("aria-label", `tracepanel: ${summary.join(". ")}`);
  }

  function renderFlash(info: TraceInfo): void {
    const summary = summaryOf(info);
    stats.textContent = "";
    addPill(stats, summary.name, "flash-name");
    addStatus(stats, info.status);
    addTime(stats, info.totalMs ?? 0);
    addQueries(stats, summary.queries);
    if (summary.issues) addIssues(stats, summary.issues, state(info) === "error" ? "error" : "warn");
    badge.dataset["flash"] = state(info);
    badge.dataset["verdict"] = state(info);
    badge.title = `${line(info)}\nClick to open this request.`;
    badge.setAttribute("aria-label", `tracepanel: ${line(info)}. Click to open this request.`);
  }

  /** A page htmx loaded (a boosted link or form): it heads the list, and what follows is its requests. */
  function navigate(info: TraceInfo): void {
    page = info;
    pageCleared = false;
    later.length = 0;
    flash = null;
    window.clearTimeout(flashTimer);
    if (info.trace) {
      tab = [...tab, { id: info.trace, parent: null, summary: summaryOf(info) }];
      saveTab(tab);
    }
    render();
    sendTab();
  }

  /** Issues found after the response (by the agent): asked from the console once the request is stored. */
  async function resolveIssues(info: TraceInfo): Promise<void> {
    if (!info.issuesPending || !info.trace || !panelUrl) return;
    const url = new URL(`api/traces?ids=${encodeURIComponent(info.trace)}`, panelUrl);
    for (let attempt = 1; attempt <= ISSUE_TRIES; attempt++) {
      try {
        const response = await nativeFetch(url, { credentials: "same-origin" });
        if (response.ok) {
          const body = (await response.json()) as { traces?: { id: string; issues?: number }[] };
          const row = body.traces?.find((trace) => trace.id === info.trace);
          if (row) {
            info.issues = row.issues ?? 0;
            info.issuesPending = false;
            const entry = tab.find((item) => item.id === info.trace);
            if (entry?.summary) entry.summary = { ...entry.summary, issues: info.issues };
            saveTab(tab);
            render();
            sendTab();
            return;
          }
        }
      } catch {
        // The console is not reachable from this page: the badge goes without the count.
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, ISSUE_RETRY_MS * attempt));
    }
  }

  function record(info: TraceInfo): void {
    void resolveIssues(info);
    if (info.htmx?.boosted) {
      navigate(info);
      return;
    }
    later.push(info);
    if (info.trace) {
      tab = [...tab, { id: info.trace, parent: page?.trace ?? null, summary: summaryOf(info) }];
      saveTab(tab);
    }
    flash = info;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flash = null;
      render();
    }, FLASH_MS);
    render();
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
    flash = null;
    window.clearTimeout(flashTimer);
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

  badge.addEventListener("click", () => {
    if (flash?.trace) open(`#/t/${flash.trace}`);
    else if (panel.hasAttribute("data-open")) close();
    else open();
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
