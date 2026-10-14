// The search language as the console writes it: filters, quoted values, and what a bad term says.
import { expect, test } from "../fixtures.ts";

test("has:n+1 lists the traces with an N+1 and none without", async ({ page }) => {
  await page.goto(`/#/traces?q=${encodeURIComponent("has:n+1")}`);
  const rows = page.getByRole("main").getByRole("table").getByRole("link");

  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasText: "/api/posts" })).not.toHaveCount(0);
  await expect(rows.filter({ hasText: "/books/fixed" })).toHaveCount(0);
});

test("an action named after a button finds its calls: quotes inside a quoted value", async ({ page }) => {
  await page.goto(`/#/group/pages/${encodeURIComponent('/books › click "Save"')}`);

  await expect(page.getByRole("region", { name: "Summary" })).toContainText("Calls1");
});

test("a term the search doesn't know says so, and the page stays", async ({ page }) => {
  await page.goto("/#/endpoints");
  await page.getByRole("searchbox", { name: "Search" }).fill("colour:red");
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");

  await expect(page.getByText(/colour/).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "HTTP" })).toBeVisible();
});
