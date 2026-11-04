import { graphqlName, namesOperation } from "@tracepanel/ui/lib/graphql";
import type { HtmxInfo } from "@tracepanel/ui/lib/tabEntry";
import type { TraceInfo } from "./index";

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

export function query<T extends Element>(root: ParentNode, selector: string): T {
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
  /** When its answer came (epoch ms): the browser's end of the call, before anything else reads the answer. */
  end?: number | undefined;
  /**
   * The W3C span id its traceparent carries, when the browser recording added one before this saw the call (it
   * wrapped fetch and XMLHttpRequest after the widget): the call's identity in the view's trace.
   */
  span?: string | undefined;
}

/**
 * What an answer Tracepanel didn't see said (no Server-Timing: a gateway's, a service's that records over OTLP): its
 * status (none when it failed to arrive), and the view or action that made the call, when the browser recording
 * marked it.
 */
export interface Answer {
  status?: number | undefined;
  page?: string | undefined;
}

/**
 * What follows the page's requests: each as it starts, and as it ends with what its answer said (null: untraced, with
 * what is known of it).
 */
interface Watcher {
  start(flight: Flight): void;
  end(flight: Flight, info: TraceInfo | null, answer?: Answer): void;
}

/**
 * fetch/XHR are wrapped as soon as widget.min.js runs, at the top of <head>: pages that keep a reference to fetch while
 * loading (GraphiQL, Swagger, SPA clients) still go through the wrapper. Requests seen before the badge exists wait
 * here and show up when it mounts; those still in flight then show as they are.
 */
export const pending: TraceInfo[] = [];

export const flying = new Set<Flight>();

// The widget's own calls to the console go around the wrapper: they are not the page's requests.
export const nativeFetch = window.fetch.bind(window);

let watcher: Watcher | null = null;

/** Who hears of the page's requests: the mounted widget. */
export function setWatcher(next: Watcher): void {
  watcher = next;
}

let listening = false;

let flights = 0;

// Flights are numbered per page load: a row the panel kept from an earlier page never shares its key with a new one.
const LOAD = Math.random().toString(36).slice(2, 8);

export function listen(): void {
  if (listening) return;
  listening = true;
  watchHtmx();
  intercept({
    start: (flight) => {
      flying.add(flight);
      watcher?.start(flight);
    },
    end: (flight, info, answer) => {
      flying.delete(flight);
      const landed = info && waited(flight, namedAsItFlew(flight, info));
      if (watcher) watcher.end(flight, landed, answer);
      else if (landed) pending.push(landed);
    },
  });
}

/**
 * A request that flew, as the page waited for it: its time from the call to its answer, as the browser timed it (a
 * call the browser queued behind others waited longer than its server took), never less than its server's own time.
 * The pill, its card and the panel's list say this one time while it runs, once it answers and once it is stored.
 */
function waited(flight: Flight, info: TraceInfo): TraceInfo {
  if (!flight.id) return info;
  const clock = { start: flight.start, end: flight.end ?? Date.now() };
  return { ...info, flight: flight.id, clock, span: flight.span, totalMs: waitedMs(clock, info.totalMs) };
}

/** The time the page waited for a request (ms): its clock's, or its server's when that says more. */
export function waitedMs(clock: TraceInfo["clock"], server: number | undefined): number | undefined {
  if (!clock) return server;
  return Math.max(clock.end - clock.start, server ?? 0);
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
function takeOff(method: string, url: string, body: unknown, traceparent?: string | null): Flight | null {
  const absolute = new URL(url, location.href).href;
  if (ownCall(absolute)) return null;
  flights += 1;
  return {
    id: `~${LOAD}-${flights}`,
    method: method.toUpperCase(),
    url: absolute,
    name: graphqlName(body),
    start: Date.now(),
    span: spanOf(traceparent),
  };
}

/** The span id a W3C traceparent names ("00-<trace>-<span>-01"); none for no header or another shape. */
function spanOf(traceparent: string | null | undefined): string | undefined {
  return /^[\da-f]{2}-[\da-f]{32}-([\da-f]{16})-[\da-f]{2}$/i.exec(traceparent?.trim() ?? "")?.[1]?.toLowerCase();
}

/** The traceparent a fetch carries: on its Request, or in its init's headers. */
function traceparentOf(input: globalThis.RequestInfo | URL, init: RequestInit | undefined): string | null {
  if (init?.headers) return new Headers(init.headers).get("traceparent");
  return input instanceof Request ? input.headers.get("traceparent") : null;
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
      const started = takeOff(method, url, init?.body, traceparentOf(input, init));
      if (started) watch.start(started);
      return started;
    }, null);
    const land = (info: TraceInfo | null, answer?: Answer) =>
      flight && safely(() => watch.end(flight, info, answer), undefined);
    let response: Response;
    try {
      response = await originalFetch.call(this, input, init);
    } catch (error) {
      if (flight) flight.end = Date.now();
      land(null, {});
      throw error;
    }
    if (flight) flight.end = Date.now();
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
      else afterMark(response, () => land(null, { status: response.status, page: pageOf(response) }));
    } catch {
      // Never break the page because of the widget.
      land(null);
    }
    return response;
  } as typeof window.fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  // The traceparent each one carries (the browser recording sets it before its send reaches this one).
  const traceparents = new WeakMap<XMLHttpRequest, string>();
  XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    safely(() => {
      if (name.toLowerCase() === "traceparent") traceparents.set(this, value);
    }, undefined);
    return originalSetHeader.call(this, name, value);
  };
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
      if (flight !== NO_FLIGHT) flight.end = Date.now();
      safely(
        () =>
          watch.end(flight, xhrInfo(this, method, String(url)), {
            status: this.status || undefined,
            page: pageOf(this),
          }),
        undefined,
      );
    });
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    safely(() => {
      const request = opened.get(this);
      const flight = request ? takeOff(request.method, request.url, body, traceparents.get(this)) : null;
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

export const PENDING_ISSUES = "pending";

function pageOf(carrier: object): string | undefined {
  const page = (carrier as Record<symbol, unknown>)[PAGE];
  return typeof page === "string" ? page : undefined;
}

// tracepanel-js's browser recording marks each Response and XMLHttpRequest with the view or action that made it.
const PAGE = Symbol.for("tracepanel.page");
