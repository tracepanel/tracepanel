// EXPLAIN runs in the app that recorded the query: a linked trace's SELECT, opened in the call tree of the trace that
// called it, has the plan its own app gives (the agent asks that app for that trace's span), as the DB tab has it;
// none where that app doesn't run EXPLAIN, whatever the calling trace's app does.
import type { Page, Request } from "@playwright/test";
import { chain, chainTrace } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

/** Each app runs EXPLAIN or not, by its service (`?service=`); the plan the agent's /explain answers. */
async function explaining(page: Page, explains: Record<string, boolean>): Promise<Request[]> {
  await page.route("**/api/capabilities*", (route) => {
    const service = new URL(route.request().url()).searchParams.get("service") ?? "";
    const json = {
      explain: explains[service] === true,
      users: false,
      profile: false,
      request: false,
      // biome-ignore lint/style/useNamingConvention: wire format.
      live_tasks: false,
    };
    return route.fulfill({ json });
  });
  const asked: Request[] = [];
  await page.route("**/api/explain?*", (route) => {
    asked.push(route.request());
    return route.fulfill({
      json: {
        vendor: "postgresql",
        alias: "default",
        analyzed: false,
        lines: [
          { depth: 0, text: "Index Scan using author_pkey on author  (cost=0.15..8.17 rows=1 width=4)", warning: null },
        ],
      },
    });
  });
  return asked;
}

/** The view's call tree, the authors' steps open: the second one's service trace's query, its details. */
async function linkedQuery(page: Page) {
  await page.goto(`/#/t/${await chain()}?tab=calls`);
  const step = page.getByRole("button", { name: /^function Book\.author/i }).first();
  await step.locator(".dt-map-caret[data-toggle]").click();
  // Each call's trace open under it: the second author's query is the second.
  const queries = page.getByRole("button", { name: /^sql SELECT author/i });
  await expect(queries).toHaveCount(3);
  await queries.nth(1).click();
  const details = page.getByRole("complementary", { name: "Details" });
  await expect(details).toContainText("SELECT author");
  return details;
}

test("a linked trace's SELECT in the call tree is explained by its own app, as in the DB tab", async ({ page }) => {
  // The view's app (the browser's) runs none; the service's does.
  const asked = await explaining(page, { "shop-web": false, shop: true });
  const details = await linkedQuery(page);

  await details.getByRole("button", { name: "Explain", exact: true }).click();

  await expect(details.locator(".dt-plan-line")).toHaveCount(1);
  // That trace's span, asked of the agent: it asks the app that recorded the trace.
  const url = new URL((asked.at(-1) as Request).url());
  expect(Object.fromEntries(url.searchParams)).toEqual({ trace: chainTrace("api2"), span: "q1" });

  // The DB tab, the same query: the same plan.
  await page.getByRole("tab", { name: /^DB/ }).click();
  await page.getByText("SELECT author").first().click();

  await expect(page.getByRole("button", { name: "Explain", exact: true })).toBeVisible();
});

test("a linked trace's SELECT has no plan where its app doesn't run EXPLAIN, though the calling trace's does", async ({
  page,
}) => {
  await explaining(page, { "shop-web": true, shop: false, "": true });
  const details = await linkedQuery(page);

  await expect(details.getByRole("heading", { name: "Query plan" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Explain", exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: /^DB/ }).click();
  await page.getByText("SELECT author").first().click();

  await expect(page.getByRole("button", { name: "Explain", exact: true })).toHaveCount(0);
});
