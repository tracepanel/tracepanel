// Pages of a list and its auto-refresh: rows a refresh pushes out of the first page stay listed above the older pages
// already loaded, never lost between them.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

const PAGE = 5;

/** Answers the logs list from `records` (newest first), five a page, cut by time as the agent cuts them. */
async function serve(page: Page, records: () => { time: number }[]) {
  await page.route(/\/api\/logs(\?|$)/, async (route) => {
    const before = new URL(route.request().url()).searchParams.get("before");
    const rows = records().filter((row) => before === null || row.time < Number(before));
    const items = rows.slice(0, PAGE);
    const next = rows.length > PAGE ? (items.at(-1)?.time ?? null) : null;
    await route.fulfill({ json: { logs: items, next } });
  });
}

test("rows a refresh pushes off the first page stay between it and the older pages", async ({ page }) => {
  const body = (await (await fetch(`${CONSOLE}api/logs`)).json()) as { logs: Record<string, unknown>[] };
  const model = body.logs[0];
  if (!model) throw new Error("no stored record");
  const at = Date.now() * 1000;
  const record = (n: number) => ({ ...model, time: at + n * 1_000_000, message: `record ${n}` });
  // Twelve records: a first page and two older ones.
  let records = Array.from({ length: 12 }, (_, n) => record(12 - n));
  await serve(page, () => records);
  await page.goto("/#/logs");
  const rows = page.getByRole("region", { name: "Logs" }).getByRole("rowgroup").last().getByRole("row");
  const older = page.getByRole("button", { name: "Load older logs" });
  // Both older pages: the end of the list in view loads one, the button the next.
  await expect(rows).toHaveCount(10);
  await older.click();
  await expect(rows).toHaveCount(12);
  await expect(older).toHaveCount(0);

  records = [record(15), record(14), record(13), ...records];
  await page.getByRole("button", { name: "Refresh now" }).first().click();

  await expect(rows).toHaveCount(15);
  expect(await rows.getByRole("button", { name: /^record \d+$/ }).allTextContents()).toEqual(
    Array.from({ length: 15 }, (_, n) => `record ${15 - n}`),
  );
});
