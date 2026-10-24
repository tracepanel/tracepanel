// A profile with the trace's memory and the collector's pauses: the header says its peak and the pauses in one line,
// the Profile tab has a Memory view (its peak, what it kept, where the memory was by package, as a flame of bytes and
// as a list of sites, and what the numbers can't tell apart), the time strip has a GC share. A profile without them
// shows none of it.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { DIGEST } from "../seed.ts";

const SALES = "GET /reports/sales";

test("the header says the memory's peak and the collector's pauses, only where the profile has them", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(SALES)}`);

  await expect(page.locator(".dt-trace-facts")).toHaveText("· ↑ 42 MB peak · GC 3× 12 ms");

  await page.goto(`/#/t/${await traceId(DIGEST)}`);

  await expect(page.locator(".dt-trace-title")).not.toContainText("peak");
  await expect(page.locator(".dt-trace-title")).not.toContainText("GC");
});

test("the Memory view: its peak, what it kept, where the memory was, and what it can't tell apart", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(SALES)}?tab=profile`);
  const kinds = page.getByRole("tablist", { name: "Profile of" });

  await expect(kinds.getByRole("tab")).toHaveText(["Time", "Memory"]);
  await expect(kinds.getByRole("tab", { name: "Time" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Time by package" })).toBeVisible();

  await kinds.getByRole("tab", { name: "Memory" }).click();

  await expect(page.getByText("Memory of the whole trace")).toBeVisible();
  await expect(page.getByText("peak, above where it started")).toBeVisible();
  await expect(page.getByText("net +1.2 MB · 90 MB allocated in all")).toBeVisible();
  await expect(page.getByText("Where it was at the end of the trace, not its peak")).toBeVisible();
  await expect(page.getByText("Includes other traces that ran in the process meanwhile")).toBeVisible();

  await expect(page.getByRole("region", { name: "Memory by package" }).getByRole("button")).toHaveText([
    /^django\.db\s*30 MB\s*71%$/,
    /^django\.template\s*8\.0 MB\s*19%$/,
    /^your code\s*4\.0 MB\s*10%$/,
  ]);

  const sites = page.getByRole("region", { name: "Allocation sites" }).getByRole("listitem");

  await expect(sites).toHaveCount(3);
  await expect(sites.nth(0)).toContainText("SQLCompiler.execute_sql");
  await expect(sites.nth(0)).toContainText("reports/queries.py:42");
  await expect(sites.nth(0)).toContainText("30 MB");
  await expect(sites.nth(0)).toContainText("71%");
  await expect(sites.nth(2)).toContainText("sales");
  await expect(sites.nth(2)).toContainText("reports/views.py:18");

  await page.getByRole("button", { name: "totals reports/queries.py:42" }).hover();

  await expect(page.getByRole("tooltip")).toContainText("30 MB · 71% · 0 B in itself");
});

test("the strip has the collector's pauses as their own share, and a click on one picks nothing", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(SALES)}?tab=tree`);
  const legend = page.getByRole("list", { name: /^Where the time went/ });
  const pauses = page.locator('.dt-time-track .dt-stretch[data-category="gc"]');

  await expect(pauses).toHaveCount(3);
  await expect(legend.locator('li[data-category="gc"]')).toHaveText(/^GC\s*12 ms\s*29%$/);
  await expect(legend.getByRole("button", { name: /^Your code/ })).toHaveText(/^Your code\s*30 ms\s*71%$/);

  await legend.locator('li[data-category="gc"] .dt-share').hover();

  await expect(page.getByRole("tooltip", { name: /^GC/ })).toContainText("12 ms · 29% · 3 collections");

  const rows = await page.locator(".dt-map-row").count();
  await pauses.last().click();

  await expect(page.locator(".dt-map-row")).toHaveCount(rows);
  await expect(legend.getByRole("button", { name: /^Your code/ })).toHaveAttribute("aria-pressed", "false");
});

test("a profile without memory has no Memory view", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=profile`);

  await expect(page.getByRole("region", { name: "Time by package" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Profile of" })).toHaveCount(0);
});

test("a profile without collections has no GC share", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=tree`);

  await expect(page.getByRole("list", { name: /^Where the time went/ })).toBeVisible();
  await expect(page.locator('[data-category="gc"]')).toHaveCount(0);
});
