// A query plan reads like the statement above it: the operation stands out, then its tables and indexes and the
// numbers, and a full scan's operation is in the warning colour.
import type { Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

/** An app that runs EXPLAIN, as the agent answers once one is connected, and the plan it gives. */
async function explainable(page: Page): Promise<void> {
  await page.route("**/api/capabilities", (route) =>
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
  const lines = page.locator(".dt-plan-line");

  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0).locator(".dt-plan-op")).toHaveText("Index Scan");
  await expect(lines.nth(0).locator(".dt-sql-identifier")).toHaveText(["campaign_pkey", "campaign"]);
  await expect(lines.nth(0).locator(".dt-sql-number")).toHaveText(["0.15..8.17", "1", "4"]);
  await expect(lines.nth(1).locator(".dt-plan-label")).toHaveText("Index Cond:");

  await expect(lines.nth(2)).toHaveAttribute("data-warning", "");
  await expect(lines.nth(2).locator(".dt-plan-op")).toHaveText("Seq Scan");
  const warn = await lines
    .nth(2)
    .locator(".dt-plan-op")
    .evaluate((op) => getComputedStyle(op).color);
  const ok = await lines
    .nth(0)
    .locator(".dt-plan-op")
    .evaluate((op) => getComputedStyle(op).color);
  expect(warn).not.toBe(ok);
});

test("a query opened in the call tree has the DB tab's Query plan", async ({ page }) => {
  await explainable(page);
  await page.goto(`/#/t/${await traceId("PATCH /campaigns/{id}/report")}?tab=tree`);
  await page.locator(".dt-map-row").filter({ hasText: "SELECT campaign_stats_1" }).first().click();
  const details = page.getByRole("complementary", { name: "Details" });

  await expect(details.getByRole("heading", { name: "Query plan" })).toBeVisible();

  await details.getByRole("button", { name: "Explain", exact: true }).click();

  await expect(details.locator(".dt-plan-line")).toHaveCount(3);
});
