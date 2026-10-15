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
  await page.goto("/#/tasks");
  await expect(page.getByRole("main").getByRole("table").getByText("shop.tasks.send_receipt")).toBeVisible();

  await page.getByRole("navigation", { name: "List" }).getByRole("link", { name: "All runs" }).click();

  await expect(page).toHaveURL(/view=calls/);
  await expect(page.getByRole("main").getByRole("table").getByText("shop.tasks.send_receipt").first()).toBeVisible();
});

test("a job opens its own page", async ({ page }) => {
  await page.goto("/#/jobs");
  await page
    .getByRole("main")
    .getByRole("table")
    .getByRole("link", { name: /manage\.py rebuild_index/ })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: /manage\.py rebuild_index/ })).toBeVisible();
});

test("HTTP's every call lists the requests themselves", async ({ page }) => {
  await page.goto("/#/endpoints?view=calls");

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
