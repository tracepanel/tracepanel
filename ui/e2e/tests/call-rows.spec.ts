// A view's calls under its open record in the panel, from the moment they leave until their traces are stored: each
// row stays its own call (calls alike in name, the browser queueing some, never trade their times), the page's count
// says how many it made whoever answered them, the page's own document is no call of its view's, calls no trace
// answered have nothing left to wait for, and a call's time is the time the page waited for it, which never goes down.
import type { Locator, Page, Route } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { panel, panelList, pill } from "../app.ts";
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
  const list = panelList(page);
  // The open view's first row, then its calls': records while it waits for its trace, its call tree's rows after.
  return {
    release,
    list,
    view: viewRow(list),
    calls: list.locator(".tp-map-row").filter({ hasText: "GraphQL query" }),
  };
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

/** A time as the list writes it, in µs: "850 ms", "1.2 s". */
function micros(text: string): number {
  const match = /([\d.]+)\s*(µs|ms|s)\b/.exec(text);
  if (!match) return Number.NaN;
  const value = Number(match[1]);
  return match[2] === "s" ? value * 1_000_000 : match[2] === "ms" ? value * 1_000 : value;
}

/** The open view's own row, its record's first. */
function viewRow(list: Locator) {
  return list.locator('.tp-map-row[data-kind="page"]').first();
}

/** Each call's time, as its row says it. */
function timesOf(calls: Locator) {
  return calls.evaluateAll((rows) => rows.map((row) => row.querySelector(".tp-map-time")?.textContent ?? ""));
}

/** A row's time, in µs. */
async function timeOf(row: Locator): Promise<number> {
  return micros(await row.locator(".tp-map-time").innerText());
}

test("calls no trace answered say so with nothing on their way, and the page's document is none of them", async ({
  page,
}) => {
  const tag = 3;
  // The page's own load, which its server traced: the same host as the view's calls.
  const { release, list, calls } = await opened(page, { document: { trace: id(tag, 50) }, dock: "bottom" });
  await open(page, id(tag, 1), ["Spec", "Spec"]);
  release(0);
  release(1);
  await viewEnded(page);
  // Only the view's two calls: the document is the load, a row of its own under the view.
  await expect(calls).toHaveCount(2);
  await expect(list.locator(".tp-map-row").filter({ hasText: "/rows/" })).toHaveCount(1);

  // Stored long enough ago that no trace will come for them: not traced (said in the tooltip), nothing to wait for.
  await storeView(page, tag, { shift: -14_000_000 });
  const untraced = calls.locator("[data-untraced]");
  await expect(untraced).toHaveCount(2);
  await expect(untraced.first()).toHaveAttribute("title", /^Not traced: /);
  await expect(calls.first()).not.toContainText("not traced");
  await expect(list.locator(".tp-pending")).toHaveCount(0);
});

test("every call its view made is a row of it, through a gateway too, in flight, answered and stored", async ({
  page,
}) => {
  const tag = 2;
  const { release, calls } = await opened(page);
  await open(page, id(tag, 1), ["Features", "TenantRoles", "Campaigns"]);

  await expect(calls).toHaveCount(3);

  for (const n of [0, 1, 2]) release(n);
  await viewEnded(page);
  await expect(calls.and(panel(page).locator("[data-live]"))).toHaveCount(0);
  await expect(calls).toHaveCount(3);

  // Its trace stored: its calls are its call tree's rows now, as many.
  await storeView(page, tag);
  await expect(calls.and(panel(page).locator('[data-kind="http.client"]'))).toHaveCount(3);
});

test("calls alike in name and start keep their own times from in flight to their view's trace", async ({ page }) => {
  const tag = 1;
  const { release, calls } = await opened(page);
  // Four of one operation at once: the browser answers two at once, the other two a while later (it queued them).
  await open(page, id(tag, 1), ["Book", "Book", "Book", "Book"]);
  await expect(calls).toHaveCount(4);
  release(0);
  release(2);
  await page.waitForTimeout(1_200);
  release(1);
  release(3);
  await viewEnded(page);
  await expect(calls.and(panel(page).locator("[data-live]"))).toHaveCount(0);
  const answered = (await timesOf(calls)).map(micros);
  expect(Math.max(...answered) - Math.min(...answered)).toBeGreaterThan(900_000);

  // The view's trace stored, its spans listing the late calls first and all of them from one start: each call
  // still its own time, none of them traded.
  await storeView(page, tag, {
    order: (made) => [...made].sort((a, b) => b.end - a.end),
    start: (await page.evaluate(() => (window as unknown as { view: { start: number } }).view.start)) + 5 * ms,
  });
  // One group in the call tree, alike as they are: opened, each its own row.
  const group = calls.filter({ hasText: "×4" });
  await group.locator("[data-toggle]").click();
  const each = calls.filter({ hasNotText: "×4" });
  await expect(each).toHaveCount(4);
  const stored = (await timesOf(each)).map(micros);
  const sorted = (each: number[]) => [...each].sort((a, b) => a - b);
  for (const [n, time] of sorted(stored).entries())
    expect(Math.abs(time - (sorted(answered)[n] ?? 0)), `call ${n}: ${stored.join(", ")}`).toBeLessThan(150_000);
});

test("a call's time is the time the page waited for it, while it runs, once answered and once stored", async ({
  page,
}) => {
  const tag = 4;
  const callTrace = id(tag, 20);
  // An app with an SDK answers, its own time 200 ms, the browser having queued it for more than a second.
  const { release, list, view } = await opened(page, {
    headers: () => ({
      "Tracepanel-Id": callTrace,
      "Tracepanel-Name": "GraphQL%20query%20Slow",
      "Server-Timing": 'db;dur=1;desc="2 queries", total;dur=200, tracepanel-issues;desc="pending"',
    }),
  });
  await open(page, id(tag, 1), ["Slow"], 1_500);
  // Its one call: a row of its own under the view.
  const row = list.locator(".tp-map-row").filter({ hasText: "Slow" });
  const times: { call: number; view: number }[] = [];
  const sample = async () => {
    const [call, viewTime] = await Promise.all([timeOf(row), timeOf(view)]);
    times.push({ call, view: viewTime });
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
  await expect(row.and(panel(page).locator('[data-kind="http.client"]'))).toHaveCount(1);
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
  const { release, view } = await opened(page, {
    headers: () => ({
      "Tracepanel-Id": callTrace,
      "Tracepanel-Name": "GraphQL%20query%20Authors",
      "Server-Timing": 'db;dur=1;desc="0 queries", total;dur=300, tracepanel-issues;desc="pending"',
    }),
  });
  await open(page, id(tag, 1), ["Authors"], 2_500);
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
    times.push(await timeOf(view));
    await page.waitForTimeout(100);
  }
  await viewEnded(page);
  await storeView(page, tag);
  // Its call tree's root now: the time as the page waited, not up to the call's longer trace.
  await expect(view).not.toHaveClass(/tp-record/);
  times.push(await timeOf(view));

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
  const { release, calls } = await opened(page, { fails: [1] });
  await open(page, id(tag, 1), ["Books", "Authors"]);
  const failed = calls.filter({ hasText: "Authors" });
  await expect(calls).toHaveCount(2);
  await expect(failed).toHaveAttribute("data-live", "");

  release(0);
  release(1);
  await viewEnded(page);
  await expect(calls.and(panel(page).locator("[data-live]"))).toHaveCount(0);
  await expect(calls).toHaveCount(2);
  await expect(failed.locator(".tp-status")).toHaveText("failed");
  await expect(failed.locator(".tp-status")).toHaveAttribute("title", "No answer");
  await expect(failed.locator(".tp-status")).toHaveAttribute("data-tone", "error");

  // The view's trace stored, long enough ago that no trace is waited for any more, and the gateway's trace of the
  // first call: the host is known to answer with traces, and the failed call still stays, "failed", nothing pending.
  const shift = -14_000_000;
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
  // Its call tree's rows: the one its trace answered, the one that failed, as the browser recorded it.
  await expect(failed).toHaveAttribute("data-kind", "http.client");
  await expect(failed.locator(".tp-status")).toHaveText("failed");
  await expect(failed.locator(".tp-status")).toHaveAttribute("title", "TypeError");
  await expect(failed).toHaveAttribute("data-status", "error");
  const books = calls.filter({ hasText: "Books" });
  // And of the one its trace answered, stored before the view's: answered, by the gateway.
  await expect(books.locator(".tp-status")).toHaveText("200");
  await expect(books.locator(".tp-app-chip")).toHaveText("gateway");
  await expect(books.locator("[data-untraced]")).toHaveCount(0);
});

test("the pill counts a page's calls no trace answered, as its panel does: its own load and its view's calls", async ({
  page,
}) => {
  const tag = 7;
  const { release, list, calls } = await opened(page, { document: { trace: id(tag, 50) } });
  const count = pill(page).locator(".seg.page b");
  await open(page, id(tag, 1), ["Spec", "Spec"]);
  release(0);
  release(1);
  await viewEnded(page);

  // The page's load and the two calls Swagger UI made to its own host, which sends no trace for them: this page's.
  await expect(calls).toHaveCount(2);
  await expect(list.locator(".tp-map-row").filter({ hasText: "/rows/" })).toHaveCount(1);
  await expect(count).toHaveText("3");
  await expect(pill(page)).toHaveAccessibleName(/\. 3 requests on this page\b/);

  // Its view's trace stored: the calls are its call tree's rows, the count the same.
  await storeView(page, tag, { shift: -14_000_000 });
  await expect(calls.locator("[data-untraced]")).toHaveCount(2);
  await expect(count).toHaveText("3");
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

  // The view's call tree at once, its call under it: no placeholder row between them while its chain loads.
  const rows = list.locator(".tp-map-row");
  const shape = () =>
    rows.evaluateAll((all) => all.map((row) => ((row as HTMLElement).dataset["kind"] === "page" ? "view" : "call")));
  await expect(rows.first()).not.toHaveClass(/tp-record/);
  await expect.poll(shape).toEqual(["view", "call"]);

  answer();

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
  // The one that got no answer first, "failed" in red where its status would be; the others their status, not traced
  // said in the tooltip.
  await expect(rows.nth(0)).toHaveAttribute("data-call", "failed");
  await expect(rows.nth(0).locator(".status")).toHaveText("failed");
  await expect(rows.nth(0).locator(".status")).toHaveAttribute("data-tone", "server");
  for (const n of [1, 2]) {
    await expect(rows.nth(n)).toHaveAttribute("data-call", "untraced");
    await expect(rows.nth(n).locator(".status")).toHaveText("200");
    await expect(rows.nth(n)).toHaveAttribute("title", /: not traced, its server sent no trace for this call\n/);
    await expect(rows.nth(n)).not.toContainText("not traced");
    await expect(rows.nth(n).locator(".card-path")).toContainText("GraphQL query Spec");
  }

  // A click opens the call tree of the view that made them, once its trace is stored.
  await storeView(page, tag, { shift: -14_000_000 });
  await rows.nth(1).click();
  await expect(panel(page).locator('.tp-map-row[data-kind="http.client"]')).toContainText("×3");
});

test("the selected view stays in sight at the list's top as its calls fill the list docked right", async ({ page }) => {
  const tag = 13;
  const { release, list, view, calls } = await opened(page);
  const ops = Array.from({ length: 8 }, () => "Book");
  await open(page, id(tag, 1), ops);
  await expect(calls).toHaveCount(8);
  await expect(view).toHaveAttribute("aria-current", "true");
  const inSight = () =>
    view.evaluate((row) => {
      const scroller = row.closest(".panel-wf-rows") as HTMLElement;
      return Math.round(row.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
    });
  await expect.poll(inSight).toBeGreaterThanOrEqual(0);
  for (const n of ops.keys()) release(n);
  await viewEnded(page);
  await expect(list.locator("[data-live]")).toHaveCount(0);
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
  // The view's record counts its whole chain: the queries two hops down.
  const marks = viewRow(list).locator(".tp-record-queries .tp-request-queries");
  await expect(marks).toHaveAttribute("title", "2 SQL queries");

  // The page loaded again on a slow network: the chains take their time to come again.
  await page.route("**/api/traces/*/chain", () => undefined);
  await page.reload();
  // Its numbers at once, as before the reload: the agent's count of the record, not its own trace's 0.
  await expect(viewRow(panelList(page))).toBeVisible();
  await expect(viewRow(panelList(page)).locator(".tp-record-queries .tp-request-queries")).toHaveAttribute(
    "title",
    "2 SQL queries",
  );
});

test("a view's row says no numbers of its chain's while a call's are still on their way, only its time", async ({
  page,
}) => {
  const tag = 16;
  const viewId = id(tag, 1);
  const { release, view } = await opened(page, { headers: bffHeaders(tag) });
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

  // The view's chain counts one call's: the view's row says no sum of half its calls, its time as it is.
  await expect(view.locator(".tp-record-queries .tp-pending")).toHaveCount(1);
  const queries = view.locator(".tp-record-queries .tp-request-queries");
  await expect(queries).toHaveCount(0);

  await ingest(served(tag, made[1] as Made));
  await expect(queries).toHaveAttribute("title", "4 SQL queries");
});

test("the pill says no numbers of a view's chain while a call's trace is on its way, as the view's row in the list", async ({
  page,
}) => {
  const tag = 18;
  const viewId = id(tag, 1);
  // A gateway's calls (no trace id in their answers): only the view's chain says what served them.
  const { release, view } = await opened(page);
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
  await expect(view).not.toHaveClass(/tp-record/);

  // The pill asks for the view's chain too: its numbers "…" as long as the list's, not the 2 queries of one call.
  const shown = pill(page);
  for (let at = 0; at < 8; at += 1) {
    await expect(shown.locator(".pending")).toHaveText("…");
    await expect(shown).not.toHaveAttribute("aria-label", /quer/);
    await page.waitForTimeout(250);
  }

  await ingest(served(tag, made[1] as Made));
  await expect(view.locator(".tp-record-queries .tp-request-queries")).toHaveAttribute("title", "4 SQL queries");
  await expect(shown).toHaveAttribute("aria-label", /4 queries/, { timeout: 5_000 });
  await expect(shown.locator(".pending")).toHaveCount(0);
});
