// A query plan reads like the statement above it: the operation stands out, then its tables and indexes and the
// numbers, and a full scan's operation is in the warning colour.
import type { Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

/** An app that runs EXPLAIN, as the agent answers once one is connected, and the plan it gives. */
async function explainable(page: Page): Promise<void> {
  // The console's, and each app's (`?service=`): one app, its traces' queries.
  await page.route("**/api/capabilities*", (route) =>
    // biome-ignore lint/style/useNamingConvention: wire format.
    route.fulfill({ json: { explain: true, users: false, profile: false, request: false, live_tasks: false } }),
  );
  await page.route("**/api/explain?*", (route) =>
    route.fulfill({
      json: {
        vendor: "postgresql",
        alias: "default",
        analyzed: false,
        lines: [
          {
            depth: 0,
            text: "Index Scan using campaign_pkey on campaign  (cost=0.15..8.17 rows=1 width=4)",
            warning: null,
          },
          { depth: 1, text: "Index Cond: (id = 7)", warning: null },
          {
            depth: 0,
            text: "Seq Scan on campaign_stats_1  (cost=0.00..35.50 rows=2550 width=4)",
            warning: "Sequential scan of campaign_stats_1: no index is used",
          },
        ],
      },
    }),
  );
}

test("a plan's lines are in colour: operations, names, numbers; a full scan's operation warns", async ({ page }) => {
  await explainable(page);
  await page.goto(`/#/t/${await traceId("PATCH /campaigns/{id}/report")}?tab=sql`);
  await page.getByText("SELECT campaign_stats_1").first().click();
  await page.getByRole("button", { name: "Explain", exact: true }).click();
  const lines = page.locator(".tp-plan-line");

  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0).locator(".tp-plan-op")).toHaveText("Index Scan");
  await expect(lines.nth(0).locator(".tp-sql-identifier")).toHaveText(["campaign_pkey", "campaign"]);
  await expect(lines.nth(0).locator(".tp-sql-number")).toHaveText(["0.15..8.17", "1", "4"]);
  await expect(lines.nth(1).locator(".tp-plan-label")).toHaveText("Index Cond:");

  await expect(lines.nth(2)).toHaveAttribute("data-warning", "");
  await expect(lines.nth(2).locator(".tp-plan-op")).toHaveText("Seq Scan");
  const warn = await lines
    .nth(2)
    .locator(".tp-plan-op")
    .evaluate((op) => getComputedStyle(op).color);
  const ok = await lines
    .nth(0)
    .locator(".tp-plan-op")
    .evaluate((op) => getComputedStyle(op).color);
  expect(warn).not.toBe(ok);
});

test("a query opened in the call tree has the DB tab's Query plan", async ({ page }) => {
  await explainable(page);
  await page.goto(`/#/t/${await traceId("PATCH /campaigns/{id}/report")}?tab=tree`);
  await page.locator(".tp-map-row").filter({ hasText: "SELECT campaign_stats_1" }).first().click();
  const details = page.getByRole("complementary", { name: "Details" });

  await expect(details.getByRole("heading", { name: "Query plan" })).toBeVisible();

  await details.getByRole("button", { name: "Explain", exact: true }).click();

  await expect(details.locator(".tp-plan-line")).toHaveCount(3);
});

test("a query's details scrolled to their end stay where they are as Explain runs and its plan comes", async ({
  page,
}) => {
  await explainable(page);
  // The plan held until the test lets it through: the details as Explain runs, then with it.
  let letThrough: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    letThrough = resolve;
  });
  await page.route("**/api/explain?*", async (route) => {
    await held;
    await route.fallback();
  });
  // Low enough that the details scroll.
  await page.setViewportSize({ width: 1440, height: 560 });
  await page.goto(`/#/t/${await traceId("PATCH /campaigns/{id}/report")}?tab=tree`);
  await page.locator(".tp-map-row").filter({ hasText: "SELECT campaign_stats_1" }).first().click();
  const details = page.getByRole("complementary", { name: "Details" });
  await expect(details.getByRole("heading", { name: "Query plan" })).toBeVisible();
  const pane = page.locator("aside.tp-map-side");
  expect(await pane.evaluate((side) => side.scrollHeight > side.clientHeight)).toBe(true);
  await pane.evaluate((side) => side.scrollTo(0, side.scrollHeight));
  // Where the statement and its database's rows are, against the pane.
  const at = () =>
    pane.evaluate((side) =>
      ["pre, code", "dl"].map((selector) =>
        Math.round(
          (side.querySelector(selector) as HTMLElement).getBoundingClientRect().top - side.getBoundingClientRect().top,
        ),
      ),
    );
  const before = await at();

  await details.getByRole("button", { name: "Explain", exact: true }).click();
  await expect(details.getByRole("button", { name: "Explaining…" })).toBeVisible();
  expect(await at()).toEqual(before);

  letThrough();
  await expect(details.locator(".tp-plan-line")).toHaveCount(3);
  expect(await at()).toEqual(before);
});

/** The report's trace with its campaign_stats_1 query's statement as `statement`. */
async function withStatement(page: Page, statement: string): Promise<string> {
  const id = await traceId("PATCH /campaigns/{id}/report");
  await page.route(`**/api/traces/${id}*`, async (route) => {
    const trace = await (await route.fetch()).json();
    for (const span of trace.spans) {
      if (span.kind === "sql" && String(span.name).includes("campaign_stats_1")) span.attrs["db.statement"] = statement;
    }
    await route.fulfill({ json: trace });
  });
  return id;
}

test("a WITH that only reads is explained", async ({ page }) => {
  await explainable(page);
  const id = await withStatement(
    page,
    "WITH recent AS (SELECT * FROM campaign_stats_1 WHERE day > now() - interval '7 days') SELECT * FROM recent",
  );
  await page.goto(`/#/t/${id}?tab=sql`);
  await page.getByText("SELECT campaign_stats_1").first().click();
  await page.getByRole("button", { name: "Explain", exact: true }).click();

  await expect(page.locator(".tp-plan-line")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Explain analyze" })).toBeVisible();
});

test("a WITH that deletes says why it isn't explained, instead of the buttons", async ({ page }) => {
  await explainable(page);
  const id = await withStatement(
    page,
    "WITH gone AS (DELETE FROM campaign_stats_1 WHERE day < %s RETURNING id) SELECT count(*) FROM gone",
  );
  await page.goto(`/#/t/${id}?tab=sql`);
  await page.getByText("SELECT campaign_stats_1").first().click();

  await expect(page.getByText("This query changes data (DELETE inside WITH): it isn't explained.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Explain/ })).toHaveCount(0);
});

test("a query that locks rows is explained, not analyzed", async ({ page }) => {
  await explainable(page);
  const id = await withStatement(page, "SELECT * FROM campaign_stats_1 WHERE id = $1 FOR UPDATE");
  await page.goto(`/#/t/${id}?tab=sql`);
  await page.getByText("SELECT campaign_stats_1").first().click();

  await expect(page.getByRole("button", { name: "Explain", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Explain analyze" })).toHaveCount(0);
  await expect(page.getByText("This query locks rows (FOR UPDATE): it can be explained, not analyzed.")).toBeVisible();
});
