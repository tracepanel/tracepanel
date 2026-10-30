// A browser's view whose calls went through a gateway (Apollo Router, over OTLP): the gateway answers with no trace id
// for the widget, so the view has no requests listed under it, and only its chain says what its calls did. The list
// shows the apps down the chain under the view, the pill counts what they did, as the panel's tabs count it, and
// each call says what it was answered: its status (5xx or no answer red, 4xx amber), and its time, the served
// trace's when the page sent its trace before the call ended.
import type { Page } from "@playwright/test";
import { CONSOLE, RUN_STARTED } from "../agent.ts";
import { openApp, panel, pill } from "../app.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const W3C = "6c1b2a7e9d0f4e3a8b5c7d9e1f2a3b4c";
const id = (n: number) => `01M4V1EWCHA1N${String(n).padStart(13, "0")}`;
const VIEW = id(1);

function span(name: string, parent: string | null, kind: string, label: string, start: number, duration: number) {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id: name, parent_id: parent, kind, name: label, start, duration, status: "ok", attrs: {} as Doc };
}

/**
 * A call of the view to the gateway, carrying the trace on (`w3c`), with its answer's attributes (none: it hadn't
 * ended); `error: true` marks the span failed, as the browser recording does on a 5xx or no answer.
 */
function call(name: string, start: number, duration: number, w3c: string, answer: Doc): Doc {
  const each = span(name, "p0", "http.client", "POST 127.0.0.1:4000/graphql", start, duration);
  each.attrs = {
    "http.request.method": "POST",
    "url.full": "http://127.0.0.1:4000/graphql",
    "server.address": "127.0.0.1",
    "server.port": 4000,
    "w3c.span_id": w3c,
    ...answer,
  };
  return { ...each, status: answer["error"] === true ? "error" : "ok", attrs: withoutFlag(each.attrs) };
}

function withoutFlag(attrs: Doc): Doc {
  const { error: _, ...rest } = attrs;
  return rest;
}

function trace(n: number, kind: string, name: string, app: string, start: number, duration: number, extra: Doc): Doc {
  return {
    id: id(n),
    kind,
    name,
    start,
    duration,
    status: "ok",
    attrs: { "service.name": app, "w3c.trace_id": W3C, ...(extra["attrs"] as Doc | undefined) },
    spans: [span(`r${n}`, null, kind, name, start, duration), ...((extra["spans"] as Doc[] | undefined) ?? [])],
    logs: [],
    errors: [],
    links: [],
    issues: [],
    ...(extra["status"] ? { status: extra["status"] } : {}),
  };
}

/** The gateway's trace of one call: its status, and the call to the subgraph it made when it has one. */
function gateway(n: number, start: number, duration: number, parent: string, status: number, extra: Doc = {}): Doc {
  return trace(n, "http", "GraphQL query Orders", "gateway", start, duration, {
    ...extra,
    attrs: {
      "w3c.parent_span_id": parent,
      "http.method": "POST",
      "http.status_code": status,
      "http.route": "/graphql",
    },
    ...(status >= 500 ? { status: "error" } : {}),
  });
}

/**
 * The view and what served its calls: the gateway's traces of four of them (200, 404, 503, and one the page sent its
 * trace before it ended, at 0 µs), the subgraph under the first with three queries; one call failed with no answer,
 * one an older SDK recorded with status 0.
 */
async function seed(): Promise<void> {
  const start = Number(process.env[RUN_STARTED] ?? Date.now()) * 1000 - 3 * 3_600_000_000;
  // Named as the recording names the page's view (app.ts): /app/.
  const view = trace(1, "page", "/app/", "shop-web", start, 3_000_000, {
    attrs: { "service.role": "browser", "page.path": "/app/" },
    spans: [
      call("c1", start + 10_000, 400_000, "a000000000000001", { "http.response.status_code": 200 }),
      call("c2", start + 20_000, 100_000, "a000000000000002", { "http.response.status_code": 404 }),
      call("c3", start + 30_000, 300_000, "a000000000000003", { "http.response.status_code": 503, error: true }),
      call("c4", start + 40_000, 50_000, "a000000000000004", { "error.type": "TypeError", error: true }),
      call("c5", start + 50_000, 0, "a000000000000005", {}),
      call("c6", start + 60_000, 70_000, "a000000000000006", { "http.response.status_code": 0, error: true }),
    ],
  });
  (view["spans"] as Doc[])[0] = { ...span("p0", null, "page", "/app/", start, 3_000_000) };
  const subgraphCall = span("g1c", "r2", "http.client", "POST 127.0.0.1:4001/", start + 30_000, 300_000);
  subgraphCall.attrs = {
    "http.request.method": "POST",
    "url.full": "http://127.0.0.1:4001/",
    "http.response.status_code": 200,
    "w3c.span_id": "b000000000000001",
  };
  const queries = [0, 1, 2].map((q) => {
    const each = span(`q${q}`, "r3", "sql", "SELECT orders", start + 50_000 + q * 10_000, 5_000);
    each.attrs = { "db.statement": `SELECT * FROM orders WHERE id = ${q + 1}`, "db.system": "postgresql" };
    return each;
  });
  const traces = [
    view,
    gateway(2, start + 15_000, 380_000, "a000000000000001", 200, { spans: [subgraphCall] }),
    trace(3, "http", "GraphQL query Orders__0", "subgraph", start + 35_000, 280_000, {
      attrs: { "w3c.parent_span_id": "b000000000000001", "http.method": "POST", "http.status_code": 200 },
      spans: queries,
    }),
    gateway(4, start + 25_000, 80_000, "a000000000000002", 404),
    gateway(5, start + 35_000, 250_000, "a000000000000003", 503),
    gateway(6, start + 55_000, 2_000_000, "a000000000000005", 200),
  ];
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(traces),
  });
  expect(response.status).toBe(202);
  await expect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${VIEW}/chain`)).json()) as Doc)["traces"])
    .toHaveLength(6);
}

/** The page whose recorded view is the seeded one, its panel open on it. */
async function openView(page: Page): Promise<void> {
  await seed();
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, {}, { recording: true, view: VIEW });
}

test("a view whose calls went through a gateway has the apps down its chain under it in the list", async ({ page }) => {
  await openView(page);
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  const apps = list.locator('.dt-request-row[data-chain="app"]');

  await expect(list.locator(".dt-request-row").first()).toContainText("/app/");
  await expect(apps.locator(".dt-app-chip")).toHaveText(["gateway"]);
  await expect(apps.first().locator(".dt-map-times")).toHaveText("×4");
});

test("the pill of a view counts what its chain did, as the panel's tabs count it", async ({ page }) => {
  await openView(page);

  // Its queries (the subgraph's three), the HTTP calls down the chain, no findings.
  await expect(pill(page)).toHaveAccessibleName(/^tracepanel: view of \/app\/: 3 queries, 7 HTTP calls down its calls/);
  await expect(pill(page)).toContainText("VIEW /app/");
  await expect(pill(page).locator(".seg").nth(2)).toHaveText("3");
  await expect(pill(page).locator(".seg").nth(3)).toHaveText("7");

  await pill(page).click();
  await panel(page).locator('.dt-request-row[data-kind="page"]').first().click();

  await expect(panel(page).getByRole("tab", { name: /^DB/ })).toContainText("3");
  await expect(panel(page).getByRole("tab", { name: /^HTTP calls/ })).toContainText("7");
});

test("each call says what it was answered: 200, 404 amber, 503 and no answer red; a cut call takes its trace's time", async ({
  page,
}) => {
  await seed();
  await page.goto(`/#/t/${VIEW}?tab=tree`);
  // The four the gateway served: a group (×4), opened; the two with no answer, rows of their own after it.
  await page.locator(".dt-map-row").filter({ hasText: "×4" }).click();
  // The view's own calls (the gateway's to the subgraph is under the first).
  const rows = page
    .locator('.dt-map-row[data-kind="http.client"]')
    .filter({ hasText: "/graphql" })
    .filter({ hasNotText: "×4" });

  await expect(rows).toHaveCount(6);
  await expect(rows.locator(".dt-status")).toHaveText(["200", "404", "503", "200", "failed", "failed"]);
  expect(await rows.evaluateAll((all) => all.map((row) => row.getAttribute("data-status")))).toEqual([
    "ok",
    "warn",
    "error",
    "ok",
    "error",
    "error",
  ]);
  // The 404's row in the warning's colour, the 503's in the error's, as the lists mark them.
  const colours = await rows.evaluateAll((all) => all.map((row) => getComputedStyle(row).getPropertyValue("--dt-k")));
  expect(colours[1]).not.toEqual(colours[2]);
  expect(colours[1]).not.toEqual(colours[0]);

  // The call the page sent its trace before it ended: the gateway's 2 s, never 0 µs; its hover says why.
  const cut = rows.nth(3);
  await expect(cut.locator(".dt-map-time")).toHaveText("2.0 s");
  await expect(cut.locator(".dt-map-time")).toHaveAttribute("title", /sent its trace before this call ended/);
  // A call with no answer names what failed; an older SDK's status 0 is no answer either.
  await expect(rows.nth(4).locator(".dt-status")).toHaveAttribute("title", "TypeError");
  await expect(rows.nth(5).locator(".dt-status")).toHaveAttribute("title", "No answer");
});
