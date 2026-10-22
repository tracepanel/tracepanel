// The other lists: logs by level, statements by text, tasks and jobs by name and every run.
import { expect, test } from "../fixtures.ts";

test("Logs narrow to a level", async ({ page }) => {
  await page.goto(`/#/logs?q=${encodeURIComponent("level:warning")}`);
  const rows = page.getByRole("region", { name: "Logs" }).getByRole("rowgroup").last().getByRole("row");

  await expect(rows.first()).toContainText("report scanned 2000000 rows");
  for (const row of await rows.all()) await expect(row.getByRole("cell").nth(1)).toHaveText(/warning|error|critical/);
});

test("Database lists the statements, the slowest first, and finds one by its text", async ({ page }) => {
  await page.goto("/#/calls/sql");
  const region = page.getByRole("region", { name: "Database" });

  await expect(region.getByRole("region", { name: "Summary" })).toContainText("Calls");
  await expect(region.getByRole("rowgroup").last().getByRole("row").first()).toContainText("WITH c");

  // Only the FastAPI app's author lookup selects author.name; the free text reads the whole statement.
  await page.getByRole("searchbox", { name: "Search" }).fill("author.name");
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");

  await expect(region.getByRole("rowgroup").last().getByRole("row")).toHaveCount(1);
  await expect(region.getByRole("rowgroup").last().getByRole("row").first()).toContainText("SELECT author");
});

test("Tasks lists a task, then every run of it", async ({ page }) => {
  await page.goto("/#/tasks?view=overview");
  await expect(page.getByRole("main").getByRole("table").getByText("shop.tasks.send_receipt")).toBeVisible();

  await page.getByRole("navigation", { name: "List" }).getByRole("link", { name: "All runs" }).click();

  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.getByRole("main").getByRole("table").getByText("shop.tasks.send_receipt").first()).toBeVisible();
});

test("a job opens its own page", async ({ page }) => {
  await page.goto("/#/jobs?view=overview");
  await page
    .getByRole("main")
    .getByRole("table")
    .getByRole("link", { name: /manage\.py rebuild_index/ })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: /manage\.py rebuild_index/ })).toBeVisible();
});

test("HTTP's every call lists the requests themselves", async ({ page }) => {
  await page.goto("/#/endpoints");

  await expect(page.getByRole("main").getByRole("table").getByRole("link").first()).toBeVisible();
  await expect(page.getByRole("main").getByRole("table").getByText("/api/posts").first()).toBeVisible();
});

test("an issue's page names the endpoint it was found in", async ({ page }) => {
  await page.goto("/#/issues");
  await page
    .getByRole("region", { name: "Issues" })
    .getByRole("link", { name: /^N\+1: 13 similar queries/ })
    .click();

  await expect(page.getByRole("main")).toContainText("GET /api/posts");
});

test("a query has no Explain where the console's backend can't run it: the agent alone", async ({ page }) => {
  await page.goto("/#/calls/sql");
  const region = page.getByRole("region", { name: "Database" });
  await region.getByRole("rowgroup").last().getByRole("row").first().click();

  await expect(region.getByText("WITH c").nth(1)).toBeVisible();
  await expect(region.getByRole("button", { name: /^Explain/ })).toHaveCount(0);
});

test("Tasks' System menu offers what ran this project's tasks, nothing it doesn't have", async ({ page }) => {
  await page.goto("/#/tasks?view=overview");
  await page.getByRole("button", { name: "System", exact: true }).click();

  await expect(page.getByRole("option")).toHaveText(["Celery", "Channels", "RabbitMQ", "RQ"]);
});

test("A finding's compact badge leaves its row as tall as the row without it", async ({ page }) => {
  await page.goto("/#/traces");
  const badges = page.getByRole("main").locator('tbody tr [data-slot="badge"][data-size="compact"]');
  await expect(badges.first()).toBeVisible();
  // Each row with a badge, as tall as it is with its badges and without them.
  const rows = await badges.evaluateAll((all) => {
    const tall = [...new Set(all.map((badge) => badge.closest("tr") as HTMLElement))];
    const height = (row: HTMLElement) => row.getBoundingClientRect().height;
    const withBadges = tall.map(height);
    const badge = all[0]?.getBoundingClientRect().height;
    for (const each of all) (each as HTMLElement).style.display = "none";
    return { withBadges, without: tall.map(height), badge };
  });
  const rem = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));

  expect(rows.withBadges.length).toBeGreaterThan(5);
  expect(rows.withBadges).toEqual(rows.without);
  expect(rows.badge).toBe(1.125 * rem);
});
