// A profiled request's Profile tab: where its time went, your code's (what its library calls spent counted to it) or
// by package, the packages to light (several at once), a flame graph whose boxes tell where they are, and the
// functions with their whole paths.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test.beforeEach(async ({ page }) => {
  await page.goto(`/#/t/${await traceId("GET /reports/sales")}?tab=profile`);
});

test("the time in code, your code's, then each package's share", async ({ page }) => {
  const packages = page.getByRole("region", { name: "Time by package" });

  await expect(page.getByText("sampled of the trace's", { exact: false })).toBeVisible();
  await expect(page.getByText("100 samples, one every 1 ms")).toBeVisible();
  await expect(packages.getByRole("button")).toHaveText([/^your code\s*100 ms\s*100%$/]);

  await page.getByRole("tab", { name: "All frames" }).click();

  await expect(packages.getByRole("button")).toHaveText([
    /^django\.db\s*60 ms\s*60%$/,
    /^django\.template\s*30 ms\s*30%$/,
    /^your code\s*10 ms\s*10%$/,
  ]);
});

test("packages light together, and one click shows every package again", async ({ page }) => {
  await page.getByRole("tab", { name: "All frames" }).click();
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
  const box = page.getByRole("button", { name: "totals reports/queries.py:42" });
  const tip = page.getByRole("tooltip");

  await box.hover();

  await expect(tip).toContainText("totals");
  await expect(tip).toContainText("reports/queries.py:42");
  // Your code: what the queries it made spent is its own.
  await expect(tip).toContainText("60 ms · 60% · 60 ms in itself");

  await page.getByRole("tab", { name: "All frames" }).click();
  await box.hover();

  await expect(tip).toContainText("60 ms · 60% · 0 µs in itself");
});

test("the functions show where they are, whole", async ({ page }) => {
  await page.getByRole("tab", { name: "All frames" }).click();
  const functions = page.getByRole("region", { name: "Functions" });

  await expect(functions).toContainText("django/db/models/sql/compiler.py:1574");
  await expect(functions).toContainText("reports/queries.py:42");
});

test("a box in the flame graph's bottom row tells it whole: its tip is in the window, no scrolling box cuts it", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "All frames" }).click();
  const flame = page.getByRole("region", { name: "Flame graph" });
  // The bottom row's boxes: those placed lowest.
  const bottom = await flame.getByRole("button").evaluateAll((boxes) => {
    const lowest = Math.max(...boxes.map((box) => box.getBoundingClientRect().top));
    return boxes.findIndex((box) => box.getBoundingClientRect().top === lowest);
  });

  await flame.getByRole("button").nth(bottom).hover();

  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  const cut = await tip.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const inside = (outer: DOMRect) =>
      box.left >= outer.left && box.right <= outer.right && box.top >= outer.top && box.bottom <= outer.bottom;
    const window_ = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const cutBy: string[] = inside(window_) ? [] : ["the window"];
    for (let at = element.parentElement; at && at !== document.body; at = at.parentElement) {
      const style = getComputedStyle(at);
      const clips = [style.overflowX, style.overflowY].some((value) => value !== "visible");
      if (clips && !inside(at.getBoundingClientRect())) cutBy.push(at.className);
    }
    return cutBy;
  });
  expect(cut).toEqual([]);
});
