// ⌘K: go to a section, open a trace by its id, find one by its path.
import { expect, test } from "../fixtures.ts";

test("⌘K goes to a section", async ({ page }) => {
  await page.goto("/#/endpoints");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search traces" });

  await expect(palette.getByRole("option", { name: "Errors" })).toBeVisible();

  await palette.getByRole("combobox").fill("Errors");
  await palette.getByRole("combobox").press("Enter");

  await expect(page.getByRole("heading", { level: 1, name: "Errors" })).toBeVisible();
});

test("⌘K opens a trace by its id, and finds one by its path", async ({ page }) => {
  await page.goto("/#/endpoints?view=overview");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^GET \/api\/report / })
    .first()
    .click();
  await page.getByRole("table").last().getByRole("link").first().click();
  const id = new URL(page.url()).hash.match(/#\/t\/([0-9A-Z]{26})/)?.[1] ?? "";

  expect(id).toHaveLength(26);

  await page.goto("/#/endpoints");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Search traces" }).getByRole("combobox").fill(id);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`#/t/${id}`));
  await expect(page.getByRole("heading", { level: 2, name: "/api/report" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Search traces" }).getByRole("combobox").fill("/api/report");

  await expect(page.getByRole("option", { name: /\/api\/report/ }).first()).toBeVisible();
});

test("/ puts the cursor in a list's search", async ({ page }) => {
  await page.goto("/#/logs");
  await page.getByRole("heading", { level: 1, name: "Logs" }).click();
  await page.keyboard.press("/");

  await expect(page.getByRole("searchbox", { name: "Search" })).toBeFocused();
});

test("a Go to list longer than the palette fades at its foot, never a hard cut", async ({ page }) => {
  await page.goto("/#/endpoints");
  await page.keyboard.press("ControlOrMeta+k");
  const list = page.getByRole("dialog").locator("[cmdk-list]");
  await expect(list).toBeVisible();

  await expect
    .poll(() => list.evaluate((element) => getComputedStyle(element.parentElement as HTMLElement).maskImage))
    .toContain("linear-gradient");
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
});
