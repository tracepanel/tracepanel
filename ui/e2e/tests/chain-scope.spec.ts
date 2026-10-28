// A trace's DB, HTTP calls and Issues tabs list its whole chain of calls: the service's query, once per call of the
// BFF's Book.author steps, adds up as one statement ×3 in 3 traces, and as one N+1 across apps on the BFF's calls.
// A row of the call tree opens what is under it in each.
import type { Page } from "@playwright/test";
import { chain } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

const sums = (page: Page) => page.getByRole("list", { name: "What the calls add up to" });
const chip = (page: Page) => page.locator(".dt-scope-chip");

test("the DB tab adds up the chain's queries: the service's, one per call, as one statement", async ({ page }) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=sql`);

  await expect(page.getByRole("tab", { name: /^DB/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /^DB/ })).toContainText("3");
  await expect(sums(page)).toContainText("3 queries");
  await expect(sums(page)).toContainText("on the clock");
  await expect(page.getByText(/SELECT author\s*×3/)).toBeVisible();
  await expect(page.getByText("3 queries · 1 unique")).toBeVisible();
});

test("Under this: a group of steps opens its services' queries; only its own on the chip's menu", async ({ page }) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=calls`);
  await page
    .getByRole("button", { name: /^function Book\.author/i })
    .first()
    .click();
  const under = page.locator(".dt-under-this");

  await expect(under).toContainText("3 queries");
  await expect(under).toContainText("3 HTTP calls");
  await under.getByRole("button", { name: "3 queries" }).click();

  await expect(page.getByRole("tab", { name: /^DB/ })).toHaveAttribute("aria-selected", "true");
  await expect(chip(page)).toContainText("Under Book.author ×3");
  await expect(sums(page)).toContainText("3 queries");

  await chip(page)
    .getByRole("button", { name: /Under Book\.author/ })
    .click();
  await page.getByRole("menuitemcheckbox", { name: "Only this span" }).click();
  await page.keyboard.press("Escape");

  await expect(page.getByText("No database queries under this.")).toBeVisible();

  await page.getByRole("tab", { name: /^HTTP calls/ }).click();
  await expect(chip(page)).toContainText("In Book.author ×3");
  await expect(page.getByText("No HTTP calls under this.")).toBeVisible();

  await chip(page).getByRole("button", { name: "Back to the whole chain" }).click();
  await expect(sums(page)).toContainText("4 HTTP calls");
});

test("the Issues tab has the chain's N+1 across apps, on the BFF's calls; it leads to them in the call tree", async ({
  page,
}) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=issues`);
  const issue = page.locator(".dt-issue-card").filter({ hasText: "N+1 across apps" });

  await expect(issue).toContainText("3 similar queries in shop · SELECT author · one per call from each `Book.author`");
  await expect(issue).toContainText("across apps");
  await expect(issue.locator(".dt-app-chip")).toHaveText("shop");
  await expect(issue.getByRole("link", { name: /All occurrences/ })).toHaveCount(0);

  await issue.getByRole("button", { name: "In the call tree" }).click();

  await expect(page.getByRole("tab", { name: /^Call tree/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("complementary", { name: "Details" })).toContainText("http.client");
  // The first of the calls: the one its traceparent carried to the service's first trace.
  await expect(page.getByRole("complementary", { name: "Details" })).toContainText("c000000000000001");
});
