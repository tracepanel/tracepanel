// A browser's view whose calls go through a GraphQL gateway (its answers carry no trace of their own): in the panel's
// list each call is one row from the moment it starts until its trace is stored. A call that answered stays, its
// time stopped, while the view still runs; in flight, answered, waiting for its trace and stored, it keeps its name
// (its operation), its place and its row, and only fills in; the view's time never runs past its end and back.
import type { Locator, Page, Route } from "@playwright/test";
import { CONSOLE, PORT } from "../agent.ts";
import { panel } from "../app.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const ms = 1_000;
const OPERATIONS = ["Features", "TenantRoles", "Campaigns"];

const run = () => test.info().repeatEachIndex * 2 + test.info().retry;
const digits = (value: number, width: number) => String(value).padStart(width, "0");
const id = (tag: number, n: number) => `01M4SM00THXS${digits(tag, 3)}${digits(run(), 5)}${digits(n, 6)}`;
const traceOf = (tag: number) => `${digits(tag, 4)}${digits(run(), 5)}e1a2b3c4d5e6f7a8b9c0d1e`;
const callOf = (tag: number, n: number) => `${digits(tag, 3)}b${digits(run(), 5)}${digits(n, 7)}`;

// tracepanel-js's browser recording, by its contract with the widget (app.ts): a view announced as it opens and as it
// ends, each Response marked with it. `openView` makes the view's calls to the gateway at once and ends the view a
// while after the last answered, its time up to that answer, as the recording does.
const PAGE = `<!doctype html><html><head><script>
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
    const view = { id, name: "/campaigns", start: now(), duration: 0, status: "ok", open: true };
    current = view;
    window.view = view;
    announce(view);
    let left = ops.length;
    for (const op of ops) {
      const call = { op, start: now(), end: 0 };
      window.calls.push(call);
      fetch("/gw/graphql", {
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
</script><script src="/widget.min.js" data-tracepanel-api="/"></script><title>app</title></head><body></body></html>`;

/** The page's way to open its view with its calls (PAGE). */
type Opener = { openView: (viewId: string, ops: string[], quietMs: number) => void };

/** The gateway's answers, each held until the test lets it through: no Tracepanel headers (it records over OTLP). */
async function gateway(page: Page): Promise<(op: string) => void> {
  const held = new Map<string, Route>();
  const released = new Set<string>();
  const answer = (route: Route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  await page.route("**/gw/graphql", async (route) => {
    const op = (JSON.parse(route.request().postData() ?? "{}") as { operationName?: string }).operationName ?? "";
    if (released.has(op)) await answer(route);
    else held.set(op, route);
  });
  return (op) => {
    released.add(op);
    const route = held.get(op);
    if (route) void answer(route);
  };
}

/**
 * A host of its own for a test's calls (and its repeats'): the agent's service map remembers which app served a host,
 * so a host another test's calls went to would be named by that app from the start. A *.localhost name is the agent.
 */
const ownHost = (tag: number) => `http://calls-${tag}-${run()}.localhost:${PORT}/`;

/** The page with the panel open at the bottom, its view about to open; served from `origin` (its calls' host). */
async function opened(
  page: Page,
  origin = CONSOLE,
): Promise<{ release: (op: string) => void; list: Locator; calls: Locator }> {
  await page.addInitScript(() =>
    sessionStorage.setItem("tracepanel:panel", JSON.stringify({ open: true, dock: "bottom" })),
  );
  const release = await gateway(page);
  await page.route("**/calls/", (route) => route.fulfill({ contentType: "text/html", body: PAGE }));
  await page.goto(new URL("calls/", origin).href);
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  await expect(list).toBeVisible();
  return { release, list, calls: list.locator('.tp-request-row[data-depth="2"]') };
}

/** Each call's row: its name and whether it runs. */
function rowsOf(calls: Locator) {
  return calls.evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.querySelector(".tp-request-path")?.textContent ?? "",
      running: row.querySelector(".tp-running") !== null,
    })),
  );
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

/** What the recording sends once the view ended: the view, its calls as the page made them (to `origin`). */
async function storeView(page: Page, tag: number, origin = CONSOLE): Promise<void> {
  const { view, calls } = await page.evaluate(() => {
    const w = window as unknown as { view: Doc; calls: { op: string; start: number; end: number }[] };
    return { view: w.view, calls: w.calls };
  });
  const viewId = id(tag, 1);
  const spans = calls.map((call, n) => {
    const each = span(
      `v${tag}-${n}`,
      `${viewId}r`,
      "http.client",
      "POST 127.0.0.1/gw/graphql",
      call.start,
      call.end - call.start,
    );
    each["attrs"] = {
      "http.request.method": "POST",
      "url.full": `${origin}gw/graphql`,
      "server.address": new URL(origin).hostname,
      "server.port": Number(new URL(origin).port),
      "w3c.span_id": callOf(tag, OPERATIONS.indexOf(call.op)),
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
    "page.path": "/campaigns",
    "page.trigger": "navigation",
    "w3c.trace_id": traceOf(tag),
  };
  await ingest([trace(viewId, "page", "/campaigns", Number(view["start"]), Number(view["duration"]), attrs, spans)]);
}

/** The gateway's traces of the view's calls, as the app `app`. */
async function storeGateway(page: Page, tag: number, app = "gateway"): Promise<void> {
  const calls = await page.evaluate(
    () => (window as unknown as { calls: { op: string; start: number; end: number }[] }).calls,
  );
  await ingest(
    calls.map((call) => {
      const n = OPERATIONS.indexOf(call.op);
      return trace(
        id(tag, 10 + n),
        "http",
        `GraphQL query ${call.op}`,
        call.start + 2 * ms,
        call.end - call.start - 4 * ms,
        {
          "service.name": app,
          "w3c.trace_id": traceOf(tag),
          "w3c.parent_span_id": callOf(tag, n),
          "http.method": "POST",
          "http.route": "/graphql",
          "http.status_code": 200,
        },
        [],
      );
    }),
  );
}

test("a call that answered stays in the list, its time stopped, while its view still runs", async ({ page }) => {
  const { release, calls } = await opened(page);
  await page.evaluate(
    (viewId) => (window as unknown as Opener).openView(viewId, ["Features", "TenantRoles", "Campaigns"], 1_500),
    id(1, 1),
  );

  await expect
    .poll(() => rowsOf(calls))
    .toEqual([
      { name: "query Features", running: true },
      { name: "query TenantRoles", running: true },
      { name: "query Campaigns", running: true },
    ]);

  release("Features");

  // Answered: still its row, in its place, its time stopped; the others still run.
  await expect
    .poll(() => rowsOf(calls))
    .toEqual([
      { name: "query Features", running: false },
      { name: "query TenantRoles", running: true },
      { name: "query Campaigns", running: true },
    ]);
  const time = await calls.first().locator(".tp-request-meta").innerText();
  await page.waitForTimeout(600);
  expect(await calls.first().locator(".tp-request-meta").innerText()).toBe(time);
  // Its numbers come with the view's trace.
  await expect(calls.first().locator(".tp-pending")).toHaveText("…");

  release("TenantRoles");
  release("Campaigns");

  await expect
    .poll(() => rowsOf(calls))
    .toEqual([
      { name: "query Features", running: false },
      { name: "query TenantRoles", running: false },
      { name: "query Campaigns", running: false },
    ]);
});

test("a call keeps its row, its name and its place from in flight to its stored trace; only details fill in", async ({
  page,
}) => {
  const tag = 2;
  const origin = ownHost(tag);
  const app = `gateway-${tag}-${run()}`;
  const { release, list, calls } = await opened(page, origin);
  await page.evaluate(([viewId, ops]) => (window as unknown as Opener).openView(viewId, ops, 200), [
    id(tag, 1),
    OPERATIONS,
  ] as const);
  const names = OPERATIONS.map((op) => `query ${op}`);
  await expect(calls.locator(".tp-request-path")).toHaveText(names);
  // Over them from the start, the row of the host they went to: the same row the gateway's name takes later.
  const group = list.locator('.tp-request-row[data-call="group"]');
  await expect(group.locator(".tp-app-chip")).toHaveText(new URL(origin).host);
  await expect(group.locator(".tp-map-times")).toHaveText("×3");
  // Each row marked: the same element must be there at the end, not a new row in its place.
  await calls.evaluateAll((rows) => {
    for (const [n, row] of rows.entries()) (row as HTMLElement).dataset["probe"] = String(n);
  });
  await group.evaluate((row) => {
    (row as HTMLElement).dataset["probe"] = "group";
  });
  const probes = () => calls.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset["probe"] ?? "new"));

  for (const op of OPERATIONS) release(op);
  await expect(calls.locator(".tp-running")).toHaveCount(0);
  await page.waitForFunction(() => (window as unknown as { view?: { open: boolean } }).view?.open === false);

  // The view's trace stored: each call's row now its chain's, waiting for its trace, the same row.
  await storeView(page, tag, origin);
  await expect(list.locator('.tp-request-row[data-call="waiting"]')).toHaveCount(3);
  await expect(calls.locator(".tp-request-path")).toHaveText(names);
  expect(await probes()).toEqual(["0", "1", "2"]);

  // The gateway's traces stored: the same rows, their numbers filled in; no other group in their place.
  await storeGateway(page, tag, app);
  await expect(list.locator('.tp-request-row[data-call="trace"]')).toHaveCount(3);
  await expect(calls.locator(".tp-request-path")).toHaveText(names);
  await expect(calls.locator(".tp-request-queries-n")).toHaveText(["0", "0", "0"]);
  await expect(list.locator('.tp-request-row[data-chain="app"]')).toHaveCount(0);
  expect(await probes()).toEqual(["0", "1", "2"]);
  // The host's row now says which app served them, the same row, the calls still under it.
  await expect(group.locator(".tp-app-chip")).toHaveText(app);
  await expect(group.locator(".tp-map-times")).toHaveText("×3");
  expect(await group.getAttribute("data-probe")).toBe("group");
});

/** A time as the list writes it, in µs: "850 ms", "1.2 s". */
function micros(text: string): number {
  const match = /([\d.]+)\s*(µs|ms|s)/.exec(text);
  if (!match) return Number.NaN;
  const value = Number(match[1]);
  return match[2] === "s" ? value * 1_000_000 : match[2] === "ms" ? value * 1_000 : value;
}

test("a view's time never runs past its end and back", async ({ page }) => {
  const tag = 3;
  const { release, list } = await opened(page);
  await page.evaluate(([viewId, ops]) => (window as unknown as Opener).openView(viewId, ops, 1_500), [
    id(tag, 1),
    OPERATIONS,
  ] as const);
  const view = list.locator('.tp-request-row[data-kind="page"]');
  const times: number[] = [];
  const sample = async () => times.push(micros(await view.locator(".tp-request-meta").innerText()));
  await expect(view).toBeVisible();

  setTimeout(() => {
    for (const op of OPERATIONS) release(op);
  }, 700);
  // Through its calls, the quiet after them, its end, and its trace stored.
  for (let at = 0; at < 30; at += 1) {
    await sample();
    await page.waitForTimeout(100);
  }
  await storeView(page, tag);
  // Its calls no trace answered: waited for, then said not traced, its numbers known.
  await expect(view.locator(".tp-pending")).toHaveCount(0, { timeout: 15_000 });
  await sample();

  const shown = times.filter((each) => !Number.isNaN(each));
  expect(shown.length).toBeGreaterThan(20);
  for (const [n, each] of shown.entries())
    expect(each, `sample ${n} of ${shown.join(", ")}`).toBeGreaterThanOrEqual(shown[n - 1] ?? 0);
});

test("a row the agent never got says what is known, never a number on its way for good", async ({ page }) => {
  // A view this tab listed two minutes ago whose trace never reached the agent (the store was cleared since).
  const gone = id(4, 1);
  const start = (Date.now() - 120_000) * ms;
  await page.addInitScript(
    ({ gone, start }) => {
      if (sessionStorage.getItem("tracepanel:tab")) return;
      const summary = { name: "/gone", status: null, start, duration: 2_000_000, queries: 0, issues: 0, kind: "page" };
      sessionStorage.setItem("tracepanel:tab", JSON.stringify([{ id: gone, parent: null, summary }]));
    },
    { gone, start },
  );
  const { list } = await opened(page);
  const row = list.locator('.tp-request-row[data-kind="page"]').filter({ hasText: "/gone" });

  await expect(row).toContainText("2.0 s");
  await expect(row.locator(".tp-pending")).toHaveCount(0);
});

test("a view's calls to a host an app served before are under that app's name from in flight on", async ({ page }) => {
  const tag = 5;
  const { release, list } = await opened(page);
  const open = (viewId: string, ops: readonly string[]) =>
    page.evaluate(([each, names]) => (window as unknown as Opener).openView(each, [...names], 200), [
      viewId,
      ops,
    ] as const);
  await open(id(tag, 1), OPERATIONS);
  for (const op of OPERATIONS) release(op);
  await page.waitForFunction(() => (window as unknown as { view?: { open: boolean } }).view?.open === false);
  await storeView(page, tag);
  await storeGateway(page, tag);
  const groups = list.locator('.tp-request-row[data-call="group"]');
  await expect(groups.locator(".tp-app-chip")).toHaveText(["gateway"]);

  // The next view's calls, still in flight: under the gateway's name already, as their traces will say.
  await open(id(tag, 2), ["Profile", "Items"]);

  const next = groups.nth(1);
  await expect(next.locator(".tp-app-chip")).toHaveText("gateway");
  await expect(next).toHaveAttribute("data-state", "running");
  await expect(next.locator(".tp-map-times")).toHaveText("×2");
});
