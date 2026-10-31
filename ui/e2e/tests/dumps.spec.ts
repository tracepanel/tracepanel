// biome-ignore-all lint/style/useNamingConvention: the trace format's field names.
// A dump, what a developer printed to look at (devtools' debug()): always in the call tree, with or without the Logs
// chip, as DUMP with its call site and first value; its details lay out each argument, coloured; the Logs page lists
// it with the same look and its Kind menu finds dumps (has:dump). Each SDK's values are coloured in their language:
// the one the dump says (dump.lang), else its dumper's, else its file's.
import { dumpLanguage } from "../../packages/ui/src/lib/dump.ts";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

const TRACE = "01M4DVMP0000000000000000D1";
const ORDER = "Order(\n    id=7,\n    total=Decimal('12.50'),\n    paid=False,\n)";
const POLYGLOT = "01M4DVMP0000000000000000D2";
const GO_ORDER = 'main.Order{\n    ID:    7,\n    Items: []string{"book"},\n    Next:  nil,\n}';
const JS_ORDER = "Order { id: 7, type: 'book', items: [Array], meta: Map(1) { 'a' => true } }";

async function ingest(doc: object, id: string): Promise<void> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${id}`)).status).toBe(200);
}

/** A trace of `service`'s one request, its view's span `v` holding `logs`. */
function request(id: string, service: string, start: number, logs: object[]): object {
  const span = { start, duration: 300_000, status: "ok", attrs: {} };
  return {
    id,
    kind: "http",
    name: "POST /checkout",
    ...span,
    attrs: { "service.name": service, "http.method": "POST", "http.route": "/checkout" },
    spans: [
      { id: "r", parent_id: null, kind: "http", name: "POST /checkout", ...span },
      { id: "v", parent_id: "r", kind: "view", name: "checkout", ...span, start: start + 10_000, duration: 250_000 },
    ],
    logs,
    errors: [],
    links: [],
    issues: [],
  };
}

/** A dump as the SDKs other than Python's send it: the language its value is printed in, said. */
function dump(time: number, logger: string, lang: string, origin: string, expr: string, repr: string): object {
  return {
    span_id: "v",
    time,
    level: "debug",
    logger,
    message: `${origin}\n    ${expr}: ${repr}`,
    exception: null,
    attrs: {
      "log.kind": "dump",
      "dump.lang": lang,
      "code.origin": origin,
      "dump.args": [{ expr, repr, type: "Order", len: null }],
    },
  };
}

async function seedPolyglot(): Promise<void> {
  const start = Date.now() * 1000 - 6 * 3_600_000_000;
  const logs = [
    dump(start + 40_000, "tracepanel", "go", "cmd/shop/main.go:22 in main.checkout", "order", GO_ORDER),
    dump(start + 60_000, "console", "javascript", "src/checkout.ts:12 in checkout", "order", JS_ORDER),
  ];
  await ingest(request(POLYGLOT, "polyshop", start, logs), POLYGLOT);
}

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
  await ingest(doc, TRACE);
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

test("a dump's values are in the language it says, else its dumper's, else its file's", () => {
  const said = (lang: string | undefined, logger = "tracepanel", origin = "main.go:3") =>
    dumpLanguage({ logger, attrs: { "code.origin": origin, ...(lang === undefined ? {} : { "dump.lang": lang }) } });

  expect([said("go"), said("Kotlin", "devtools"), said("TypeScript"), said("ruby", "devtools")]).toEqual([
    "go",
    "kotlin",
    "javascript",
    null,
  ]);

  expect([said(undefined), said(undefined, "devtools"), said("", "tracepanel", "Shop.kt:9 in Shop.buy")]).toEqual([
    "go",
    "python",
    "kotlin",
  ]);
});

test("a Go dump and a JavaScript dump are coloured in their languages", async ({ page }) => {
  await seedPolyglot();
  await page.goto(`/#/t/${POLYGLOT}?tab=tree`);
  const rows = page.locator('.dt-map-row[data-kind="dump"]');

  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator(".dt-dump-site")).toHaveText("cmd/shop/main.go:22");
  await expect(rows.nth(0).locator(".dt-dump-value .token.class-name").first()).toHaveText("Order");
  await expect(rows.nth(1).locator(".dt-dump-site")).toHaveText("src/checkout.ts:12");
  await expect(rows.nth(1).locator(".dt-dump-value .token.string").first()).toHaveText("'book'");

  await rows.nth(0).click();
  const go = page.getByRole("region", { name: "Dump arguments" }).locator("pre");

  await expect(go).toHaveText(GO_ORDER);
  await expect(go.locator(".token.class-name")).toHaveText("Order");
  await expect(go.locator(".token.builtin")).toHaveText("string");
  await expect(go.locator(".token.string")).toHaveText('"book"');
  await expect(go.locator(".token.boolean")).toHaveText("nil");
  await expect(go.locator(".token.number")).toHaveText("7");

  await rows.nth(1).click();
  const js = page.getByRole("region", { name: "Dump arguments" }).locator("pre");

  await expect(js).toHaveText(JS_ORDER);
  await expect(js.locator(".token.class-name")).toHaveText("Order");
  // A key named as a keyword is a key.
  await expect(js.locator(".token.keyword")).toHaveCount(0);
  await expect(js.locator(".token.string")).toHaveText(["'book'", "'a'"]);
  await expect(js.locator(".token.builtin")).toHaveText(["Array", "Map"]);
  await expect(js.locator(".token.boolean")).toHaveText("true");
});
