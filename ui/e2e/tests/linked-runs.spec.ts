// A request whose work went to a task: the task's findings on the rows that lead to it, the task opened in the panel
// with the way back, and the panel's list nesting the runs under the request that sent them.
import { type Call, openApp, pill, traceId } from "../app.ts";
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

test("the pill says how many of a request's tasks failed, in red before their issues, and its ring turns red", async ({
  page,
}) => {
  // Five runs that failed and three findings among them, as the console would list them.
  const failed = Array.from({ length: 5 }, (_, index) => ({ id: `run-${index}`, status: "error", issues: 0 }));
  await page.route(/api\/traces\?ids=.*&runs=1/, async (route) => {
    const id = new URL(route.request().url()).searchParams.get("ids") ?? "";
    await route.fulfill({
      json: { traces: [], runs: { [id]: [...failed, { id: "run-ok", status: "ok", issues: 3 }] } },
    });
  });
  await openApp(page, { reports: await report() });
  await page.getByRole("button", { name: "Load reports" }).click();

  await expect(pill(page).locator(".tasks")).toHaveText("5 failed3 issues");
  await expect(pill(page).locator(".tasks > span").first()).toHaveClass("failed");
  await expect(pill(page)).toHaveAccessibleName(/ · 0 q · 5 failed, 3 issues in its tasks\./);
  await expect(pill(page).locator(".tasks")).toHaveAttribute("title", /^5 failed, 3 issues in its tasks/);
  await expect(pill(page)).toHaveAttribute("data-verdict", "error");
});
