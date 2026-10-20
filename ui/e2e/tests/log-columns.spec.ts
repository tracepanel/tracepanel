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
  const long = region(page).locator("tr[data-record]").filter({ hasText: "listing 50 posts with select_related" });
  const message = long.getByText(/^listing 50 posts with select_related/);

  // One line: a row is about as tall as its text, the message cut short rather than wrapped.
  await expect(message).toBeVisible();
  expect((await long.boundingBox())?.height).toBeLessThan(36);
  expect(await message.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

  await long.focus();
  await page.keyboard.press("Enter");

  await expect(long).toHaveAttribute("aria-expanded", "true");
  await expect(region(page).getByRole("link", { name: "Open request" })).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(long).toHaveAttribute("aria-expanded", "false");
});

test("the arrow keys go from record to record, past an opened one's details", async ({ page }) => {
  await page.goto("/#/logs");
  const records = region(page).locator("tr[data-record]");
  await records.first().focus();
  await page.keyboard.press("Enter");

  await page.keyboard.press("ArrowDown");

  await expect(records.nth(1)).toBeFocused();

  await page.keyboard.press("ArrowUp");

  await expect(records.first()).toBeFocused();
  await expect(records.first()).toHaveAttribute("aria-expanded", "true");
});

test("a message's text can be selected without opening its record", async ({ page }) => {
  await page.goto("/#/logs");
  const record = rows(page).filter({ hasText: "listing 50 posts for AnonymousUser" });
  const box = await record.getByText("listing 50 posts for AnonymousUser", { exact: true }).boundingBox();
  if (!box) throw new Error("no message");

  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("listing 50 posts");
  await expect(record).toHaveAttribute("aria-expanded", "false");
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
  // Listed once: in Attribute columns, not again among the table's own columns.
  await expect(page.getByRole("menuitemcheckbox", { name: key, exact: true })).toHaveCount(0);

  await page.getByRole("menuitem", { name: "Reset to defaults" }).click();

  await expect(header(page, key)).toHaveCount(0);
});

test("a column dragged onto another moves there, and stays there after a reload", async ({ page }) => {
  await page.goto("/#/logs");
  const names = region(page).getByRole("columnheader");
  await expect(names.first()).toHaveAccessibleName("Time");
  // The records in: the headers have their widths, and stay where the drag aims.
  await expect(rows(page).first()).toBeVisible();

  await header(page, "Logger").getByText("Logger").dragTo(header(page, "Time"));

  await expect(names.first()).toHaveAccessibleName("Logger");

  await page.reload();

  await expect(names.first()).toHaveAccessibleName("Logger");
});

test("an attribute of an opened record becomes a column from there, and its header takes it off", async ({ page }) => {
  await page.goto("/#/logs");
  const record = rows(page).filter({ hasText: "listing 50 posts for AnonymousUser" });
  await record.click();
  const show = region(page)
    .getByRole("button", { name: /^Show .+ as a column$/ })
    .first();
  const key = ((await show.getAttribute("aria-label")) ?? "").replace(/^Show (.+) as a column$/, "$1");

  await show.click();

  await expect(header(page, key)).toBeVisible();
  // The record's own button says so too: pressed, it takes the column off again.
  await expect(region(page).getByRole("button", { name: `Hide the ${key} column`, pressed: true })).toBeVisible();

  await header(page, key).hover();
  await header(page, key)
    .getByRole("button", { name: `Hide the ${key} column` })
    .click();

  await expect(header(page, key)).toHaveCount(0);
});

test("the records over time sit above the table, by level, and a drag across them narrows the search to that time", async ({
  page,
}) => {
  await page.goto("/#/logs");
  const chart = page.getByRole("img", { name: "Log records over time, by level" });
  await expect(chart).toBeVisible();
  await expect(page.getByRole("button", { name: "ERROR", exact: true, pressed: true })).toBeVisible();

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

test("the Logs page's Overview folds to its numbers, as an entry point's does, and stays folded after a reload", async ({
  page,
}) => {
  await page.goto("/#/logs");
  const overview = page.getByRole("region", { name: "Overview" });
  const chart = page.getByRole("img", { name: "Log records over time, by level" });
  const heading = overview.getByRole("button", { name: /^Overview/ });
  await expect(chart).toBeVisible();
  await expect(overview.getByText("Records over time")).toBeVisible();

  await heading.click();

  await expect(chart).toHaveCount(0);
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await expect(heading).toContainText(/\d+ records/);
  await expect(heading).toContainText(/\d+ errors?/);
  await expect(heading).toContainText(/\d+ warnings?/);
  // A click is no keyboard focus: no ring.
  expect(await heading.evaluate((element) => element.matches(":focus-visible"))).toBe(false);

  await page.reload();

  await expect(chart).toHaveCount(0);

  await heading.click();

  await expect(chart).toBeVisible();
});

test("the chart's legend filters the list by level, as the Level filter does", async ({ page }) => {
  await page.goto("/#/logs");
  const legend = (name: string) => page.getByRole("button", { name, exact: true });

  await legend("INFO").click();
  await legend("DEBUG").click();

  // What is left: warnings and errors, critical ones with them, as the Level menu's "WARNING and above" says them.
  await expect(page).toHaveURL(/level(%3E|>)(%3D|=)warning/);
  await expect(legend("INFO")).toHaveAttribute("aria-pressed", "false");
  await expect(legend("WARNING")).toHaveAttribute("aria-pressed", "true");
  // The Level column, second: its text is the level as stored, shown in capitals.
  const levels = await region(page).locator("tr[data-record] td:nth-child(2)").allTextContents();
  expect(levels.length).toBeGreaterThan(0);
  for (const level of levels) {
    expect(["warning", "error", "critical"]).toContain(level);
  }

  await legend("INFO").click();
  await legend("DEBUG").click();

  // Every level again: no filter left.
  await expect(page).not.toHaveURL(/level/);
});

test("a search that finds nothing keeps the chart of its time range, and offers to clear it", async ({ page }) => {
  await page.goto(
    `/#/logs?q=${encodeURIComponent("nothing-logs-this since:2000-01-01T00:00:00 until:2000-01-01T00:10:00")}`,
  );

  await expect(page.getByText("No log records match")).toBeVisible();
  await expect(page.getByRole("img", { name: "Log records over time, by level" })).toBeVisible();

  await page.getByRole("button", { name: "Clear the search" }).click();

  await expect(rows(page).first()).toBeVisible();
});

test("a search the store refuses says so, rather than loading for ever", async ({ page }) => {
  await page.goto(`/#/logs?q=${encodeURIComponent("level:loud")}`);

  await expect(page.getByText("Nothing to show")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Loading" })).toHaveCount(0);
});

test("Live reloads the records, and holds while one is open", async ({ page }) => {
  await page.goto("/#/logs");
  const live = page.getByRole("checkbox", { name: /^Live/ });

  // The switch's own label: the box itself is hidden under its track, as the panel's Follow new is.
  await page.getByText("Live", { exact: true }).click();

  await expect(live).toBeChecked();

  await rows(page).first().click();

  await expect(page.getByText("Live · paused")).toBeVisible();
});

test("the search's words are marked in the messages", async ({ page }) => {
  await page.goto(`/#/logs?q=${encodeURIComponent("posts")}`);

  await expect(rows(page).first().locator("mark").first()).toHaveText(/^posts$/i);
});

test("an opened record copies as JSON, and as a link to itself", async ({ page }) => {
  await page.goto("/#/logs");
  await rows(page).first().click();

  await expect(region(page).getByRole("button", { name: "Copy the record as JSON" })).toBeVisible();
  await expect(region(page).getByRole("button", { name: "Copy a link to the record" })).toBeVisible();
});

test("a column's name, focused, moves its column with the arrow keys", async ({ page }) => {
  await page.goto("/#/logs");
  const names = region(page).getByRole("columnheader");
  await expect(names.nth(3)).toHaveAccessibleName("Logger");

  await region(page).getByRole("button", { name: "Move the Logger column with the arrow keys" }).focus();
  await page.keyboard.press("ArrowLeft");

  await expect(names.nth(2)).toHaveAccessibleName("Logger");
  await expect(names.nth(3)).toHaveAccessibleName("Message");
});

test("a trace's Logs tab counts its records and opens them in Logs", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("POST /api/books/announce")}?tab=logs`);
  const panel = page.getByRole("tabpanel");

  await expect(panel.getByText("2 records")).toBeVisible();

  await panel.getByRole("link", { name: "Open in Logs" }).click();

  await expect(page).toHaveURL(/#\/logs\?q=trace/);
});

test("more columns than room fit the page: none pushes it wider, and Message keeps some", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto("/#/logs");
  // Wide columns, dragged so in an earlier visit, and two attribute columns more.
  await page.evaluate(() => {
    localStorage.setItem("tracepanel:columns:logs:attributes", JSON.stringify(["code.lineno", "code.function"]));
    localStorage.setItem(
      "tracepanel:columns:logs",
      JSON.stringify({ widths: { logger: 360, source: 330, trace: 370 }, shown: { trace: true }, order: [] }),
    );
  });
  await page.reload();
  const scroller = page.locator("[data-scroll]");
  await expect(rows(page).first()).toBeVisible();

  expect(await scroller.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  expect((await header(page, "Message").boundingBox())?.width).toBeGreaterThan(100);
});

test("every column that may go hides from its header, Message alone stays", async ({ page }) => {
  await page.goto("/#/logs");
  await expect(rows(page).first()).toBeVisible();

  await expect(header(page, "Message").getByRole("button", { name: /^Hide/ })).toHaveCount(0);

  await header(page, "Logger").hover();
  await header(page, "Logger").getByRole("button", { name: "Hide the Logger column" }).click();

  await expect(header(page, "Logger")).toHaveCount(0);

  await region(page).getByRole("button", { name: "Columns" }).click();

  await expect(page.getByRole("menuitemcheckbox", { name: "Logger" })).toHaveAttribute("aria-checked", "false");
});

test("the Level menu offers WARNING and above: one filter, shown in the legend too", async ({ page }) => {
  await page.goto("/#/logs");
  await page.getByRole("button", { name: "Level", exact: true }).click();
  await page.getByRole("option", { name: "WARNING and above" }).click();

  await expect(page).toHaveURL(/level(%3E|>)(%3D|=)warning/);
  await expect(page.getByRole("button", { name: "Edit level>=warning" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Level · ≥ WARNING/ })).toBeVisible();
  const legend = (name: string) => page.getByRole("button", { name, exact: true });
  await expect(legend("INFO")).toHaveAttribute("aria-pressed", "false");
  await expect(legend("WARNING")).toHaveAttribute("aria-pressed", "true");
  await expect(legend("ERROR")).toHaveAttribute("aria-pressed", "true");

  // ERROR unchecked from there: the levels left, one by one. (A level's tag is in capitals by its style.)
  await page.getByRole("option", { name: "error", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit level:warning,critical" })).toBeVisible();
});
