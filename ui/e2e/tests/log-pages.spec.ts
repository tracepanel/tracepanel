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
  expect(await rows.getByText(/^record \d+$/).allTextContents()).toEqual(
    Array.from({ length: 15 }, (_, n) => `record ${15 - n}`),
  );
});

test("every record's time says its day, today's too, and no heading rows stand between the records", async ({
  page,
}) => {
  const body = (await (await fetch(`${CONSOLE}api/logs`)).json()) as { logs: Record<string, unknown>[] };
  const model = body.logs[0];
  if (!model) throw new Error("no stored record");
  const now = Date.now() * 1000;
  const day = 24 * 3600 * 1_000_000;
  const record = (time: number, message: string) => ({ ...model, time, message });
  const records = [record(now, "today"), record(now - day, "yesterday"), record(now - day - 1, "yesterday too")];
  await serve(page, () => records);
  /** "Oct 21 15:45:20.345", in local time. */
  const stamp = (time: number) => {
    const at = new Date(time / 1000);
    const month = at.toLocaleString("en-US", { month: "short" });
    const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const ms = String(at.getMilliseconds()).padStart(3, "0");
    return `${month} ${String(at.getDate()).padStart(2, "0")} ${clock}.${ms}`;
  };

  await page.goto("/#/logs");
  const list = page.getByRole("region", { name: "Logs" }).getByRole("rowgroup").last();
  const rows = list.getByRole("row");

  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole("cell").first()).toHaveText(stamp(now));
  await expect(rows.nth(1).getByRole("cell").first()).toHaveText(stamp(now - day));
  expect(await list.locator("tr:not([data-record])").count()).toBe(0);

  // The arrow keys go from record to record.
  await rows.nth(0).focus();
  await page.keyboard.press("ArrowDown");

  await expect(rows.nth(1)).toBeFocused();
});

test("a long list draws only the rows in view, and scrolling still reaches its end", async ({ page }) => {
  const body = (await (await fetch(`${CONSOLE}api/logs`)).json()) as { logs: Record<string, unknown>[] };
  const model = body.logs[0];
  if (!model) throw new Error("no stored record");
  const at = Date.now() * 1000;
  // Thousands of records, a page of a thousand: three pages loaded as the end of the list comes into view.
  const total = 3000;
  const records = Array.from({ length: total }, (_, n) => ({
    ...model,
    id: n + 1,
    time: at - n * 1000,
    message: `record ${total - n}`,
  }));
  await page.route(/\/api\/logs(\?|$)/, async (route) => {
    const before = new URL(route.request().url()).searchParams.get("before");
    const rows = records.filter((row) => before === null || row.time < Number(before));
    const items = rows.slice(0, 1000);
    await route.fulfill({ json: { logs: items, next: rows.length > 1000 ? (items.at(-1)?.time ?? null) : null } });
  });
  await page.goto("/#/logs");
  const region = page.getByRole("region", { name: "Logs" });
  const rows = region.locator("tr[data-record]");
  await expect(rows.first()).toContainText(`record ${total}`);

  // To the end: each page as the end of the list comes into view, and the first record's row gone from the page.
  const last = region.getByText("record 1", { exact: true });
  await expect(async () => {
    await region.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(last).toHaveCount(1, { timeout: 500 });
  }).toPass();
  await expect(page.getByRole("button", { name: "Load older logs" })).toHaveCount(0);
  expect(await rows.count()).toBeLessThan(150);
  await expect(rows.filter({ hasText: `record ${total}` })).toHaveCount(0);

  // And back to the top: the newest again, the window moved with the scroll.
  await region.evaluate((element) => element.scrollTo(0, 0));
  await expect(rows.first()).toContainText(`record ${total}`);
  expect(await rows.count()).toBeLessThan(150);

  // The arrows go on past the rows drawn: the window follows the focus down, a row a press (each press waits for
  // the one before, as a held key's repeat does: a busy runner can send them faster than a frame).
  await rows.first().focus();
  const focused = page.locator("tr[data-record]:focus");
  for (let step = 1; step <= 80; step += 1) {
    await page.keyboard.press("ArrowDown");
    await expect(focused).toContainText(`record ${total - step}`);
  }
});

/** The stored records' first, to make others from: whatever the API answers for one, with these fields. */
async function aRecord(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = (await (await fetch(`${CONSOLE}api/logs`)).json()) as { logs: Record<string, unknown>[] };
  const model = body.logs[0];
  if (!model) throw new Error("no stored record");
  return { ...model, time: Date.now() * 1000, ...fields };
}

const TRACEBACK = `Traceback (most recent call last):
  File "/srv/shop/orders/views.py", line 41, in checkout
    total = price(order)
  File "/srv/shop/orders/pricing.py", line 12, in price
    return rates[order.currency] * order.amount
  File "/usr/lib/python3.12/site-packages/django/utils/functional.py", line 57, in __get__
    res = instance.__dict__[self.name] = self.func(instance)
KeyError: 'EUR'`;

test("an exception opens as its frames: the error first, the app's frames, the library's folded, the raw text a click away", async ({
  page,
}) => {
  const record = await aRecord({ level: "error", message: "checkout failed", exception: TRACEBACK });
  await page.route(/\/api\/logs(\?|$)/, (route) => route.fulfill({ json: { logs: [record], next: null } }));
  await page.goto("/#/logs");
  await page.locator("tr[data-record]").first().click();
  const exception = page.getByRole("region", { name: "Exception" });

  await expect(exception.locator(".dt-error-type")).toHaveText("KeyError");
  await expect(exception.locator(".dt-error-message")).toHaveText("'EUR'");
  const frame = (name: string) => exception.locator(".dt-frame-fn").getByText(name, { exact: true });
  await expect(frame("checkout")).toBeVisible();
  await expect(frame("price")).toBeVisible();
  // The deepest of the app's frames is where it went wrong: open, its line shown.
  await expect(exception.getByText("return rates[order.currency] * order.amount")).toBeVisible();
  await expect(exception.getByText("1 library frame")).toBeVisible();
  await expect(frame("__get__")).toBeHidden();

  await exception.getByRole("tab", { name: "Raw" }).click();

  await expect(exception.locator("pre")).toHaveText(TRACEBACK);
  await expect(exception.getByRole("button", { name: "Copy exception" })).toBeVisible();
});

test("a JSON message opens indented, the row keeps it on one line, the raw text a click away", async ({ page }) => {
  const message = '{"event": "order.paid", "order": {"id": 12, "items": [1, 2]}}';
  const record = await aRecord({ message });
  await page.route(/\/api\/logs(\?|$)/, (route) => route.fulfill({ json: { logs: [record], next: null } }));
  await page.goto("/#/logs");
  const row = page.locator("tr[data-record]").first();

  await expect(row).toContainText(message);
  await row.click();
  const opened = page.getByRole("region", { name: "Message" });

  await expect(opened.locator("pre")).toHaveText(JSON.stringify(JSON.parse(message), null, 2));

  await opened.getByRole("tab", { name: "Raw" }).click();

  await expect(opened.locator("pre")).toHaveText(message);
});
