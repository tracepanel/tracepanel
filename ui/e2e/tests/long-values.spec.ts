// biome-ignore-all lint/style/useNamingConvention: the trace format's field names.
// A long value is read whole wherever code shows, in the narrow docked panel too: a dump's value, a query, a request's
// body wrap their long lines inside their box (their indentation kept), never cut off on the right, no box wider than
// the panel.
import type { FrameLocator, Locator } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { openApp, panel, pill } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const TRACE = "01M4WRAP0000000000000000W1";
const PLACED = "datetime.datetime(2026, 10, 30, 16, 42, 7, 512093, tzinfo=datetime.timezone.utc)";
const ORDER = `{\n    'id': 7,\n    'placed': ${PLACED},\n    'note': '${"gift-wrap-".repeat(14)}end',\n}`;
const TOKEN = `${"a1b2c3d4".repeat(24)}END`;
const SQL = `SELECT "order"."id" FROM "order" WHERE "order"."note" = '${"x".repeat(180)}END'`;

async function seed(): Promise<void> {
  const start = Date.now() * 1000 - 5 * 3_600_000_000;
  const span = { start, duration: 300_000, status: "ok" };
  const doc = {
    id: TRACE,
    kind: "http",
    name: "POST /orders/long",
    ...span,
    attrs: {
      "service.name": "longshop",
      "http.method": "POST",
      "http.route": "/orders/long",
      "http.status_code": 200,
      "http.request.header.content_type": "application/json",
      "http.request.body": JSON.stringify({ token: TOKEN }),
    },
    spans: [
      { id: "r", parent_id: null, kind: "http", name: "POST /orders/long", ...span, attrs: {} },
      {
        id: "q",
        parent_id: "r",
        kind: "sql",
        name: "SELECT order",
        ...span,
        start: start + 20_000,
        duration: 2_000,
        attrs: { "db.statement": SQL, "db.vendor": "postgresql" },
      },
    ],
    logs: [
      {
        span_id: "r",
        time: start + 60_000,
        level: "debug",
        logger: "devtools",
        message: `shop/views.py:12 place\n    order: ${ORDER} (dict) len=3`,
        exception: null,
        attrs: {
          "log.kind": "dump",
          "code.origin": "shop/views.py:12 in place",
          "dump.args": [{ expr: "order", repr: ORDER, type: "dict", len: 3 }],
        },
      },
    ],
    errors: [],
    links: [],
    issues: [],
  };
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${TRACE}`)).status).toBe(200);
}

/** The block's text all inside it and inside the panel: no line runs past its right edge, none is cut off. */
async function expectWhole(block: Locator): Promise<void> {
  await expect(block).toBeVisible();
  const fit = await block.evaluate((element) => ({
    overflow: element.scrollWidth - element.clientWidth,
    pastPanel: element.getBoundingClientRect().right - document.documentElement.clientWidth,
  }));

  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.pastPanel).toBeLessThanOrEqual(0);
}

async function openPanel(page: import("@playwright/test").Page): Promise<FrameLocator> {
  await openApp(page, { long: { status: 200, trace: TRACE, queries: 1, totalMs: 300 } });
  await page.getByRole("button", { name: "Load long" }).click();
  await pill(page).click();
  return panel(page);
}

test.beforeEach(seed);

test("in the docked panel a dump's long value wraps inside its box, its indentation kept", async ({ page }) => {
  const frame = await openPanel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await frame.locator('.dt-map-row[data-kind="dump"]').click();
  const value = frame.getByRole("region", { name: "Dump arguments" }).getByRole("region", { name: "order" });
  const pre = value.locator("pre");

  await expect(pre).toHaveText(ORDER);
  await expectWhole(pre);
  // Wrapped, not on one line: the value is taller than its four lines.
  const lines = await pre.evaluate(
    (element) => element.clientHeight / Number.parseFloat(getComputedStyle(element).lineHeight),
  );
  expect(lines).toBeGreaterThan(5);
  // Its lines keep their indentation as printed.
  expect(await pre.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("pre-wrap");
});

test("in the docked panel a long query and a long request body wrap inside their boxes", async ({ page }) => {
  const frame = await openPanel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await frame.locator('.dt-map-row[data-kind="sql"]').first().click();
  const sql = frame.getByRole("complementary", { name: "Details" }).locator("pre").filter({ hasText: "END'" }).first();

  await expectWhole(sql);

  await frame.getByRole("tab", { name: /^Request/ }).click();
  await frame.getByRole("tablist", { name: "Request details" }).getByRole("tab", { name: "Request body" }).click();
  const body = frame.getByRole("tabpanel", { name: "Request body" }).locator("pre");

  await expect(body).toContainText(TOKEN);
  await expectWhole(body);
});

test("on the console's page too, a dump's long value wraps inside its box", async ({ page }) => {
  await page.goto(`/#/t/${TRACE}?tab=tree`);
  await page.locator('.dt-map-row[data-kind="dump"]').click();
  const pre = page.getByRole("region", { name: "Dump arguments" }).locator("pre");

  await expect(pre).toHaveText(ORDER);
  await expectWhole(pre);
});
