// A page's view and what was done on it, as the browser recording sends them: one row each, the failure counted.
import { expect, test } from "../fixtures.ts";

test("a page lists its view, then its actions, a failed one counted", async ({ page }) => {
  await page.goto("/#/pages?view=overview");
  // The seed's page, /books: other tests store views of pages of their own (/app/), hours ago but in this period.
  const rows = page.getByRole("main").getByRole("table").last().getByRole("link").filter({ hasText: "/books" });

  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("view");
  await expect(rows.filter({ hasText: '"Delete"' })).toContainText("1");
  await expect(rows.filter({ hasText: '"Save"' })).toContainText("CLICK");
});

test("an action's trace is headed by what was done, on which page", async ({ page }) => {
  await page.goto(`/#/group/pages/${encodeURIComponent('/books › click "Save"')}`);
  await page.getByRole("table").last().getByRole("link").first().click();

  await expect(page.getByRole("heading", { level: 2, name: '"Save" · /books' })).toBeVisible();
  await page.getByRole("tab", { name: /^Call tree/ }).click();

  await expect(page.getByRole("button", { name: /GET 127\.0\.0\.1\/api\/books/ }).first()).toBeVisible();
});
