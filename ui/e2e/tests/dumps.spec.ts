// biome-ignore-all lint/style/useNamingConvention: the trace format's field names.
// A dump, what a developer printed to look at (devtools' debug()): always in the call tree, with or without the Logs
// chip, as DUMP with its call site and first value; its details lay out each argument, coloured; the Logs page lists
// it with the same look and its Kind menu finds dumps (has:dump).
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

const TRACE = "01M4DVMP0000000000000000D1";
const ORDER = "Order(\n    id=7,\n    total=Decimal('12.50'),\n    paid=False,\n)";

async function seed(): Promise<void> {
  const start = Date.now() * 1000 - 7 * 3_600_000_000;
  const doc = {
    id: TRACE,
    kind: "http",
    name: "POST /checkout",
    start,
    duration: 300_000,
    status: "ok",
    attrs: { "service.name": "dumpshop", "http.method": "POST", "http.route": "/checkout" },
    spans: [
      {
        id: "r",
        parent_id: null,
        kind: "http",
        name: "POST /checkout",
        start,
        duration: 300_000,
        status: "ok",
        attrs: {},
      },
      {
        id: "v",
        parent_id: "r",
        kind: "view",
        name: "shop.views.checkout",
        start: start + 10_000,
        duration: 250_000,
        status: "ok",
        attrs: {},
      },
    ],
    logs: [
      {
        span_id: "v",
        time: start + 50_000,
        level: "info",
        logger: "shop",
        message: "cart priced quietly",
        exception: null,
        attrs: {},
      },
      {
        span_id: "v",
        time: start + 60_000,
        level: "debug",
        logger: "devtools",
        message: `shop/views.py:41 checkout\n    order: ${ORDER} (Order)\n    'ready' (str) len=5`,
        exception: null,
        attrs: {
          "log.kind": "dump",
          "code.origin": "shop/views.py:41 in checkout",
          "dump.args": [
            { expr: "order", repr: ORDER, type: "Order", len: null },
            { expr: null, repr: "'ready'", type: "str", len: 5 },
          ],
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

test.beforeEach(seed);

test("a dump shows in the call tree with the Logs chip off, its details lay out each argument", async ({ page }) => {
  await page.goto(`/#/t/${TRACE}?tab=tree`);
  const row = page.locator('.dt-map-row[data-kind="dump"]');

  await expect(row).toHaveCount(1);
  await expect(row.locator(".dt-dump-badge")).toHaveText("dump");
  await expect(row.locator(".dt-dump-site")).toHaveText("shop/views.py:41");
  await expect(row.locator(".dt-dump-value")).toHaveText("order = Order( id=7, total=Decimal('12.50'), paid=False, )");
  await expect(row.locator(".dt-dump-more")).toHaveText("+1");
  // The info record waits for the Logs chip.
  await expect(page.getByText("cart priced quietly")).toHaveCount(0);

  await row.click();
  const dump = page.getByRole("region", { name: "Dump arguments" });

  await expect(dump.getByText("shop/views.py:41 in checkout")).toBeVisible();
  const order = dump.getByRole("region", { name: "order" });
  await expect(order.locator("code").first()).toHaveText("order");
  await expect(order.locator(".dt-dump-type")).toHaveText("Order");
  // The value as printed, its lines kept, coloured as Python.
  await expect(order.locator("pre")).toHaveText(ORDER);
  await expect(order.locator("pre .token.function").first()).toHaveText("Order");
  await expect(order.locator("pre .token.string")).toHaveText("'12.50'");
  await expect(order.locator("pre .token.boolean")).toHaveText("False");
  const second = dump.getByRole("region", { name: "Argument 2" });
  await expect(second.locator(".dt-dump-type")).toHaveText("str · len 5");
});

test("the Logs page lists a dump in its look, and its Kind menu finds dumps", async ({ page }) => {
  await page.goto(`/#/logs?q=${encodeURIComponent(`trace:${TRACE}`)}`);
  const rows = page.getByRole("region", { name: "Logs" }).locator("tr[data-record]");

  await expect(rows).toHaveCount(2);

  await page.getByRole("button", { name: "Kind", exact: true }).click();
  await page.getByRole("option", { name: "Dumps" }).click();

  await expect(page).toHaveURL(/has(%3A|:)dump/);
  await expect(rows).toHaveCount(1);
  const dump = rows.first();
  await expect(dump.locator(".dt-dump-badge")).toHaveText("dump");
  await expect(dump.locator(".dt-dump-site")).toHaveText("shop/views.py:41");
  await expect(dump.locator(".dt-dump-value .token.function").first()).toHaveText("Order");
  // Its level as sent, for the Level menu.
  await expect(dump.locator("td").nth(1)).toHaveText("debug");

  await dump.click();
  await expect(page.getByRole("region", { name: "Dump arguments" }).locator("pre").first()).toHaveText(ORDER);
});
