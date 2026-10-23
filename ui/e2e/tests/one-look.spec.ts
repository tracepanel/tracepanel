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

test("a copy button follows its value, in an attribute's row as in a fact's; an attribute's name has no tooltip", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("GET /api/posts")}?tab=request`);
  const main = page.getByRole("main");
  // How far the button starts after the end of the value beside it.
  const gap = (button: ReturnType<typeof main.getByRole>) =>
    button.evaluate((element) => {
      const value = element.closest("dd")?.firstElementChild;
      if (!value) throw new Error("no value beside the button");
      return element.getBoundingClientRect().left - value.getBoundingClientRect().right;
    });
  const attribute = main.getByRole("button", { name: "Copy status_code" });
  const fact = main
    .locator("dl")
    .first()
    .getByRole("button", { name: /^Copy / })
    .first();

  expect(await gap(attribute)).toBeLessThanOrEqual(16);
  expect(await gap(attribute)).toBeGreaterThanOrEqual(0);
  expect(await gap(fact)).toBeLessThanOrEqual(16);
  await expect(attribute.locator("xpath=ancestor::dd/preceding-sibling::dt[1]")).not.toHaveAttribute("title");
});

test("a choice of lists is the pill switch every pane has: the chosen one raised on a muted track", async ({
  page,
}) => {
  await page.goto("/#/endpoints?view=overview");
  const list = page.getByRole("navigation", { name: "List" });
  const chosen = list.locator('[aria-current="page"]');
  const other = list.locator("a:not([aria-current])");

  await expect(chosen).toHaveCSS("box-shadow", /rgba?\(/);
  await expect(other).toHaveCSS("box-shadow", "none");
});

test("a trace's parts without a switch are named on the same pill track as the ones with one", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("shop.tasks.parse_feed")}`);
  await page.getByRole("tablist").first().getByRole("tab", { name: /^Task/ }).click();
  const workflow = page.getByRole("region", { name: "Workflow" }).getByRole("heading");

  await expect(workflow).toHaveText("Workflow");
  await expect(workflow.locator("span").first()).toHaveClass(/rounded-lg/);
});

for (const [name, url] of [
  ["a log record", "/#/logs"],
  ["an email", "/#/mails"],
  ["a query", "/#/calls/sql"],
] as const) {
  test(`${name} opened in its list ends with the one footer: its actions, then the way to its trace at the right`, async ({
    page,
  }) => {
    await page.goto(url);
    await page.getByRole("main").locator("tbody tr").first().click();
    const footer = page.getByRole("main").locator(".dt-details-footer");
    const open = footer.getByRole("link").last();

    await expect(footer).toHaveCount(1);
    await expect(open).toHaveText(/^(Open|Latest) /);
    const [box, row] = [await open.boundingBox(), await footer.boundingBox()];
    if (!(box && row)) throw new Error("no footer");
    expect(row.x + row.width - (box.x + box.width)).toBeLessThan(2);
  });
}
