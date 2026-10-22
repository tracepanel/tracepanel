// The GraphQL page's By operation table: each operation's type whole in its pill, at any width, and a document that
// didn't parse (no operation, no type) named as the SDK names it, with no type. The seed has no GraphQL traffic: the
// table's rows are answered here, as the agent answers them.
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

// biome-ignore-start lint/style/useNamingConvention: a row as the agent answers it; its field names are the wire format.
function row(type: string | null, name: string | null, operation: string) {
  return {
    operation,
    type,
    name,
    calls: 1,
    errors: 0,
    p50: 1000,
    p95: 2000,
    total: 2000,
    avg_queries: 0,
    with_issues: 0,
    last_seen: 0,
  };
}
// biome-ignore-end lint/style/useNamingConvention: a row as the agent answers it; its field names are the wire format.

async function operations(page: Page) {
  await page.route("**/api/counts*", async (route) => {
    const counts = await (await route.fetch()).json();
    await route.fulfill({ json: { ...counts, sections: { ...counts.sections, graphql: 5 } } });
  });
  await page.route(/\/api\/graphql(\?|$)/, (route) =>
    route.fulfill({
      json: {
        graphql: [
          row("query", "PostList", "query PostList"),
          row("mutation", "CreatePost", "mutation CreatePost"),
          row("subscription", "OnComment", "subscription OnComment"),
          row("query", null, "query anonymous"),
          row(null, null, "syntax error"),
        ],
      },
    }),
  );
}

for (const width of [1440, 1000]) {
  test(`every operation type is whole in its pill, ${width}px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await operations(page);

    await page.goto("/#/graphql?view=overview");
    const table = page.getByRole("main").getByRole("table");
    const types = table.locator("tbody tr td:first-child");

    await expect(types).toHaveText(["query", "mutation", "subscription", "query", ""]);
    // Not cut: the cell (it truncates) and the pill show all of their text.
    for (const cell of await types.all()) {
      const [own, pill] = await cell.evaluate((td) => {
        const badge = td.querySelector("[data-slot=badge]");
        return [td.scrollWidth <= td.clientWidth, !badge || badge.scrollWidth <= badge.clientWidth];
      });

      expect([own, pill]).toEqual([true, true]);
    }
  });
}

test("a document that didn't parse is no query: no type, and named as the SDK names it", async ({ page }) => {
  await operations(page);

  await page.goto("/#/graphql?view=overview");
  const rows = page.getByRole("main").getByRole("table").locator("tbody tr");

  await expect(rows.nth(3).locator("td").nth(1)).toHaveText("anonymous");
  await expect(rows.nth(4).locator("td").nth(1)).toHaveText("syntax error");
  await expect(rows.nth(4).locator("[data-slot=badge]")).toHaveCount(0);
});
