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

test("at 1440 × 900 the sidebar shows its Problems, its footer on one line where the items' icons start", async ({
  page,
}) => {
  await page.goto("/#/endpoints");
  const nav = page.locator("aside nav").first();
  const issues = nav.getByRole("link", { name: /^Issues/ });
  await expect(issues).toBeVisible();
  const list = await nav.boundingBox();
  const item = await issues.boundingBox();
  const icon = await nav.locator("a svg").first().boundingBox();
  const footer = await page.locator("aside footer span").first().boundingBox();
  if (!(list && item && icon && footer)) throw new Error("no sidebar boxes");

  expect(item.y + item.height).toBeLessThanOrEqual(list.y + list.height);
  expect(footer.height).toBeLessThan(20);
  expect(footer.x).toBeCloseTo(icon.x, 0);
});

test("a sidebar too long for the window fades at the edge it goes on past, and shows the current page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 560 });
  await page.goto("/#/issues");
  const nav = page.locator("aside nav").first();
  const issues = nav.getByRole("link", { name: /^Issues/ });
  await expect(issues).toBeInViewport();

  await expect.poll(() => nav.evaluate((element) => getComputedStyle(element).maskImage)).toContain("linear-gradient");
});
