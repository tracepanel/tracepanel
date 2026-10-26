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
  const call = page.locator("tr[data-tone]").filter({ hasText: "127.0.0.1/api/books" });

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
  const track = await workflow.locator("span").first().boundingBox();
  const attributes = await page.getByRole("tablist", { name: "Request details" }).boundingBox();
  if (!(track && attributes)) throw new Error("no tracks");

  // The same full-width muted track as Attributes', not a lone pill.
  expect(Math.abs(track.width - attributes.width)).toBeLessThan(1);
  expect(Math.abs(track.height - attributes.height)).toBeLessThan(1);
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

test("a trace that called nothing has no lone Duration tile: its header says how long it took", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("shop.tasks.parse_feed")}`);

  await expect(page.locator(".dt-trace-title, h1").first()).toContainText("42 ms");
  await expect(page.locator(".dt-metrics")).toHaveCount(0);
});

test("a group's summary has the tiles an entry point's Overview has, in the same order", async ({ page }) => {
  await page.goto(`/#/group/endpoints/${encodeURIComponent("GET /api/posts")}`);
  const summary = page.getByRole("region", { name: "Summary" });

  await expect(summary.getByText(/^(Calls|Errors|Slow ≥ 500 ms|p50|p95|p99|Avg queries)$/)).toHaveCount(7);
  // In one row at 1440 px, as the Overview's.
  const tops = await summary
    .locator(":scope > *")
    .evaluateAll((tiles) => tiles.map((tile) => Math.round(tile.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
});

test("an issue's long route wraps in its row, never cut", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/#/issues");
  const route = page.getByRole("main").locator("tbody").getByText("/campaigns/{id}/report").first();

  await expect(route).toBeVisible();
  expect(await route.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("a trace opened directly leads back to its list, its lane is named as what it is, and it started on the 24-hour clock", async ({
  page,
}) => {
  // A task that logged: its lanes are its own and its logs'.
  await page.goto(`/#/t/${await traceId("shop.tasks.send_receipt")}`);
  const crumbs = page.getByRole("main").getByRole("navigation", { name: "Breadcrumb" });

  await expect(crumbs.getByRole("link", { name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("figure", { name: "Timeline" })).toContainText("task");
  await expect(page.getByRole("figure", { name: "Timeline" })).not.toContainText("request");

  await page.getByRole("tablist").first().getByRole("tab", { name: /^Task/ }).click();

  await expect(page.locator("dl").first()).toContainText(/[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2}/);
  await expect(page.locator("dl").first()).not.toContainText(/ (AM|PM)/);
});

test("a trace's facts start their second column's values at one x, whatever its names", async ({ page }) => {
  const starts: number[] = [];
  for (const name of [
    "GET /api/posts",
    "shop.tasks.parse_feed",
    "shop.tasks.send_receipt",
    "manage.py rebuild_index",
  ]) {
    await page.goto(`/#/t/${await traceId(name)}`);
    await page.getByRole("tablist").first().getByRole("tab").first().click();
    const second = page.getByRole("main").locator("dl").first().locator("dd").nth(1);
    starts.push(Math.round((await second.boundingBox())?.x ?? 0));
  }

  expect(new Set(starts).size).toBe(1);
});

test("every call tree has its time over it: its own lane alone, or with a lane per thing it called", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("shop.tasks.parse_feed")}?tab=tree`);

  await expect(page.getByRole("figure", { name: "Timeline" }).locator(".dt-lane-label")).toHaveText(["task"]);

  await page.goto(`/#/t/${await traceId("GET /api/posts")}`);
  const lanes = page.getByRole("figure", { name: "Timeline" });

  await expect(lanes).toContainText("request");
  await expect(lanes).toContainText(/\d+ queries/);
});
