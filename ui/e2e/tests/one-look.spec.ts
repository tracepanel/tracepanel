// One thing, one look: a request's method, an issue's kind and title, a page's action, a failed call and a job are
// drawn the same wherever they show.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("an error's row names where it happened: an endpoint by its method's badge, a task by its kind's", async ({
  page,
}) => {
  await page.goto("/#/errors");
  const rows = page.getByRole("region", { name: "Errors" }).getByRole("rowgroup").last();
  const task = rows.getByRole("link").filter({ hasText: "ConnectionError" });
  const request = rows.getByRole("link").filter({ hasText: "ZeroDivisionError" });

  await expect(task.locator(".dt-kind")).toHaveText("task");
  // A long task name is cut at its start to fit the column (by the font's widths): its full name is its title.
  await expect(task.locator('[title$="thumbnails_notify"]')).toHaveCount(1);
  await expect(request.locator(".dt-method")).toHaveText("GET");
  await expect(request).toContainText("GET /error/");
});

test("an issue reads its kind in its chip, then its title without it, in the list, on its page and in a trace", async ({
  page,
}) => {
  await page.goto("/#/issues");
  const row = page.getByRole("region", { name: "Issues" }).getByRole("link").filter({ hasText: "13 similar queries" });

  await expect(row.locator('[data-slot="badge"]').first()).toHaveText("N+1");
  await expect(row).not.toContainText("N+1:");

  await row.click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^13 similar queries/);
  await expect(page.getByRole("main").locator(".dt-method").first()).toHaveText("GET");

  await page.goto(`/#/t/${await traceId("GET /api/posts")}?tab=issues`);
  const title = page.locator(".dt-issue-title").first();

  await expect(title.locator('[data-slot="badge"]')).toHaveText("N+1");
  await expect(title).toHaveText(/^N\+1\s*13 similar queries/);
});

test("a page's action reads in the list as in its header, and its failure shows in Status", async ({ page }) => {
  await page.goto("/#/pages");
  const row = page.getByRole("region", { name: "Pages" }).getByRole("link").filter({ hasText: '"Delete"' });

  await expect(row.locator(".dt-method")).toHaveText("CLICK");
  await expect(row).toContainText('"Delete" · /books');
  await expect(row.locator(".dt-status")).toHaveText("failed");
});

test("a failed HTTP call has a failed row's red edge and its method's badge", async ({ page }) => {
  await page.goto(`/#/t/${await traceId('/books › click "Delete"')}?tab=http`);
  const call = page.locator("li[data-tone]").filter({ hasText: "127.0.0.1/api/books" });

  await expect(call).toHaveAttribute("data-tone", "error");
  await expect(call.locator(".dt-method")).toHaveText("GET");
});

test("a job's first tab is named as its badge and the sidebar name it: Job", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("manage.py rebuild_index")}`);

  await expect(page.getByRole("tablist").first().getByRole("tab").first()).toHaveText(/^Job/);
});

test("Issues' filters start with Time, as every page's do", async ({ page }) => {
  await page.goto("/#/issues");

  await expect(page.getByRole("group", { name: "Filters" }).getByRole("button").first()).toHaveText(/^(Time|Last)/);
});

test("a page refreshed on demand has the refresh button every page has, without a word of its own", async ({
  page,
}) => {
  await page.goto("/#/services");
  const refresh = page.getByRole("button", { name: "Refresh now" });

  await expect(refresh).toBeVisible();
  await expect(refresh).toHaveText("");
});

test("an issue that isn't stored says so as an empty section does: an icon, a title, the way back as a button", async ({
  page,
}) => {
  await page.goto("/#/issue/0000000000000000");
  const empty = page.getByRole("main").locator(".dt-empty");

  await expect(empty.locator(".dt-empty-icon")).toBeVisible();
  await expect(empty.locator(".dt-empty-title")).toHaveText("Issue not found");
  await expect(empty.getByRole("link", { name: "Back to issues" })).toHaveCSS("border-top-style", "solid");
});
