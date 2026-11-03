// A view's calls in the panel's list, from the moment they leave until their traces are stored: each row stays its
// own call (calls alike in name, the browser queueing some, never trade their times), the page's count says how many
// it made whoever answered them, the page's own document is no call of its view's, a group of calls no trace
// answered has nothing left to wait for, and a call's time is the time the page waited for it, which never goes down.
import type { Locator, Page, Route } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { panel } from "../app.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const ms = 1_000;

const run = () => test.info().repeatEachIndex * 2 + test.info().retry;
const digits = (value: number, width: number) => String(value).padStart(width, "0");
const id = (tag: number, n: number) => `01M4CA11R0WS${digits(tag, 3)}${digits(run(), 5)}${digits(n, 6)}`;
const traceOf = (tag: number) => `${digits(tag, 4)}${digits(run(), 5)}c0a1b2c3d4e5f6a7b8c9d0e`;
const callOf = (tag: number, n: number) => `${digits(tag, 3)}c${digits(run(), 5)}${digits(n, 7)}`;

// tracepanel-js's browser recording, by its contract with the widget (app.ts): a view announced as it opens and as
// it ends, each Response marked with it. `openView` makes its calls at once, each to /gw/graphql?n=<n> with its
// operation, and ends the view a while after the last answered, its time up to that answer, as the recording does.
const RECORDING = `<script>
(() => {
  const PAGE = Symbol.for("tracepanel.page");
  const seen = new Map();
  globalThis[Symbol.for("tracepanel.pages")] = seen;
  const now = () => Math.round((performance.timeOrigin + performance.now()) * 1000);
  const announce = (detail) => {
    seen.set(detail.id, detail);
    dispatchEvent(new CustomEvent("tracepanel:page", { detail }));
  };
  let current = null;
  const send = window.fetch;
  window.fetch = async (...args) => {
    const view = current;
    const response = await send(...args);
    if (view) Object.defineProperty(response, PAGE, { value: view.id });
    return response;
  };
  window.calls = [];
  window.openView = (id, ops, quietMs) => {
    const view = { id, name: "/rows", start: now(), duration: 0, status: "ok", open: true };
    current = view;
    window.view = view;
    announce(view);
    let left = ops.length;
    for (const [n, op] of ops.entries()) {
      const call = { n, op, start: now(), end: 0 };
      window.calls.push(call);
      fetch("/gw/graphql?n=" + n, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query " + op + " { items { id } }", operationName: op }),
      }).then((response) => response.text()).then(() => {
        call.end = now();
        left -= 1;
        if (left > 0) return;
        const end = Math.max(...window.calls.map((each) => each.end));
        setTimeout(() => {
          view.duration = end - view.start;
          view.open = false;
          announce({ ...view });
        }, quietMs);
      });
    }
  };
})();
</script>`;

/** The page: the recording, then the widget; `document`, the page's own load as its server traced it. */
function pageHtml(document?: { trace: string }): string {
  const tag = document
    ? `data-tracepanel-id="${document.trace}" data-tracepanel-method="GET" data-tracepanel-status="200"
       data-tracepanel-total="12" data-tracepanel-queries="1" data-tracepanel-issues="0" data-tracepanel-runtime="Node 26"`
    : "";
  return `<!doctype html><html><head>${RECORDING}<script src="/widget.min.js" data-tracepanel-api="/" ${tag}></script><title>app</title></head><body></body></html>`;
}

/** The page's way to open its view with its calls. */
type Opener = { openView: (viewId: string, ops: string[], quietMs: number) => void };

/**
 * The gateway's answers, each held until the test lets the call through (by its number): no Tracepanel headers, or
 * `headers(n)`'s (an app with an SDK).
 */
async function gateway(page: Page, headers?: (n: number) => Record<string, string>): Promise<(n: number) => void> {
  const held = new Map<number, Route>();
  const released = new Set<number>();
  const answer = (route: Route, n: number) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}", headers: headers?.(n) ?? {} });
  await page.route("**/gw/graphql?n=*", async (route) => {
    const n = Number(new URL(route.request().url()).searchParams.get("n"));
    if (released.has(n)) await answer(route, n);
    else held.set(n, route);
  });
  return (n) => {
    released.add(n);
    const route = held.get(n);
    if (route) void answer(route, n);
  };
}

/** The page with the panel open, docked right unless said (its header counts this page's requests), its view about to open. */
async function opened(
  page: Page,
  options: {
    document?: { trace: string };
    headers?: (n: number) => Record<string, string>;
    dock?: "right" | "bottom";
  } = {},
) {
  const dock = options.dock ?? "right";
  await page.addInitScript(
    (side) => sessionStorage.setItem("tracepanel:panel", JSON.stringify({ open: true, dock: side, width: 760 })),
    dock,
  );
  const release = await gateway(page, options.headers);
  await page.route("**/rows/", (route) =>
    route.fulfill({ contentType: "text/html", body: pageHtml(options.document) }),
  );
  await page.goto("/rows/");
  const list = panel(page).getByRole("region", {
    name: dock === "right" ? "Requests made by this page" : "Pages and requests in this browser tab",
  });
  return { release, list, calls: list.locator('.dt-request-row[data-depth="2"]') };
}

async function open(page: Page, viewId: string, ops: readonly string[], quietMs = 200): Promise<void> {
  await page.evaluate(([each, names, quiet]) => (window as unknown as Opener).openView(each, [...names], quiet), [
    viewId,
    ops,
    quietMs,
  ] as const);
}

async function viewEnded(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { view?: { open: boolean } }).view?.open === false);
}

function span(spanId: string, parent: string | null, kind: string, name: string, start: number, duration: number): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id: spanId, parent_id: parent, kind, name, start, duration, status: "ok", attrs: {} as Doc };
}

function trace(traceId: string, kind: string, name: string, start: number, duration: number, attrs: Doc, spans: Doc[]) {
  return {
    id: traceId,
    kind,
    name,
    start,
    duration,
    status: "ok",
    logs: [],
    errors: [],
    links: [],
    issues: [],
    attrs,
    spans: [span(`${traceId}r`, null, kind, name, start, duration), ...spans],
  };
}

async function ingest(traces: Doc[]): Promise<void> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(traces),
  });
  expect(response.status).toBe(202);
}

type Made = { n: number; op: string; start: number; end: number };

/**
 * What the recording sends once the view ended: the view, its calls as the page made them, in `order` (the spans of a
 * trace come in no order of the list's), each moved by `shift` (µs) and starting at `start` when given.
 */
async function storeView(
  page: Page,
  tag: number,
  { order, shift = 0, start }: { order?: (calls: Made[]) => Made[]; shift?: number; start?: number } = {},
): Promise<void> {
  const { view, calls } = await page.evaluate(() => {
    const w = window as unknown as { view: Doc; calls: Made[] };
    return { view: w.view, calls: w.calls };
  });
  const viewId = id(tag, 1);
  const spans = (order ? order(calls) : calls).map((call) => {
    const from = (start ?? call.start) + shift;
    const each = span(
      `v${tag}-${call.n}`,
      `${viewId}r`,
      "http.client",
      "POST 127.0.0.1/gw/graphql",
      from,
      call.end + shift - from,
    );
    each["attrs"] = {
      "http.request.method": "POST",
      "url.full": `${CONSOLE}gw/graphql?n=${call.n}`,
      "server.address": new URL(CONSOLE).hostname,
      "server.port": Number(new URL(CONSOLE).port),
      "w3c.span_id": callOf(tag, call.n),
      "graphql.operation.type": "query",
      "graphql.operation.name": call.op,
      "http.response.status_code": 200,
    };
    return each;
  });
  const attrs = {
    "service.name": "shop-web",
    "service.role": "browser",
    "telemetry.sdk.language": "webjs",
    "page.path": "/rows",
    "page.trigger": "navigation",
    "w3c.trace_id": traceOf(tag),
  };
  const viewStart = Number(view["start"]) + shift;
  await ingest([trace(viewId, "page", "/rows", viewStart, Number(view["duration"]), attrs, spans)]);
}

/** A time as the list writes it, in µs: "850 ms", "1.2 s". */
function micros(text: string): number {
  const match = /([\d.]+)\s*(µs|ms|s)\b/.exec(text);
  if (!match) return Number.NaN;
  const value = Number(match[1]);
  return match[2] === "s" ? value * 1_000_000 : match[2] === "ms" ? value * 1_000 : value;
}

/** Each call's row: its time, and whether it is the element it was (`data-probe`). */
function rowsOf(calls: Locator) {
  return calls.evaluateAll((rows) =>
    rows.map((row) => ({
      time: row.querySelector(".dt-request-meta")?.textContent?.match(/[\d.]+\s*(?:µs|ms|s)\b/)?.[0] ?? "",
      probe: (row as HTMLElement).dataset["probe"] ?? "new",
    })),
  );
}

test("a group of calls no trace answered says so with nothing on its way, and the page's document stays out of it", async ({
  page,
}) => {
  const tag = 3;
  // The page's own load, which its server traced: the same host as the view's calls.
  // Docked at the bottom: the tab's list, the view and the load under it.
  const { release, list } = await opened(page, { document: { trace: id(tag, 50) }, dock: "bottom" });
  await open(page, id(tag, 1), ["Spec", "Spec"]);
  release(0);
  release(1);
  await viewEnded(page);
  const group = list.locator('.dt-request-row[data-call="group"]');
  // Only the view's two calls: the document is the load, a row of its own under the view.
  await expect(group.locator(".dt-map-times")).toHaveText("×2");
  const load = list.locator('.dt-request-row[data-depth="1"]').filter({ hasText: "/rows/" });
  await expect(load).toHaveCount(1);

  // Stored long enough ago that no trace will come for them: not traced, and nothing left to count.
  await storeView(page, tag, { shift: -8_000_000 });
  const untraced = list.locator('.dt-request-row[data-call="untraced"]');
  await expect(untraced).toHaveCount(2);
  await expect(untraced.first().locator('[data-state="untraced"]')).toHaveText("not traced");
  await expect(group.locator(".dt-pending")).toHaveCount(0);
  await expect(list.locator('.dt-request-row[data-kind="page"] .dt-pending')).toHaveCount(0);
});

test("the page's count says every call its view made, through a gateway too, in flight, answered and stored", async ({
  page,
}) => {
  const tag = 2;
  const { release, list } = await opened(page);
  const head = list.locator(".page-requests-count");
  const chip = panel(page).locator(".switcher-count");
  await open(page, id(tag, 1), ["Features", "TenantRoles", "Campaigns"]);

  await expect(head).toHaveText("· 3 requests");
  await expect(chip).toHaveText("3");

  for (const n of [0, 1, 2]) release(n);
  await viewEnded(page);
  await expect(list.locator('.dt-request-row[data-depth="2"] .dt-running')).toHaveCount(0);
  await expect(head).toHaveText("· 3 requests");
  await expect(chip).toHaveText("3");

  // Its trace stored: its calls are the chain's rows now, the count the same.
  await storeView(page, tag);
  await expect(list.locator('.dt-request-row[data-call="waiting"]')).toHaveCount(3);
  await expect(head).toHaveText("· 3 requests");
  await expect(chip).toHaveText("3");
});

test("calls alike in name and start keep their own times and rows from in flight to their view's trace", async ({
  page,
}) => {
  const tag = 1;
  const { release, calls } = await opened(page);
  // Four of one operation at once: the browser answers two at once, the other two a while later (it queued them).
  await open(page, id(tag, 1), ["Book", "Book", "Book", "Book"]);
  await expect(calls).toHaveCount(4);
  await calls.evaluateAll((rows) => {
    for (const [n, row] of rows.entries()) (row as HTMLElement).dataset["probe"] = String(n);
  });
  release(0);
  release(2);
  await page.waitForTimeout(1_200);
  release(1);
  release(3);
  await viewEnded(page);
  await expect(calls.locator(".dt-running")).toHaveCount(0);
  const answered = await rowsOf(calls);
  expect(answered.map((row) => row.probe)).toEqual(["0", "1", "2", "3"]);
  const [quick, late] = [micros(answered[0]?.time ?? ""), micros(answered[1]?.time ?? "")];
  expect(late - quick).toBeGreaterThan(900_000);

  // The view's trace stored, its spans listing the late calls first and all of them from one start: each row still
  // its own call, its own time.
  await storeView(page, tag, {
    order: (made) => [...made].sort((a, b) => b.end - a.end),
    start: (await page.evaluate(() => (window as unknown as { view: { start: number } }).view.start)) + 5 * ms,
  });
  await expect(panel(page).locator('.dt-request-row[data-call="waiting"]')).toHaveCount(4);
  const stored = await rowsOf(calls);
  expect(stored.map((row) => row.probe)).toEqual(["0", "1", "2", "3"]);
  for (const [n, row] of stored.entries()) {
    expect(Math.abs(micros(row.time) - micros(answered[n]?.time ?? "")), `row ${n}: ${row.time}`).toBeLessThan(150_000);
  }
});
