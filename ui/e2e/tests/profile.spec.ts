// A profiled request's Profile tab: where its time went by package, the packages to light (several at once), a flame
// graph whose boxes tell where they are, and the functions with their whole paths.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test.beforeEach(async ({ page }) => {
  await page.goto(`/#/t/${await traceId("GET /reports/sales")}?tab=profile`);
});

test("the time in code, then each package's share", async ({ page }) => {
  const packages = page.getByRole("region", { name: "Time by package" });

  await expect(page.getByText("sampled of the trace's", { exact: false })).toBeVisible();
  await expect(page.getByText("100 samples, one every 1 ms")).toBeVisible();
  await expect(packages.getByRole("button")).toHaveText([
    /^django\.db\s*60%\s*60 ms$/,
    /^django\.template\s*30%\s*30 ms$/,
    /^your code\s*10%\s*10 ms$/,
  ]);
});

test("packages light together, and one click shows every package again", async ({ page }) => {
  const packages = page.getByRole("region", { name: "Time by package" });
  const db = packages.getByRole("button", { name: /^django\.db/ });
  const template = packages.getByRole("button", { name: /^django\.template/ });

  await db.click();
  await template.click();

  await expect(db).toHaveAttribute("aria-pressed", "true");
  await expect(template).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Show every package" }).click();

  await expect(db).toHaveAttribute("aria-pressed", "false");
  await expect(template).toHaveAttribute("aria-pressed", "false");
});

test("a box of the flame graph tells its function, where it is and its time", async ({ page }) => {
  await page.getByRole("button", { name: "totals reports/queries.py:42" }).hover();

  const tip = page.getByRole("tooltip");

  await expect(tip).toContainText("totals");
  await expect(tip).toContainText("reports/queries.py:42");
  await expect(tip).toContainText("60 ms · 60% · 0 µs in itself");
});

test("the functions show where they are, whole", async ({ page }) => {
  const functions = page.getByRole("region", { name: "Functions" });

  await expect(functions).toContainText("django/db/models/sql/compiler.py:1574");
  await expect(functions).toContainText("reports/queries.py:42");
});
