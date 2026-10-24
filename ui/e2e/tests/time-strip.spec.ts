// A trace's time in one strip: its own lane in its shares' colours, a long stretch of its code with no recorded
// calls hatched and said, a lane per system it called named by what its marks are, the legend under them. Its
// header says what it called in one line, no tiles. In the call tree a span whose code ran long without calls says
// so in a row of its own, and a transaction says how long it was open and how much of that was SQL.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { HELD_REPORT } from "../seed.ts";

type Scope = Page | FrameLocator;

function row(scope: Scope, kind: string, name: string | RegExp): Locator {
  return scope.locator(`.dt-map-row[data-kind="${kind}"]`).filter({ hasText: name });
}

test("the header says what the trace called in one line, and no tiles", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("GET /account/orders/")}`);

  await expect(page.locator(".dt-trace-facts")).toHaveText(/^· 151 queries \d+ ms · 4 unique · 3 HTTP calls \d+ ms$/);
  await expect(page.locator(".dt-metrics, .dt-metric")).toHaveCount(0);
});

test("the strip names its lanes by what their marks are and says a long stretch with no recorded calls", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=tree`);
  const strip = page.getByRole("region", { name: "Time" });
  const lanes = strip.getByRole("figure", { name: "Timeline" });

  await expect(lanes.locator(".dt-lane-label")).toHaveText(["task", "139 queries", "1 log record"]);
  await expect(lanes.locator(".dt-quiet-label")).toHaveText(/^1\.\d s · no recorded calls$/);
  await expect(strip.getByRole("list", { name: /^Where the time went/ })).toContainText("Database");

  await lanes.locator(".dt-quiet").hover();

  await expect(page.getByRole("tooltip").filter({ hasText: "no recorded calls" })).toBeVisible();
});

test("a transaction says how long it was open and its SQL; its code's own time is a row of its own", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=tree`);
  const transaction = row(page, "transaction", "transaction default");
  const quiet = page.locator('.dt-map-row[data-kind="quiet"]');

  await expect(transaction.locator(".dt-map-sub")).toHaveText(/^open 1\.6 s · SQL \d+ ms$/);
  await expect(transaction.locator(".dt-map-sub")).toHaveAttribute(
    "title",
    /^Time the transaction was open; SQL inside took \d+ ms, the rest is code running while it's held$/,
  );

  await expect(quiet).toHaveCount(1);
  await expect(quiet).toContainText("no recorded calls");
  await expect(quiet.locator(".dt-map-time")).toHaveText("1.6 s");
  await expect(quiet.getByRole("button")).toHaveCount(0);

  await quiet.click();

  await expect(page.getByRole("complementary", { name: "Details" })).toHaveCount(0);

  await page
    .getByRole("list", { name: /^Where the time went/ })
    .locator('[data-category="sql"]')
    .getByRole("button")
    .click();

  await expect(quiet).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Transactions/ })).toContainText("1");

  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=tree&range=800-1200`);

  await expect(quiet).toHaveCount(1);
  await expect(transaction).toBeVisible();
  await expect(row(page, "sql", "SELECT product")).toHaveCount(0);
});

test("in the panel the strip heads its Request and Call tree tabs, the same quiet row in the tree", async ({
  page,
}) => {
  await openApp(page, { held: { status: 200, trace: await traceId(HELD_REPORT), queries: 139, totalMs: 1600 } });
  await page.getByRole("button", { name: "Load held" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();

  await expect(frame.getByRole("region", { name: "Time" }).locator(".dt-quiet-label")).toHaveText(/no recorded calls/);
  await expect(frame.locator('.dt-map-row[data-kind="quiet"]')).toHaveCount(1);

  await frame.getByRole("tablist").first().getByRole("tab").first().click();

  await expect(frame.getByRole("region", { name: "Time" }).getByRole("figure", { name: "Timeline" })).toBeVisible();
});
