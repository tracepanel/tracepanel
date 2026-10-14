// The console's frame: the period, the refresh, the theme, the sidebar, and a trace that isn't there.
import { expect, test } from "../fixtures.ts";

test("the period goes into the search, and the list keeps it", async ({ page }) => {
  await page.goto("/#/endpoints");
  await page.getByRole("button", { name: "Time" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Last 15 minutes" }).click();

  await expect(page).toHaveURL(/since(%3A|:)15m/);
  await expect(page.getByRole("heading", { level: 1, name: "HTTP" })).toBeVisible();
});

test("the refresh menu offers its intervals, 15 seconds by default", async ({ page }) => {
  await page.goto("/#/endpoints");
  const refresh = page.getByRole("button", { name: "Every 15s" });

  await expect(refresh).toBeVisible();

  await refresh.click();

  await expect(
    page.getByRole("menuitemradio", { name: "Off" }).or(page.getByRole("menuitem", { name: "Off" })),
  ).toBeVisible();
});

test("the theme switches, and stays after a reload", async ({ page }) => {
  await page.goto("/#/endpoints");
  const theme = () => page.evaluate(() => document.documentElement.dataset["theme"] ?? "");
  const toggle = page.getByRole("button", { name: /^Theme: / });
  const label = await toggle.getAttribute("aria-label");
  await toggle.click();

  await expect(toggle).not.toHaveAttribute("aria-label", label ?? "");

  const chosen = await toggle.getAttribute("aria-label");
  const applied = await theme();
  await page.reload();

  await expect(page.getByRole("button", { name: /^Theme: / })).toHaveAttribute("aria-label", chosen ?? "");
  expect(await theme()).toBe(applied);
});

test("a trace that isn't stored says so", async ({ page }) => {
  await page.goto("/#/t/01ZZZZZZZZZZZZZZZZZZZZZZZZ");

  await expect(page.getByRole("main")).toContainText(/not found|no trace|isn't/i);
});
