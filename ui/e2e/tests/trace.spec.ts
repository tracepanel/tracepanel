// From an entry point to the query at fault: an endpoint, its calls, one call's trace, the repeated query in it.
import { expect, test } from "../fixtures.ts";

test("an endpoint's N+1 shows in its trace, down to the repeated query", async ({ page }) => {
  await page.goto("/#/endpoints?view=overview");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^GET \/api\/posts / })
    .first()
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "GET /api/posts" })).toBeVisible();

  await page.getByRole("table").last().getByRole("link").first().click();

  await expect(page.getByRole("heading", { level: 2, name: "/api/posts" })).toBeVisible();
  // Opened from its endpoint's page: on what it was, its Request tab; the query is in its call tree.
  await expect(page.getByRole("tab", { name: /^Request/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Call tree" }).click();
  const repeated = page.getByRole("button", { name: /SELECT author .*×13 N\+1/ });
  await expect(repeated).toBeVisible();

  await page.getByRole("tab", { name: /^Issues/ }).click();

  await expect(page.getByRole("tabpanel").getByText(/N\+1/).first()).toBeVisible();

  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "GET /api/posts" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "GET /api/posts" })).toBeVisible();
});

test("Show N queries on an issue scrolls to the group it opened", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 360 });
  await page.goto("/#/endpoints?view=overview");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^GET \/api\/posts / })
    .first()
    .click();
  await page.getByRole("table").last().getByRole("link").first().click();
  await page.getByRole("tab", { name: /^Issues/ }).click();

  await page
    .getByRole("button", { name: /^Show \d+ queries/ })
    .first()
    .click();

  await expect(page.getByRole("tabpanel").locator("li[data-focused]").first()).toBeInViewport();
});

test("an error leads to its endpoint, and its call's trace opens on the stack", async ({ page }) => {
  await page.goto("/#/errors");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^RuntimeError/ })
    .click();
  await page
    .getByRole("main")
    .getByRole("link", { name: /GET \/api\/error/ })
    .first()
    .click();

  await expect(page.getByRole("heading", { level: 2, name: "Errors · in 1 of 1 calls" })).toBeVisible();

  await page.getByRole("table").last().getByRole("link").first().click();

  await expect(page.getByRole("tab", { name: /^Error/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("something broke in the view").first()).toBeVisible();
  await expect(page.getByText("app/main.py").first()).toBeVisible();
});
