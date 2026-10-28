// A trace's Logs tab lists its whole chain of calls: a browser's view calls a GraphQL BFF, whose three Book.author
// steps each call a service. Each app's records, on the view's clock, with its app; a row of the call tree opens
// what is under it ("Under this"), the scope's chip lets it go, and what the records add up to filters them.
import type { Page } from "@playwright/test";
import { chain } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

const logsTab = (page: Page) => page.getByRole("tab", { name: /^Logs/ });
const records = (page: Page) => page.locator("[data-record]");

test("the Logs tab lists the whole chain, each record with its app, and an app's chip narrows it", async ({ page }) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=logs`);

  await expect(logsTab(page)).toContainText("8");
  await expect(records(page)).toHaveCount(8);
  await expect(records(page).first()).toContainText("view loading");
  await expect(records(page).first()).toContainText("shop-web");
  await expect(records(page).nth(1)).toContainText("query Books");
  await expect(records(page).last()).toContainText("slow query");

  const scope = page.getByRole("list", { name: "Scope" });
  await scope.getByRole("button", { name: /^shop 7$/ }).click();

  await expect(records(page)).toHaveCount(7);
  await expect(page.getByText("7 of 8 records")).toBeVisible();
  await expect(records(page).filter({ hasText: "shop-web" })).toHaveCount(0);
});

test("Under this: a group of steps opens the records under it, its services' too; only its own on the chip's menu", async ({
  page,
}) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=calls`);
  await page
    .getByRole("button", { name: /^function Book\.author/i })
    .first()
    .click();

  const under = page.locator(".dt-under-this");
  await expect(under).toContainText("4 logs");
  await under.getByRole("button", { name: "4 logs" }).click();

  await expect(logsTab(page)).toHaveAttribute("aria-selected", "true");
  const chip = page.locator(".dt-scope-chip");
  await expect(chip).toContainText("Under Book.author ×3");
  await expect(records(page)).toHaveCount(4);
  await expect(records(page).filter({ hasText: "author 2 asked" })).toHaveCount(1);
  await expect(records(page).filter({ hasText: "app.db" })).toHaveCount(3);
  await expect(records(page).filter({ hasText: "author 2 asked" })).toHaveCount(1);

  await chip.getByRole("button", { name: /Under Book\.author/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Only this span" }).click();
  await page.keyboard.press("Escape");

  await expect(chip).toContainText("In Book.author ×3");
  await expect(records(page)).toHaveCount(1);
  await expect(records(page).first()).toContainText("author 2 asked");

  await chip.getByRole("button", { name: "Back to the whole chain" }).click();

  await expect(chip).toHaveCount(0);
  await expect(records(page)).toHaveCount(8);
});

test("a service's trace in the tree: under it, its own records; a record leads back to its row", async ({ page }) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=calls`);
  const step = page.getByRole("button", { name: /^function Book\.author/i }).first();
  await step.locator(".dt-map-caret[data-toggle]").click();
  await page.getByRole("button", { name: /^app GET \/authors\/2\b/ }).click();
  await page.locator(".dt-under-this").getByRole("button", { name: "1 log" }).click();

  await expect(page.locator(".dt-scope-chip")).toContainText("Under shop");
  await expect(records(page)).toHaveCount(1);
  await expect(records(page).first()).toContainText("no author 2");

  await records(page).first().getByRole("button", { name: "In the call tree" }).click();

  await expect(page.getByRole("tab", { name: /^Call tree/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("complementary", { name: "Details" })).toContainText("SELECT author");
});

test("what the records add up to: by level and logger, the first error, each a filter", async ({ page }) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=logs`);
  const sums = page.getByRole("list", { name: "What the records add up to" });

  await expect(sums.getByRole("button", { name: /^error 1$/i })).toBeVisible();
  await expect(sums.getByRole("button", { name: /^info 5$/i })).toBeVisible();
  await expect(sums.getByRole("button", { name: /^warning 1$/i })).toBeVisible();
  await expect(sums.getByRole("button", { name: /^debug 1$/i })).toBeVisible();
  await expect(sums.getByRole("img", { name: "Records over the time, by level" })).toBeVisible();

  await sums.getByRole("button", { name: /^error 1$/i }).click();
  await expect(records(page)).toHaveCount(1);
  await sums.getByRole("button", { name: /^error 1$/i }).click();
  await sums.getByRole("button", { name: /^yoga 2$/ }).click();
  await expect(records(page)).toHaveCount(2);
  await sums.getByRole("button", { name: /^yoga 2$/ }).click();

  await sums.getByRole("button", { name: /First error/ }).click();
  await expect(records(page)).toHaveCount(8);
  await expect(page.locator('[data-record][aria-expanded="true"]')).toContainText("no author 2");
});
