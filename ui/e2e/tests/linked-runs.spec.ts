// A request whose work went to a task: the task's findings on the rows that lead to it, the task opened in the panel
// with the way back, and the panel's list nesting the runs under the request that sent them.
import { type Call, openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { SALES_REPORT } from "../seed.ts";

const REQUEST = "POST /api/reports/sales";
// The run's row in the call tree, its name maybe cut at its start (its enqueue's row is "task.enqueue enqueue …").
const TASK_ROW = /^task \S*build_sales_report/;

async function report(): Promise<Call> {
  return { status: 202, trace: await traceId(REQUEST), queries: 0, totalMs: 12 };
}

test("in the console, the task's row in the call tree and under Related names what its own trace found", async ({
  page,
}) => {
  const request = await traceId(REQUEST);
  const task = await traceId(SALES_REPORT);
  await page.goto(`/#/t/${request}?tab=tree`);
  const row = page.getByRole("button", { name: TASK_ROW });

  await expect(row).toContainText("N+1");
  await expect(row.getByTitle(/SQL queries$/)).toBeVisible();

  await row.click();
  await page.getByRole("link", { name: "Open the task's trace →" }).click();

  // The console opens it on its page, as before.
  await expect(page).toHaveURL(new RegExp(`#/t/${task}`));

  await page.goBack();
  await page.getByRole("tab", { name: /^Request/ }).click();
  const related = page.getByRole("region", { name: "Related traces" });

  // Its name is cut at its start where it doesn't fit: whole in its title.
  await expect(related.getByRole("link").filter({ has: page.getByTitle(SALES_REPORT) })).toContainText("N+1");
});

test("in the panel, a task opens in the panel itself, and Back or Esc returns to the request", async ({ page }) => {
  await openApp(page, { reports: await report() });
  await page.getByRole("button", { name: "Load reports" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("button", { name: TASK_ROW }).click();
  await frame.getByRole("link", { name: "Open the task's trace →" }).click();
  const back = frame.getByRole("button", { name: "Back" });

  await expect(back).toContainText("/api/reports/sales");
  await expect(frame.getByRole("tab", { name: /^Issues/ })).toBeVisible();
  // Still on the app's page, no tab of the console's opened.
  expect(page.context().pages()).toHaveLength(1);
  await expect(page).toHaveURL(/\/app\/$/);

  await back.click();

  await expect(back).toBeHidden();
  await expect(frame.getByRole("button", { name: TASK_ROW })).toBeVisible();

  await frame.getByRole("button", { name: TASK_ROW }).click();
  await frame.getByRole("link", { name: "Open the task's trace →" }).click();
  await expect(back).toBeVisible();

  // The first Esc goes back, the next one closes the panel.
  await page.locator("iframe").focus();
  await frame.locator("body").press("Escape");

  await expect(back).toBeHidden();
  await expect(page.locator("iframe")).toBeVisible();

  await frame.locator("body").press("Escape");

  await expect(page.locator("iframe")).toBeHidden();
});

test("the panel's list nests the runs a request sent under it, and the request says its tasks found something", async ({
  page,
}) => {
  await openApp(page, { reports: await report() });
  await page.getByRole("button", { name: "Load reports" }).click();

  // Its own count stays its own (none): the pill says what its tasks found apart from it.
  await expect(pill(page)).toHaveAccessibleName(/GET \/app\/api\/reports → 202 .* · 0 q · \d+ issues? in its tasks/);
  await expect(pill(page)).toHaveAttribute("data-verdict", "warn");
  await expect(pill(page).locator(".task-issues")).toContainText(/\d+ in tasks/);
  await expect(pill(page).locator(".issues")).toHaveCount(0);

  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  const rows = list.getByRole("listitem");

  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("/api/reports/sales");
  await expect(rows.nth(0).getByRole("img", { name: /^\d+ issues? in its tasks: N\+1/ })).toBeVisible();
  await expect(rows.nth(1).getByTitle(SALES_REPORT)).toBeVisible();
  await expect(rows.nth(1).getByRole("button")).toHaveAttribute("data-run", "");

  // The list counts requests, not the runs nested under them.
  await expect(panel(page).getByRole("button", { name: "Clear 1 request" })).toBeVisible();

  await rows.nth(1).getByRole("button").click();

  await expect(panel(page).getByRole("tab", { name: /^Issues/ })).toBeVisible();
  await expect(rows.nth(1).getByRole("button")).toHaveAttribute("aria-current", "true");
});
