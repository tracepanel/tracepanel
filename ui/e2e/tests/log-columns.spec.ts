// The logs table: one line per record, columns the reader drags wider and picks, kept in the browser across reloads,
// on the Logs page and in a trace's Logs tab alike.
import type { Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const region = (page: Page) => page.getByRole("region", { name: "Logs" });
const rows = (page: Page) => region(page).getByRole("rowgroup").last().getByRole("row");
const header = (page: Page, name: string) => region(page).getByRole("columnheader", { name, exact: true });

async function widthOf(page: Page, name: string): Promise<number> {
  return (await header(page, name).boundingBox())?.width ?? 0;
}

test("a record takes one line, however long its message; its details open under it", async ({ page }) => {
  // Narrow enough that the message is longer than its column.
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/#/logs");
  const long = rows(page).filter({ hasText: "listing 50 posts with select_related" });
  const message = long.getByRole("button", { name: /^listing 50 posts with select_related/ });

  // One line: a row is about as tall as its text, the message cut short rather than wrapped.
  await expect(message).toBeVisible();
  expect((await long.boundingBox())?.height).toBeLessThan(36);
  expect(await message.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  await message.focus();
  await page.keyboard.press("Enter");

  await expect(message).toHaveAttribute("aria-expanded", "true");
  await expect(region(page).getByRole("link", { name: "Open request" })).toBeVisible();
});

test("a column dragged wider stays wider after a reload, and a double click fits it", async ({ page }) => {
  await page.goto("/#/logs");
  await expect(rows(page).first()).toBeVisible();
  const before = await widthOf(page, "Logger");
  // Logger sits right of the message: its left edge is the one to drag.
  const edge = await region(page).getByRole("separator", { name: "Resize the Logger column" }).boundingBox();
  if (!edge) throw new Error("no resize edge on Logger");
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 80, edge.y + edge.height / 2, { steps: 5 });
  await page.mouse.up();

  expect(await widthOf(page, "Logger")).toBeCloseTo(before + 80, -1);

  await page.reload();
  await expect(rows(page).first()).toBeVisible();

  expect(await widthOf(page, "Logger")).toBeCloseTo(before + 80, -1);

  await region(page).getByRole("separator", { name: "Resize the Logger column" }).dblclick();

  expect(await widthOf(page, "Logger")).toBeLessThan(before + 80);
});

test("the arrow keys move a column's edge too", async ({ page }) => {
  await page.goto("/#/logs");
  await expect(rows(page).first()).toBeVisible();
  const before = await widthOf(page, "Time");
  const edge = region(page).getByRole("separator", { name: "Resize the Time column" });

  await edge.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");

  expect(await widthOf(page, "Time")).toBeCloseTo(before + 32, -1);
  await expect(edge).toHaveAttribute("aria-valuenow", String(Math.round(before + 32)));
});

test("columns hidden and shown from the menu stay so after a reload, until reset", async ({ page }) => {
  await page.goto("/#/logs");
  await expect(header(page, "Logger")).toBeVisible();
  await expect(header(page, "Trace")).toHaveCount(0);

  await region(page).getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Logger" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Trace" }).click();
  await page.keyboard.press("Escape");

  await expect(header(page, "Logger")).toHaveCount(0);
  await expect(header(page, "Trace")).toBeVisible();
  await expect(rows(page).first().getByRole("link")).toHaveText(/^[0-9A-Z]{26}$/);

  await page.reload();

  await expect(header(page, "Trace")).toBeVisible();
  await expect(header(page, "Logger")).toHaveCount(0);

  await region(page).getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitem", { name: "Reset to defaults" }).click();

  await expect(header(page, "Logger")).toBeVisible();
  await expect(header(page, "Trace")).toHaveCount(0);
});

test("the time shows as a time of day or as how long ago, as last chosen", async ({ page }) => {
  await page.goto("/#/logs");
  const time = rows(page).first().getByRole("cell").first();

  await expect(time).toHaveText(/^\d\d:\d\d:\d\d\.\d{3}$/);

  await region(page).getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitemradio", { name: "Time ago" }).click();
  await page.keyboard.press("Escape");

  await expect(time).toHaveText(/ ago$/);

  await page.reload();

  await expect(rows(page).first().getByRole("cell").first()).toHaveText(/ ago$/);
});

test("a trace's Logs tab is the same table, with its own columns and times since the request started", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("POST /api/books/announce")}?tab=logs`);
  const panel = page.getByRole("tabpanel");

  await expect(panel.getByRole("columnheader", { name: "Message", exact: true })).toBeVisible();
  await expect(panel.getByRole("columnheader", { name: "Source", exact: true })).toHaveCount(0);

  await panel.getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitemradio", { name: "Since the request started" }).click();
  await page.keyboard.press("Escape");

  await expect(panel.getByRole("row").nth(1).getByRole("cell").first()).toHaveText(/^\+/);

  await panel.getByRole("button", { name: "In the call tree" }).first().click();

  await expect(page.getByRole("tab", { name: /^Call tree/ })).toHaveAttribute("aria-selected", "true");
});

test("an attribute picked from the menu becomes a column of its own, after a reload too, until reset", async ({
  page,
}) => {
  await page.goto("/#/logs");
  await region(page).getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitem", { name: "Attribute columns" }).click();
  // The submenu's own items: the attribute keys of the records listed.
  const offered = page.getByRole("menu").last().getByRole("menuitemcheckbox");
  const key = (await offered.first().textContent()) ?? "";
  await offered.first().click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await expect(header(page, key)).toBeVisible();

  await page.reload();

  await expect(header(page, key)).toBeVisible();

  await region(page).getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitem", { name: "Reset to defaults" }).click();

  await expect(header(page, key)).toHaveCount(0);
});

test("a column dragged onto another moves there, and stays there after a reload", async ({ page }) => {
  await page.goto("/#/logs");
  const names = region(page).getByRole("columnheader");
  await expect(names.first()).toHaveAccessibleName("Time");

  await header(page, "Logger").getByText("Logger").dragTo(header(page, "Time"));

  await expect(names.first()).toHaveAccessibleName("Logger");

  await page.reload();

  await expect(names.first()).toHaveAccessibleName("Logger");
});

test("an attribute of an opened record becomes a column from there, and its header takes it off", async ({ page }) => {
  await page.goto("/#/logs");
  const record = rows(page).filter({ hasText: "listing 50 posts for AnonymousUser" });
  await record.getByRole("button", { name: /^listing 50 posts/ }).click();
  const show = region(page)
    .getByRole("button", { name: /^Show .+ as a column$/ })
    .first();
  const key = ((await show.getAttribute("aria-label")) ?? "").replace(/^Show (.+) as a column$/, "$1");

  await show.click();

  await expect(header(page, key)).toBeVisible();
  // The record's own button says so too: pressed, it takes the column off again.
  await expect(region(page).getByRole("button", { name: `Remove the ${key} column`, pressed: true })).toBeVisible();

  await header(page, key).hover();
  await header(page, key)
    .getByRole("button", { name: `Remove the ${key} column` })
    .click();

  await expect(header(page, key)).toHaveCount(0);
});

test("the records over time sit above the table, by level, and a drag across them narrows the search to that time", async ({
  page,
}) => {
  await page.goto("/#/logs");
  const chart = page.getByRole("img", { name: "Log records over time, by level" });
  await expect(chart).toBeVisible();
  await expect(page.getByRole("button", { name: "error", exact: true, pressed: true })).toBeVisible();

  const before = await rows(page).count();
  const box = await chart.boundingBox();
  if (!box) throw new Error("no chart");
  // From the first bar to the last: the whole period, every record in it.
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect(page).toHaveURL(/since(%3A|:).*until(%3A|:)/);
  // The range rounds out to whole seconds: a record in the last second is not cut off.
  await expect(rows(page)).toHaveCount(before);
});

test("the records over time fold to their title, and stay folded after a reload", async ({ page }) => {
  await page.goto("/#/logs");
  const chart = page.getByRole("img", { name: "Log records over time, by level" });
  const title = page.getByRole("button", { name: "Records over time" });
  await expect(chart).toBeVisible();

  await title.click();

  await expect(chart).toHaveCount(0);
  await expect(title).toHaveAttribute("aria-expanded", "false");

  await page.reload();

  await expect(chart).toHaveCount(0);

  await title.click();

  await expect(chart).toBeVisible();
});
