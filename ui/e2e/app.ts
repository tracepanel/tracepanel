// A page of an app with the widget, served on the console's origin (as an app's dev server serves the console): its
// own load, and the calls it makes to its API, answered with the headers an SDK puts on them and the ids of real
// traces in the agent, so the panel opens them.
import type { Page } from "@playwright/test";
import { CONSOLE } from "./agent.ts";

/** An answer of the page's API, as an SDK sends it: its status, its trace, what Server-Timing says. */
export interface Call {
  status: number;
  trace: string;
  queries: number;
  totalMs: number;
  /** "pending": the agent finds them after the response, as the SDKs say. */
  issues?: number | "pending";
}

/** The page's own request, as a server that traced it writes it on the widget's script tag. */
export interface ServerPage extends Call {
  runtime: string;
}

/** The id of a stored trace, by its name. */
export async function traceId(name: string): Promise<string> {
  const body = (await (await fetch(`${CONSOLE}api/traces?limit=100`)).json()) as {
    traces: { id: string; name: string }[];
  };
  const found = body.traces.find((trace) => trace.name === name);
  if (!found) throw new Error(`no stored trace named ${name}`);
  return found.id;
}

function timing(call: Call): string {
  return `db;dur=1;desc="${call.queries} queries", total;dur=${call.totalMs}, tracepanel-issues;desc="${call.issues ?? 0}"`;
}

// tracepanel-js's browser recording, by its contract with the widget: each view and action announced on window
// (tracepanel:page) as it starts and ends, the latest kept on globalThis, and each Response marked with its action.
const RECORDING = `
(() => {
  const PAGE = Symbol.for("tracepanel.page");
  const seen = new Map();
  globalThis[Symbol.for("tracepanel.pages")] = seen;
  let count = 0;
  const id = () => "01M4E2E" + String(++count).padStart(19, "0");
  const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000);
  const announce = (detail) => {
    seen.set(detail.id, detail);
    dispatchEvent(new CustomEvent("tracepanel:page", { detail }));
  };
  const view = { id: id(), name: location.pathname, start: Math.round(performance.timeOrigin * 1000), duration: 0, status: "ok", open: true };
  announce(view);
  addEventListener("load", () => announce({ ...view, duration: now() - view.start, open: false }));
  let current = null;
  const send = window.fetch;
  window.fetch = async (...args) => {
    const action = current;
    const response = await send(...args);
    if (action) Object.defineProperty(response, PAGE, { value: action.id });
    return response;
  };
  window.act = async (label, url) => {
    current = { id: id(), name: location.pathname + ' › click "' + label + '"', start: now(), duration: 0, status: "ok", open: true };
    announce(current);
    const response = await fetch(url);
    announce({ ...current, duration: now() - current.start, status: response.status >= 500 ? "error" : "ok", open: false });
    current = null;
  };
})();
`;

/** The page's API on another origin (a FastAPI app beside a Next one): its CORS lets the page read the SDK's headers. */
export const OTHER_API = "http://api.example.test/app/";

/**
 * Opens /app/ with a button per call: "Load <key>" fetches /app/api/<key> (on `api`: <api>api/<key>); with
 * `recording`, "Do <key>" does it as a click the browser recording sees. The recording starts before the widget,
 * or after it with "after widget" (an app that starts it from its own code, once the widget loaded). `server`: the
 * page's own load was traced (a server-rendered page). `charset`: the page's encoding, UTF-8 unless given.
 */
export async function openApp(
  page: Page,
  calls: Record<string, Call>,
  options: { server?: ServerPage; recording?: boolean | "after widget"; api?: string; charset?: string } = {},
): Promise<void> {
  const api = options.api ?? "/app/";
  const cors = options.api
    ? { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Tracepanel-Id, Server-Timing" }
    : {};
  await page.route(options.api ? `${options.api}api/*` : "**/app/api/*", (route) => {
    const call = calls[new URL(route.request().url()).pathname.split("/").pop() ?? ""];
    if (!call) return route.fulfill({ status: 404, headers: cors });
    return route.fulfill({
      status: call.status,
      contentType: "application/json",
      body: "{}",
      headers: { ...cors, "Tracepanel-Id": call.trace, "Server-Timing": timing(call) },
    });
  });
  const server = options.server;
  const tag = server
    ? `data-tracepanel-id="${server.trace}" data-tracepanel-method="GET" data-tracepanel-status="${server.status}"
       data-tracepanel-total="${server.totalMs}" data-tracepanel-queries="${server.queries}"
       data-tracepanel-issues="${server.issues ?? 0}" data-tracepanel-runtime="${server.runtime}"`
    : "";
  const buttons = Object.keys(calls)
    .map((key) => `<button onclick="fetch('${api}api/${key}')">Load ${key}</button>`)
    .concat(
      options.recording
        ? Object.keys(calls).map((key) => `<button onclick="act('${key}', '${api}api/${key}')">Do ${key}</button>`)
        : [],
    )
    .join("");
  const recording = `<script>${RECORDING}</script>`;
  const html = `<!doctype html><html><head>
    ${options.recording === true ? recording : ""}
    <script src="/widget.min.js" data-tracepanel-api="/" ${tag}></script>
    ${options.recording === "after widget" ? recording : ""}
    <title>app</title></head><body>${buttons}</body></html>`;
  // An app's page names its encoding; one that isn't UTF-8 reads a script with no charset of its own in its own.
  const contentType = `text/html; charset=${options.charset ?? "utf-8"}`;
  await page.route("**/app/", (route) => route.fulfill({ contentType, body: html }));
  await page.goto("/app/");
}

/** The widget's pill: its accessible name says what it shows. */
export const pill = (page: Page) => page.getByRole("button", { name: /^tracepanel:/ });

/** The panel the pill opens, in its frame. */
export const panel = (page: Page) => page.frameLocator("iframe");

/** The header's auto-refresh menu: its button says the choice ("Every 15s", "Live", "Live · paused"). */
export const autoRefresh = (page: Page) =>
  page
    .getByRole("main")
    .locator("header")
    .first()
    .getByRole("button", { name: /^(Every|Live|Auto-refresh)/ });

/** Live, chosen from the header's auto-refresh menu, as a person turns it on. */
export async function chooseLive(page: Page): Promise<void> {
  await autoRefresh(page).click();
  await page.getByRole("menuitemradio", { name: /^Live/ }).click();
}
