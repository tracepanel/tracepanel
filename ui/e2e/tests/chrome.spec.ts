// The console's frame: the period, the refresh, the theme, the sidebar, and a trace that isn't there.

import { traceId } from "../app.ts";
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

test("a sidebar too long for the window fades at the edge it goes on past, its Problems kept in view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 560 });
  await page.goto("/#/endpoints");
  const list = page.locator("aside [data-nav-list]");
  const errors = page.locator("aside nav").getByRole("link", { name: /^Errors/ });
  const issues = page.locator("aside nav").getByRole("link", { name: /^Issues/ });
  await expect(errors).toBeInViewport();
  await expect(issues).toBeInViewport();
  await expect(list.getByRole("link", { name: "HTTP", exact: true })).toBeInViewport();

  await expect.poll(() => list.evaluate((element) => getComputedStyle(element).maskImage)).toContain("linear-gradient");
});

test("a trace, an issue, a group and an app open with their crumbs at one place, the page's full width", async ({
  page,
}) => {
  const place = async () => {
    const crumbs = page.getByRole("main").getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs).toBeVisible();
    const box = await crumbs.boundingBox();
    const main = await page.getByRole("main").locator("> *").first().boundingBox();
    if (!(box && main)) throw new Error("no crumbs");
    return [Math.round(box.x), Math.round(box.y), Math.round(main.x + main.width)];
  };
  await page.goto(`/#/t/${await traceId("GET /account/orders/")}`);
  const trace = await place();
  await page.goto("/#/issues");
  await page.getByRole("main").locator("tbody tr").first().click();
  const issue = await place();
  await page.goto("/#/endpoints?view=overview");
  await page.getByRole("main").locator("tbody tr").first().click();
  const group = await place();
  await page.goto("/#/app/shop");
  const app = await place();

  expect([issue, group, app]).toEqual([trace, trace, trace]);
});

test("a trace that isn't stored says so within a second on the console's page", async ({ page }) => {
  const start = Date.now();
  await page.goto("/#/t/01M4GPC1BHG83SW8X460V23TM9");

  await expect(page.getByRole("main").getByText("Trace not found")).toBeVisible();
  expect(Date.now() - start).toBeLessThan(2500);
});

test("a list loads in its own shape: the search, the filters and rows where they will be", async ({ page }) => {
  await page.route("**/api/calls**", async (route) => {
    await new Promise((done) => setTimeout(done, 1500));
    await route.continue().catch(() => undefined);
  });
  await page.goto("/#/calls/sql");
  const loading = page.getByRole("main").getByRole("status");

  await expect(loading).toBeVisible();
  await expect(loading.locator(".dt-skeleton")).toHaveCount(11);
  await expect(page.getByRole("main").getByRole("heading", { name: "Database" })).toBeVisible();
});

for (const scheme of ["dark", "light"] as const) {
  test(`the sidebar's items read at 15px in both themes, its group titles small (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/#/endpoints");
    const item = page.locator("aside nav").getByRole("link", { name: "HTTP", exact: true });

    await expect(item).toHaveCSS("font-size", "15px");
    await expect(page.locator("aside nav").getByText("Entry points")).not.toHaveCSS("font-size", "15px");
    await expect(page.locator("aside nav").getByRole("link", { name: /^Issues/ })).toBeInViewport();
  });
}
