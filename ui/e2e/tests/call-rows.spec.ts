// A view's calls in the panel's list, from the moment they leave until their traces are stored: each row stays its
// own call (calls alike in name, the browser queueing some, never trade their times), the page's count says how many
// it made whoever answered them, the page's own document is no call of its view's, a group of calls no trace
// answered has nothing left to wait for, and a call's time is the time the page waited for it, which never goes down.
import type { Locator, Page, Route } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { panel, pill } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { issue } from "../gateway.ts";

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
      }).then((response) => response.text()).catch(() => {
        call.failed = true;
      }).then(() => {
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
 * `headers(n)`'s (an app with an SDK); a call numbered in `fails` gets no answer (a network error).
 */
async function gateway(
  page: Page,
  headers?: (n: number) => Record<string, string>,
  fails: readonly number[] = [],
): Promise<(n: number) => void> {
  const held = new Map<number, Route>();
  const released = new Set<number>();
  const answer = (route: Route, n: number) =>
    fails.includes(n)
      ? route.abort("failed")
      : route.fulfill({ status: 200, contentType: "application/json", body: "{}", headers: headers?.(n) ?? {} });
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
    fails?: readonly number[];
    dock?: "right" | "bottom";
    /** The panel closed: the pill and its hover card show. */
    closed?: boolean;
    /** The panel's width docked right. */
    width?: number;
  } = {},
) {
  const dock = options.dock ?? "right";
  await page.addInitScript(
    ([side, shut, wide]) =>
      sessionStorage.setItem("tracepanel:panel", JSON.stringify({ open: !shut, dock: side, width: wide })),
    [dock, options.closed ?? false, options.width ?? 760] as const,
  );
  const release = await gateway(page, options.headers, options.fails);
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

type Made = { n: number; op: string; start: number; end: number; failed?: boolean };

/**
 * What the recording sends once the view ended: the view, its calls as the page made them, in `order` (the spans of a
 * trace come in no order of the list's), each moved by `shift` (µs) and starting at `start` when given, to `origin`
 * (the console's, where the page made them, unless said).
 */
async function storeView(
  page: Page,
  tag: number,
  {
    order,
    shift = 0,
    start,
    origin = CONSOLE,
  }: { order?: (calls: Made[]) => Made[]; shift?: number; start?: number; origin?: string } = {},
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
      "url.full": `${origin}gw/graphql?n=${call.n}`,
      "server.address": new URL(origin).hostname,
      "server.port": Number(new URL(origin).port),
      "w3c.span_id": callOf(tag, call.n),
      "graphql.operation.type": "query",
      "graphql.operation.name": call.op,
      // No answer: the error the browser's fetch threw, the span failed, as the browser recording records it.
      ...(call.failed ? { "error.type": "TypeError" } : { "http.response.status_code": 200 }),
    };
    if (call.failed) each["status"] = "error";
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

/**
 * What served a call of view `tag`'s to an app with an SDK (a BFF, its trace's id came with its answer, bffOf), stored
 * as if hours ago (its finding stays out of the way of the Issues list's newest): the BFF's trace, running no query,
 * with a finding all of them share (the view's chain says it once), and the trace of the service it called, two.
 */
function served(tag: number, call: Made): Doc[] {
  const bff = bffOf(tag, call.n);
  const start = call.start + 2 * ms - 3 * 3_600_000_000;
  const time = Math.max(4 * ms, call.end - call.start - 4 * ms);
  const hop = `${digits(tag, 3)}d${digits(run(), 5)}${digits(call.n, 7)}`;
  const own = trace(
    bff,
    "http",
    "GraphQL query Book",
    start,
    time,
    {
      "service.name": "library-bff",
      "http.method": "POST",
      "http.route": "/graphql",
      "http.status_code": 200,
      "w3c.trace_id": traceOf(tag),
      "w3c.parent_span_id": callOf(tag, call.n),
    },
    [
      {
        ...span(`b${call.n}`, `${bff}r`, "http.client", "GET 127.0.0.1/shelves/1", start + ms, time - 2 * ms),
        attrs: { "http.request.method": "GET", "url.full": "http://127.0.0.1:4100/shelves/1", "w3c.span_id": hop },
      },
    ],
  );
  const found = { ...own, issues: [issue("n+1", "bff-n1", "N+1", `b${call.n}`)] };
  const queries = [0, 1].map((q) =>
    span(`q${q}`, `${id(tag, 40 + call.n)}r`, "sql", "SELECT books", start + 2 * ms, ms),
  );
  const api = trace(
    id(tag, 40 + call.n),
    "http",
    "GET /shelves/1",
    start + 2 * ms,
    time - 4 * ms,
    {
      "service.name": "library-api",
      "http.method": "GET",
      "http.route": "/shelves/1",
      "http.status_code": 200,
      "w3c.trace_id": traceOf(tag),
      "w3c.parent_span_id": hop,
    },
    queries,
  );
  return [found, api];
}

/** The id of the BFF's trace that answered view `tag`'s call `n`. */
const bffOf = (tag: number, n: number) => id(tag, 20 + n);

/** The BFF's answer to a call of view `tag`'s: its trace's id, its numbers still on their way. */
const bffHeaders = (tag: number) => (n: number) => ({
  "Tracepanel-Id": bffOf(tag, n),
  "Tracepanel-Name": "GraphQL%20query%20Book",
  "Server-Timing": 'db;dur=0;desc="0 queries", total;dur=30, tracepanel-issues;desc="pending"',
});

/** The loads of a view's chain held back from now on: the call returned lets them through, each answering as things are then. */
async function holdChain(page: Page, viewId: string): Promise<() => Promise<void>> {
  const held: Route[] = [];
  const url = `**/api/traces/${viewId}/chain`;
  await page.route(url, (route) => {
    held.push(route);
  });
  return async () => {
    await page.unroute(url);
    for (const route of held) await route.continue();
  };
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

test("a call's time is the time the page waited for it, while it runs, once answered and once stored", async ({
  page,
}) => {
  const tag = 4;
  const callTrace = id(tag, 20);
  // An app with an SDK answers, its own time 200 ms, the browser having queued it for more than a second.
  const { release, list } = await opened(page, {
    headers: () => ({
      "Tracepanel-Id": callTrace,
      "Tracepanel-Name": "GraphQL%20query%20Slow",
      "Server-Timing": 'db;dur=1;desc="2 queries", total;dur=200, tracepanel-issues;desc="pending"',
    }),
  });
  await open(page, id(tag, 1), ["Slow"], 1_500);
  // Its one call: a row of its own under the view.
  const row = list.locator('.dt-request-row[data-depth="1"]').filter({ hasText: "Slow" });
  const view = list.locator('.dt-request-row[data-kind="page"]');
  const times: { call: number; view: number }[] = [];
  const sample = async () => {
    const [call, viewTime] = await Promise.all([
      row.locator(".dt-request-meta").innerText(),
      view.locator(".dt-request-meta").innerText(),
    ]);
    times.push({ call: micros(call), view: micros(viewTime) });
  };
  await expect(row).toBeVisible();
  setTimeout(() => release(0), 1_300);
  for (let at = 0; at < 18; at += 1) {
    await sample();
    await page.waitForTimeout(100);
  }
  // Its trace stored, its own time 200 ms, and, ended after its answer went out, longer than the header said.
  const made = await page.evaluate(() => (window as unknown as { calls: Made[] }).calls[0] as Made);
  await ingest([
    trace(
      callTrace,
      "http",
      "GraphQL query Slow",
      made.end - 250 * ms,
      350 * ms,
      { "service.name": "gateway", "http.method": "POST", "http.route": "/graphql", "http.status_code": 200 },
      [],
    ),
  ]);
  for (let at = 0; at < 25; at += 1) {
    await sample();
    await page.waitForTimeout(100);
  }
  await viewEnded(page);
  await storeView(page, tag);
  await expect(row.locator(".dt-pending")).toHaveCount(0);
  await sample();

  for (const key of ["call", "view"] as const) {
    const shown = times.map((each) => each[key]).filter((each) => !Number.isNaN(each));
    expect(shown.length, key).toBeGreaterThan(20);
    for (const [n, each] of shown.entries())
      expect(each, `${key} sample ${n} of ${shown.join(", ")}`).toBeGreaterThanOrEqual(shown[n - 1] ?? 0);
  }
  // Answered and stored, the call says the time the page waited: well over its server's 200 ms; the pill too.
  expect(times.at(-1)?.call).toBeGreaterThan(1_200_000);
  await expect(pill(page)).toHaveAttribute("aria-label", /GraphQL query Slow → 200 · 1\.\d s/);
});

test("a view's time stops at its last call's answer, also once that call's longer trace is stored", async ({
  page,
}) => {
  const tag = 5;
  const callTrace = id(tag, 20);
  // An app with an SDK answers at once (its 503 after its own wait), its trace ending a second after the answer went
  // out: the view waits on for its end meanwhile.
  const { release, list } = await opened(page, {
    headers: () => ({
      "Tracepanel-Id": callTrace,
      "Tracepanel-Name": "GraphQL%20query%20Authors",
      "Server-Timing": 'db;dur=1;desc="0 queries", total;dur=300, tracepanel-issues;desc="pending"',
    }),
  });
  await open(page, id(tag, 1), ["Authors"], 2_500);
  const view = list.locator('.dt-request-row[data-kind="page"]');
  await expect(view).toBeVisible();
  await page.waitForTimeout(300);
  release(0);
  await page.waitForFunction(() => (window as unknown as { calls: Made[] }).calls[0]?.end);
  const made = await page.evaluate(() => (window as unknown as { calls: Made[] }).calls[0] as Made);
  await ingest([
    trace(
      callTrace,
      "http",
      "GraphQL query Authors",
      made.end - 300 * ms,
      1_300 * ms,
      { "service.name": "gateway", "http.method": "POST", "http.route": "/graphql", "http.status_code": 503 },
      [],
    ),
  ]);
  const times: number[] = [];
  for (let at = 0; at < 30; at += 1) {
    times.push(micros(await view.locator(".dt-request-meta").innerText()));
    await page.waitForTimeout(100);
  }
  await viewEnded(page);
  await storeView(page, tag);
  await expect(view.locator(".dt-pending")).toHaveCount(0);
  times.push(micros(await view.locator(".dt-request-meta").innerText()));

  const shown = times.filter((each) => !Number.isNaN(each));
  expect(shown.length).toBeGreaterThan(20);
  for (const [n, each] of shown.entries())
    expect(each, `sample ${n} of ${shown.join(", ")}`).toBeGreaterThanOrEqual(shown[n - 1] ?? 0);
  // Never past its answer, not up to the stored trace's end.
  expect(Math.max(...shown)).toBeLessThan(1_000_000);
});

test("a call that got no answer stays its row, failed as the call tree says it, in flight, answered and stored", async ({
  page,
}) => {
  const tag = 6;
  // Two calls to the gateway: the first answered (its trace comes over OTLP), the second gets no answer at all.
  const { release, list, calls } = await opened(page, { fails: [1] });
  await open(page, id(tag, 1), ["Books", "Authors"]);
  const failed = calls.filter({ hasText: "Authors" });
  await expect(calls).toHaveCount(2);
  await expect(failed.locator(".dt-running")).toHaveCount(1);

  release(0);
  release(1);
  await viewEnded(page);
  await expect(calls.locator(".dt-running")).toHaveCount(0);
  await expect(calls).toHaveCount(2);
  await expect(failed.locator(".dt-status")).toHaveText("failed");
  await expect(failed.locator(".dt-status")).toHaveAttribute("title", "No answer");
  await expect(failed).toHaveAttribute("data-tone", "error");

  // The view's trace stored, long enough ago that no trace is waited for any more, and the gateway's trace of the
  // first call: the host is known to answer with traces, and the failed call still stays, "failed", nothing pending.
  const shift = -8_000_000;
  const made = await page.evaluate(() => (window as unknown as { calls: Made[] }).calls[0] as Made);
  await ingest([
    trace(
      id(tag, 20),
      "http",
      "GraphQL query Books",
      made.start + shift + 5 * ms,
      made.end - made.start - 10 * ms,
      {
        "service.name": "gateway",
        "http.method": "POST",
        "http.route": "/graphql",
        "http.status_code": 200,
        "w3c.trace_id": traceOf(tag),
        "w3c.parent_span_id": callOf(tag, 0),
      },
      [],
    ),
  ]);
  // Calls to a host of their own: the app it is served by stays this test's (the Services map links them).
  await storeView(page, tag, { shift, origin: "http://gateway.test:4000/" });
  // Both its calls, under the gateway's row: the one its trace answered, the one that failed.
  await expect(list.locator('.dt-request-row[data-call="trace"]')).toHaveCount(1);
  await expect(list.locator('.dt-request-row[data-call="group"] .dt-map-times')).toHaveText("×2");
  await expect(calls).toHaveCount(2);
  await expect(failed).toHaveAttribute("data-call", "failed");
  await expect(failed.locator(".dt-status")).toHaveText("failed");
  await expect(failed.locator(".dt-status")).toHaveAttribute("title", "TypeError");
  await expect(failed).toHaveAttribute("data-tone", "error");
  await expect(failed.locator(".dt-pending")).toHaveCount(0);
  // Its view's call tree says the same of it.
  await failed.click();
  const row = panel(page).locator('.dt-map-row[data-kind="http.client"]').filter({ hasText: "Authors" });
  await expect(row.locator(".dt-status")).toHaveText("failed");
  await expect(row).toHaveAttribute("data-status", "error");
  const books = panel(page).locator('.dt-map-row[data-kind="http.client"]').filter({ hasText: "Books" });
  // And of the one its trace answered, stored before the view's: answered, by the gateway, as the list has it.
  await expect(books.locator(".dt-status")).toHaveText("200");
  await expect(books.locator(".dt-app-chip")).toHaveText("gateway");
  await expect(books.locator('[data-state="untraced"]')).toHaveCount(0);
});

test("the pill counts a page's calls no trace answered, as its list does: its own load and its view's calls", async ({
  page,
}) => {
  const tag = 7;
  const { release, list } = await opened(page, { document: { trace: id(tag, 50) } });
  const count = panel(page).locator(".switcher-count");
  await open(page, id(tag, 1), ["Spec", "Spec"]);
  release(0);
  release(1);
  await viewEnded(page);

  // The page's load and the two calls Swagger UI made to its own host, which sends no trace for them: this page's.
  await expect(list.locator('.dt-request-row[data-call="group"] .dt-map-times')).toHaveText("×2");
  await expect(list.locator('.dt-request-row[data-depth="1"]').filter({ hasText: "/rows/" })).toHaveCount(1);
  await expect(count).toHaveText("3");
  await expect(pill(page)).toHaveAccessibleName(/\. 3 requests on this page\b/);
  await expect(pill(page).locator(".seg.page b")).toHaveText("3");

  // Its view's trace stored: the calls are its chain's rows, the counts the same.
  await storeView(page, tag, { shift: -8_000_000 });
  await expect(list.locator('.dt-request-row[data-call="untraced"]')).toHaveCount(2);
  await expect(count).toHaveText("3");
  await expect(pill(page).locator(".seg.page b")).toHaveText("3");
});

test("a view's calls to the host that served the page are named by the page's app, not the host", async ({ page }) => {
  const tag = 8;
  // The page's own load, which its server (a Next app) traced: the host the view's calls go to.
  const now = Date.now() * ms;
  await ingest([
    trace(
      id(tag, 50),
      "http",
      "GET /rows/",
      now - 40 * ms,
      30 * ms,
      {
        "service.name": "next-app",
        "http.method": "GET",
        "http.route": "/rows/",
        "http.status_code": 200,
      },
      [],
    ),
  ]);
  const { release, list } = await opened(page, { document: { trace: id(tag, 50) }, dock: "bottom" });
  await open(page, id(tag, 1), ["Spec", "Spec"]);
  release(0);
  release(1);
  await viewEnded(page);

  const group = list.locator('.dt-request-row[data-call="group"]');
  await expect(group.locator(".dt-map-times")).toHaveText("×2");
  await expect(group.locator(".dt-app-chip")).toHaveText("next-app");
  // Its calls stay what they are: no trace answered them.
  await storeView(page, tag, { shift: -8_000_000 });
  await expect(list.locator('.dt-request-row[data-call="untraced"]')).toHaveCount(2);
  await expect(group.locator(".dt-app-chip")).toHaveText("next-app");
});

test("while a view's chain loads the first time, no placeholder stands between it and its calls' rows", async ({
  page,
}) => {
  const tag = 9;
  const callTrace = id(tag, 20);
  // An app with an SDK answers the view's call: a row of its own, under the view.
  const { release, list } = await opened(page, {
    headers: () => ({
      "Tracepanel-Id": callTrace,
      "Tracepanel-Name": "GraphQL%20query%20Books",
      "Server-Timing": 'db;dur=1;desc="0 queries", total;dur=30, tracepanel-issues;desc="0"',
    }),
  });
  // The agent slow to answer each row's chain the first time.
  let answer: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route("**/api/traces/*/chain", async (route) => {
    await answered;
    await route.continue();
  });
  await open(page, id(tag, 1), ["Books"]);
  release(0);
  await viewEnded(page);
  const made = await page.evaluate(() => (window as unknown as { calls: Made[] }).calls[0] as Made);
  await ingest([
    trace(
      callTrace,
      "http",
      "GraphQL query Books",
      made.start + 5 * ms,
      made.end - made.start - 10 * ms,
      {
        "service.name": "bff",
        "http.method": "POST",
        "http.route": "/graphql",
        "http.status_code": 200,
        "w3c.trace_id": traceOf(tag),
        "w3c.parent_span_id": callOf(tag, 0),
      },
      [],
    ),
  ]);
  // Calls to a host of their own: the app it is served by stays this test's (the Services map links them).
  await storeView(page, tag, { origin: "http://bff.test:4000/" });

  // The call's placeholder under the call, where what it called goes; none over it for its view.
  const rows = list.locator(".dt-request-row");
  const loading = list.locator('.dt-request-row[data-chain="loading"]');
  await expect(loading).toHaveCount(1);
  const shape = () =>
    rows.evaluateAll((all) =>
      all.map((row) => {
        const { chain, kind } = (row as HTMLElement).dataset;
        return chain === "loading" ? "loading" : kind === "page" ? "view" : "call";
      }),
    );
  await expect.poll(shape).toEqual(["view", "call", "loading"]);

  answer();

  await expect(loading).toHaveCount(0);
  await expect.poll(shape).toEqual(["view", "call"]);
});

test("the hover card lists the page's calls no trace answered, as the pill counts them: not traced, failed", async ({
  page,
}) => {
  const tag = 10;
  const { release } = await opened(page, { document: { trace: id(tag, 50) }, fails: [2], closed: true });
  await open(page, id(tag, 1), ["Spec", "Spec", "Spec"]);
  release(0);
  release(1);
  release(2);
  await viewEnded(page);
  await expect(pill(page).locator(".seg.page b")).toHaveText("4");

  // The page's load is the pill's; the card lists the other three, as the panel's list has them.
  await pill(page).hover();
  const card = page.getByRole("dialog", { name: "This request at a glance" });
  await expect(card.locator(".card-caption")).toHaveText("Other requests on this page · 3");
  const rows = card.locator(".card-row");
  await expect(rows).toHaveCount(3);
  // The one that got no answer first, "failed" in red where its status would be; the others "not traced".
  await expect(rows.nth(0)).toHaveAttribute("data-call", "failed");
  await expect(rows.nth(0).locator(".status")).toHaveText("failed");
  await expect(rows.nth(0).locator(".status")).toHaveAttribute("data-tone", "server");
  await expect(rows.nth(0).locator(".card-not-traced")).toHaveCount(0);
  for (const n of [1, 2]) {
    await expect(rows.nth(n)).toHaveAttribute("data-call", "untraced");
    await expect(rows.nth(n).locator(".status")).toHaveText("200");
    await expect(rows.nth(n).locator(".card-not-traced")).toHaveText("not traced");
    await expect(rows.nth(n).locator(".card-path")).toContainText("GraphQL query Spec");
  }

  // A click opens the call tree of the view that made them, once its trace is stored.
  await storeView(page, tag, { shift: -8_000_000 });
  await rows.nth(1).click();
  await expect(panel(page).locator('.dt-map-row[data-kind="http.client"]')).toContainText("×3");
});

test("the narrow dock's request picker says a call no trace answered and one that got none as the list does", async ({
  page,
}) => {
  const tag = 11;
  const { release } = await opened(page, { document: { trace: id(tag, 50) }, fails: [2], width: 360 });
  await open(page, id(tag, 1), ["Spec", "Spec", "Spec"]);
  for (const n of [0, 1, 2]) release(n);
  await viewEnded(page);
  await storeView(page, tag, { shift: -8_000_000 });
  // The list under the picker has them so: two "not traced", one "failed".
  const list = panel(page).getByRole("region", { name: "Requests made by this page" });
  await expect(list.locator('.dt-request-row[data-call="untraced"]')).toHaveCount(2);
  await expect(list.locator('.dt-request-row[data-call="failed"]')).toHaveCount(1);

  await panel(page).locator(".switcher-button").click();
  const picker = panel(page).locator(".switcher-popover");
  const calls = picker.locator(".dt-request-row").filter({ hasText: "Spec" });
  await expect(calls).toHaveCount(3);
  await expect(picker.locator('.dt-request-row[data-call="untraced"]')).toHaveCount(2);
  for (const row of await picker.locator('.dt-request-row[data-call="untraced"]').all()) {
    await expect(row.locator(".dt-not-traced")).toHaveText("not traced");
    await expect(row.locator(".dt-status")).toHaveText("200");
  }
  const failed = picker.locator('.dt-request-row[data-call="failed"]');
  await expect(failed.locator(".dt-status")).toHaveText("failed");
  // No numbers for calls that have no trace: no "0 queries".
  await expect(calls.filter({ hasText: "queries" })).toHaveCount(0);
});

test("the row over a view's calls to one app adds up their rows' numbers, its chain's findings said once", async ({
  page,
}) => {
  const tag = 12;
  // An app with an SDK (a BFF) answers each call, itself running no query; the service it calls runs two.
  const { release, list } = await opened(page, { headers: bffHeaders(tag) });
  await open(page, id(tag, 1), ["Book", "Book"]);
  release(0);
  release(1);
  await viewEnded(page);
  const made = await page.evaluate(() => (window as unknown as { calls: Made[] }).calls);
  await ingest(made.flatMap((call) => served(tag, call)));
  await storeView(page, tag, { origin: "http://bff.test:4000/" });

  // Each call's row counts what its trace and those under it ran: 2 queries, its finding.
  const calls = list.locator('.dt-request-row[data-depth="2"]').filter({ hasText: "Book" });
  await expect(calls).toHaveCount(2);
  await expect(calls.locator(".dt-request-queries-n")).toHaveText(["2", "2"]);
  // Their app's row: the sum of its rows, the finding they share once, as the view's chain says it.
  const group = list.locator('.dt-request-row[data-call="group"]');
  await expect(group.locator(".dt-map-times")).toHaveText("×2");
  await expect(group.locator(".dt-request-queries-n")).toHaveText("4");
  await expect(group.locator(".dt-request-chips")).toHaveText("1");
  await expect(calls.locator(".dt-request-chips")).toHaveText(["1", "1"]);
});

test("the selected view stays in sight below the list's head as its calls fill the list docked right", async ({
  page,
}) => {
  const tag = 13;
  const { release, list } = await opened(page);
  const ops = Array.from({ length: 8 }, () => "Book");
  await open(page, id(tag, 1), ops);
  const view = list.locator('.dt-request-row[data-kind="page"]');
  await expect(list.locator('.dt-request-row[data-depth="2"]')).toHaveCount(8);
  await expect(view).toHaveAttribute("aria-current", "true");
  // The list overflows: eight calls and their app's row under the view.
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const inSight = () =>
    view.evaluate((row) => {
      const section = row.closest("section") as HTMLElement;
      const head = section.querySelector(".page-requests-head") as HTMLElement;
      return Math.round(row.getBoundingClientRect().top - head.getBoundingClientRect().bottom);
    });
  await expect.poll(inSight).toBeGreaterThanOrEqual(0);
  for (const n of ops.keys()) release(n);
  await viewEnded(page);
  await expect(list.locator(".dt-running")).toHaveCount(0);
  await expect.poll(inSight).toBeGreaterThanOrEqual(0);
});

test("after a reload the rows that had their numbers keep them while their chains load again", async ({ page }) => {
  const tag = 14;
  const bff = id(tag, 20);
  const { release, list } = await opened(page, {
    headers: () => ({
      "Tracepanel-Id": bff,
      "Tracepanel-Name": "GraphQL%20query%20Books",
      "Server-Timing": 'db;dur=0;desc="0 queries", total;dur=30, tracepanel-issues;desc="pending"',
    }),
    dock: "bottom",
  });
  await open(page, id(tag, 1), ["Books"]);
  release(0);
  await viewEnded(page);
  const made = await page.evaluate(() => (window as unknown as { calls: Made[] }).calls[0] as Made);
  const start = made.start + 2 * ms;
  const time = Math.max(4 * ms, made.end - made.start - 4 * ms);
  // The BFF ran no query; the service it called ran two.
  const hop = `${digits(tag, 3)}d${digits(run(), 5)}${digits(0, 7)}`;
  const own = trace(
    bff,
    "http",
    "GraphQL query Books",
    start,
    time,
    {
      "service.name": "library-bff",
      "http.method": "POST",
      "http.route": "/graphql",
      "http.status_code": 200,
      "w3c.trace_id": traceOf(tag),
      "w3c.parent_span_id": callOf(tag, 0),
    },
    [
      {
        ...span("b0", `${bff}r`, "http.client", "GET 127.0.0.1/shelf", start + ms, time - 2 * ms),
        attrs: { "http.request.method": "GET", "url.full": "http://127.0.0.1:4100/shelf", "w3c.span_id": hop },
      },
    ],
  );
  const queries = [0, 1].map((q) => span(`q${q}`, `${id(tag, 40)}r`, "sql", "SELECT books", start + 2 * ms, ms));
  const api = trace(
    id(tag, 40),
    "http",
    "GET /shelf",
    start + 2 * ms,
    time - 4 * ms,
    {
      "service.name": "library-api",
      "http.method": "GET",
      "http.route": "/shelf",
      "http.status_code": 200,
      "w3c.trace_id": traceOf(tag),
      "w3c.parent_span_id": hop,
    },
    queries,
  );
  await ingest([own, api]);
  await storeView(page, tag, { origin: "http://bff.test:4000/" });
  const call = list.locator(".dt-request-row").filter({ hasText: "query Books" });
  await expect(call.locator(".dt-pending")).toHaveCount(0);
  await expect(call.locator(".dt-request-queries-n")).toHaveText("2");

  // The page loaded again on a slow network: the chains take their time to come again.
  await page.route("**/api/traces/*/chain", () => undefined);
  await page.reload();
  const again = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  const before = again.locator(".dt-request-row").filter({ hasText: "query Books" });
  await expect(before).toBeVisible();
  // Its numbers at once, as before the reload, not "…".
  await expect(before.locator(".dt-request-queries-n")).toHaveText("2");
  await expect(before.locator(".dt-pending")).toHaveCount(0);
  await expect(again.locator('.dt-request-row[data-kind="page"]').first().locator(".dt-pending")).toHaveCount(0);
});

test("the row over a view's calls to one app says no sum of theirs while the view's chain doesn't count them yet", async ({
  page,
}) => {
  const tag = 15;
  const viewId = id(tag, 1);
  const { release, list, calls } = await opened(page, { headers: bffHeaders(tag) });
  const ops = Array.from({ length: 4 }, () => "Book");
  await open(page, viewId, ops);
  for (const n of ops.keys()) release(n);
  await viewEnded(page);
  // The view's trace first: its chain loads, without its calls' traces.
  const first = page.waitForResponse((response) => response.url().endsWith(`/api/traces/${viewId}/chain`));
  await storeView(page, tag, { origin: "http://bff.test:4000/" });
  await first;
  // Its chain's next loads lag (a slow network) while the calls' traces come and their rows count them.
  const letThrough = await holdChain(page, viewId);
  const made = await page.evaluate(() => (window as unknown as { calls: Made[] }).calls);
  await ingest(made.flatMap((call) => served(tag, call)));
  await expect(calls.locator(".dt-request-queries-n")).toHaveText(["2", "2", "2", "2"]);
  await expect(calls.locator(".dt-request-chips")).toHaveText(["1", "1", "1", "1"]);

  // Their app's row: "…" until the view's chain counts them, never their own added up (no query, the finding 4 times).
  const group = list.locator('.dt-request-row[data-call="group"]');
  await expect(group.locator(".dt-pending")).toHaveCount(1);
  await expect(group.locator(".dt-request-queries-n")).toHaveCount(0);
  await expect(group.locator(".dt-request-chips")).toHaveText("");

  await letThrough();
  await expect(group.locator(".dt-request-queries-n")).toHaveText("8");
  await expect(group.locator(".dt-request-chips")).toHaveText("1");
});

test("a view's row says no numbers of its chain's while a call's are still on their way, only its time", async ({
  page,
}) => {
  const tag = 16;
  const viewId = id(tag, 1);
  const { release, list, calls } = await opened(page, { headers: bffHeaders(tag) });
  await open(page, viewId, ["Book", "Book"]);
  release(0);
  release(1);
  await viewEnded(page);
  const made = await page.evaluate(() => (window as unknown as { calls: Made[] }).calls);
  // One call's traces come with the view's, the other's later.
  await ingest(served(tag, made[0] as Made));
  const counted = page.waitForResponse(
    async (response) =>
      response.url().endsWith(`/api/traces/${viewId}/chain`) && (await response.text()).includes(bffOf(tag, 0)),
  );
  await storeView(page, tag, { origin: "http://bff.test:4000/" });
  await counted;
  await expect(calls.locator(".dt-request-queries-n")).toHaveText(["2"]);

  // The view's chain counts one call's: the view's row says "…" as their group's does, its time as it is.
  const view = list.locator('.dt-request-row[data-kind="page"]');
  const group = list.locator('.dt-request-row[data-call="group"]');
  await expect(group.locator(".dt-pending")).toHaveCount(1);
  await expect(view.locator(".dt-pending")).toHaveCount(1);
  await expect(view.locator(".dt-request-queries-n")).toHaveCount(0);

  await ingest(served(tag, made[1] as Made));
  await expect(view.locator(".dt-request-queries-n")).toHaveText("4");
  await expect(group.locator(".dt-request-queries-n")).toHaveText("4");
  await expect(view.locator(".dt-pending")).toHaveCount(0);
});
