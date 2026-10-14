// Logs: what wrote each record (a request, a task, a job), filtering by it, and the search box as people type in it.
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

const rows = (page: Page) => page.getByRole("region", { name: "Logs" }).getByRole("rowgroup").last().getByRole("row");
const search = (page: Page) => page.getByRole("searchbox", { name: "Search" });

test("Enter takes the filter as typed, a suggestion only when one is picked", async ({ page }) => {
  await page.goto("/#/logs");
  await search(page).fill("logger:blog.views");
  await search(page).press("Enter");

  await expect(page).toHaveURL(/q=logger%3Ablog\.views$/);
  await expect(page.getByRole("button", { name: "Edit logger:blog.views" })).toBeVisible();
  for (const row of await rows(page).all()) await expect(row).toContainText("blog.views");
});

test("the start of several loggers suggests all of them, with a wildcard", async ({ page }) => {
  await page.goto("/#/logs");
  await search(page).fill("logger:blog");
  const suggestion = page.getByRole("button", { name: /^logger:blog\* all 2$/ });

  await expect(suggestion).toBeVisible();
  await search(page).press("ArrowDown");
  await search(page).press("Enter");

  await expect(page.getByRole("button", { name: "Edit logger:blog*" })).toBeVisible();
  await expect(rows(page)).toHaveCount(7);
});

test("a chip goes back into the box to be changed", async ({ page }) => {
  await page.goto(`/#/logs?q=${encodeURIComponent("level:info service:shop")}`);
  await page.getByRole("button", { name: "Edit level:info" }).click();

  await expect(search(page)).toHaveValue("level:info");
  await expect(search(page)).toBeFocused();
  await expect(page.getByRole("button", { name: "Edit service:shop" })).toBeVisible();

  await search(page).fill("level:warning");
  await search(page).press("Enter");

  await expect(page.getByRole("button", { name: "Edit level:warning" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit service:shop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit level:info" })).toHaveCount(0);
});

test("a task's records: the Task filter finds them, and the record says it was a task", async ({ page }) => {
  await page.goto("/#/logs");
  await page.getByRole("button", { name: "Task" }).click();
  await page.getByRole("option", { name: "shop.tasks.send_receipt" }).click();
  await page.keyboard.press("Escape");

  await expect(page).toHaveURL(/q=task%3Ashop\.tasks\.send_receipt/);
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();

  const details = page.getByRole("region", { name: "Logs" });
  await expect(details.getByRole("button", { name: "this task" })).toBeVisible();
  await expect(details.getByRole("button", { name: "every run of shop.tasks.send_receipt" })).toBeVisible();
  await expect(details.getByRole("link", { name: "Open task" })).toBeVisible();
});

test("a job's records are found by its name", async ({ page }) => {
  await page.goto(`/#/logs?q=${encodeURIComponent('job:"manage.py rebuild_index"')}`);

  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("index rebuilt: 120 books");
});

test("the Logger menu finds loggers with the key typed in its box too", async ({ page }) => {
  await page.goto("/#/logs");
  await page.getByRole("button", { name: "Logger" }).click();
  await page.getByPlaceholder("Filter logger…").fill("logger:blog");

  await expect(page.getByRole("option")).toHaveCount(2);
});
