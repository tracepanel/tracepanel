// Every list of the console has the logs table's columns: dragged wider, hidden from their header and brought back
// from the columns menu, moved, kept per browser per list; the list's main column always stays. One look for all.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

const main = (page: Page) => page.getByRole("main");
const header = (page: Page, name: string) => main(page).getByRole("columnheader", { name, exact: true });
const firstRow = (page: Page) => main(page).locator("tbody tr").first();
const headers = (page: Page) => main(page).getByRole("table").first().getByRole("columnheader");

async function widthOf(locator: Locator): Promise<number> {
  return (await locator.boundingBox())?.width ?? 0;
}

/** Waits for the list's rows: the headers have their widths then. */
async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(firstRow(page)).toBeVisible();
}

test("a column dragged wider on HTTP stays wider after a reload, and the main column gives the room", async ({
  page,
}) => {
  await open(page, "/#/endpoints");
  const calls = header(page, "Calls");
  const before = await widthOf(calls);
  const endpoint = await widthOf(header(page, "Endpoint"));
  // Calls sits right of Endpoint, the column that takes the rest: its left edge is the one to drag.
  const handle = main(page).getByRole("separator", { name: "Resize the Calls column" });
  // Under the overview: in view first, for the mouse to reach it.
  await handle.scrollIntoViewIfNeeded();
  const edge = await handle.boundingBox();
  if (!edge) throw new Error("no resize edge on Calls");
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 60, edge.y + edge.height / 2, { steps: 5 });
  await page.mouse.up();

  expect(await widthOf(calls)).toBeCloseTo(before + 60, -1);
  expect(await widthOf(header(page, "Endpoint"))).toBeCloseTo(endpoint - 60, -1);

  await page.reload();
  await expect(firstRow(page)).toBeVisible();

  expect(await widthOf(header(page, "Calls"))).toBeCloseTo(before + 60, -1);
});

test("a column hidden from its header on Tasks comes back from the columns menu, and each stays so after a reload", async ({
  page,
}) => {
  await open(page, "/#/tasks");

  await header(page, "Retried").hover();
  await header(page, "Retried").getByRole("button", { name: "Hide the Retried column" }).click();

  await expect(header(page, "Retried")).toHaveCount(0);

  await page.reload();

  await expect(header(page, "Runs")).toBeVisible();
  await expect(header(page, "Retried")).toHaveCount(0);

  await main(page).getByRole("button", { name: "Columns" }).first().click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Retried" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("menuitemcheckbox", { name: "Retried" }).click();
  await page.keyboard.press("Escape");

  await expect(header(page, "Retried")).toBeVisible();

  await page.reload();

  await expect(header(page, "Retried")).toBeVisible();
});

test("a list's main column can't be hidden: no button on its header, not in the menu", async ({ page }) => {
  const lists: [url: string, main: string][] = [
    ["/#/endpoints", "Endpoint"],
    ["/#/tasks", "Task"],
    ["/#/endpoints?view=calls", "Trace"],
    ["/#/calls/sql", "Name"],
  ];
  for (const [url, name] of lists) {
    await open(page, url);
    await header(page, name).hover();

    await expect(header(page, name).getByRole("button", { name: /^Hide/ })).toHaveCount(0);

    await main(page).getByRole("button", { name: "Columns" }).first().click();

    await expect(page.getByRole("menuitemcheckbox").first()).toBeVisible();
    await expect(page.getByRole("menuitemcheckbox", { name, exact: true })).toHaveCount(0);

    await page.keyboard.press("Escape");
  }
});

test("a column moves with the arrow keys on Database, and by a drag on All requests; each stays after a reload", async ({
  page,
}) => {
  await open(page, "/#/calls/sql");
  await expect(headers(page).nth(1)).toHaveAccessibleName("Calls");

  await main(page).getByRole("button", { name: "Move the Calls column with the arrow keys" }).focus();
  await page.keyboard.press("ArrowRight");

  await expect(headers(page).nth(1)).toHaveAccessibleName("Requests");
  await expect(headers(page).nth(2)).toHaveAccessibleName("Calls");

  await page.reload();

  await expect(headers(page).nth(2)).toHaveAccessibleName("Calls");

  await open(page, "/#/endpoints?view=calls");
  await expect(headers(page).last()).not.toHaveAccessibleName("When");

  await header(page, "When").getByText("When").dragTo(header(page, "Status"));

  await expect(headers(page).nth(1)).toHaveAccessibleName("When");

  await page.reload();

  await expect(headers(page).nth(1)).toHaveAccessibleName("When");
});

test("a reset in the menu brings a list's columns back as they were", async ({ page }) => {
  await open(page, "/#/endpoints");
  await header(page, "Errors").hover();
  await header(page, "Errors").getByRole("button", { name: "Hide the Errors column" }).click();
  await expect(header(page, "Errors")).toHaveCount(0);

  await main(page).getByRole("button", { name: "Columns" }).first().click();
  await page.getByRole("menuitem", { name: "Reset to defaults" }).click();

  await expect(header(page, "Errors")).toBeVisible();
});

test("each list keeps its own columns: hidden on HTTP, still shown on Tasks", async ({ page }) => {
  await open(page, "/#/endpoints");
  await header(page, "Last").hover();
  await header(page, "Last").getByRole("button", { name: "Hide the Last column" }).click();
  await expect(header(page, "Last")).toHaveCount(0);

  await open(page, "/#/tasks");

  await expect(header(page, "Last")).toBeVisible();
});

test("many wide columns fit the page: it never scrolls sideways, and the main column keeps some room", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  // Wide columns, dragged so in an earlier visit.
  await page.addInitScript(() =>
    localStorage.setItem(
      "tracepanel:columns:tasks",
      JSON.stringify({ widths: { system: 300, queues: 400, wait: 300 }, shown: {}, order: [] }),
    ),
  );
  for (const url of ["/#/tasks", "/#/endpoints", "/#/calls/sql", "/#/services"]) {
    await open(page, url);
    const scroller = page.locator("[data-scroll]");

    expect(await scroller.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    expect(
      await main(page)
        .locator("[data-slot=table-container]")
        .first()
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBe(0);
    expect(await widthOf(headers(page).first())).toBeGreaterThan(100);
  }
});

test("the columns don't move after the first paint: their widths are there with the first rows", async ({ page }) => {
  await page.goto("/#/endpoints");
  const first = firstRow(page);
  await first.waitFor();
  const at = await header(page, "Calls").boundingBox();
  await page.waitForTimeout(500);

  expect(await header(page, "Calls").boundingBox()).toEqual(at);
});
/** What a header cell and a body cell look like: their size, type, color and padding. */
async function looks(page: Page) {
  const table = main(page).getByRole("table").first();
  return {
    head: await table
      .getByRole("columnheader")
      .first()
      .evaluate((cell) => {
        const style = getComputedStyle(cell);
        return {
          height: cell.getBoundingClientRect().height,
          font: [style.fontSize, style.fontWeight, style.letterSpacing, style.textTransform, style.color],
          padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
          background: getComputedStyle(cell.parentElement?.parentElement ?? cell).backgroundColor,
        };
      }),
    body: await table
      .locator("tbody td")
      .first()
      .evaluate((cell) => {
        const style = getComputedStyle(cell);
        return { font: style.fontSize, sides: [style.paddingLeft, style.paddingRight], height: style.paddingTop };
      }),
  };
}

test("every list's header and rows look as the logs table's do, the logs' rows compact", async ({ page }) => {
  await open(page, "/#/logs");
  const logs = await looks(page);
  const rem = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));

  // The logs are a stream read many lines at once: rows of one line with little room around it.
  expect(logs.body.height).toBe(`${0.375 * rem}px`);

  for (const url of ["/#/endpoints", "/#/tasks", "/#/calls/sql", "/#/endpoints?view=calls"]) {
    await open(page, url);

    expect(await looks(page)).toEqual({ ...logs, body: { ...logs.body, height: `${0.75 * rem}px` } });
  }
});

test("a column of numbers is aligned at its end, its name with it", async ({ page }) => {
  await open(page, "/#/endpoints");

  await expect(header(page, "Calls")).toHaveCSS("text-align", "right");
  await expect(firstRow(page).getByRole("cell").nth(1)).toHaveCSS("text-align", "right");
  await expect(header(page, "Endpoint")).toHaveCSS("text-align", "left");
});

test("at 1440 px a list's main column has the room, and its short values are whole", async ({ page }) => {
  await open(page, "/#/tasks");

  expect(await widthOf(header(page, "Task"))).toBeGreaterThanOrEqual(320);
  // Times, counts and badges show in full: what a narrow page cuts first is the main column's name.
  for (const name of ["System", "Runs", "Failed", "Retried", "p95", "Queue wait p95", "Last"]) {
    const index = await header(page, name).evaluate((cell) => (cell as HTMLTableCellElement).cellIndex);
    const cut = await main(page)
      .locator(`tbody tr > td:nth-child(${index + 1})`)
      .evaluateAll((cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth).length);

    expect(cut, name).toBe(0);
  }
});

test("a narrow column's hover buttons sit beside its name, not over it, and the name stays put", async ({ page }) => {
  await page.goto("/#/tasks");
  for (const name of ["Runs", "System"]) {
    const head = page.getByRole("main").getByRole("columnheader", { name, exact: true });
    const text = head.locator("span.truncate");
    const before = await text.boundingBox();

    await head.hover();
    const hide = head.getByRole("button", { name: `Hide the ${name} column` });
    await expect(hide).toHaveCSS("opacity", "1");
    const after = await text.boundingBox();
    const button = await hide.boundingBox();

    if (!(before && after && button)) throw new Error(`no box for ${name}`);
    // The name's near end stays where it was.
    expect(name === "Runs" ? after.x + after.width : after.x).toBeCloseTo(
      name === "Runs" ? before.x + before.width : before.x,
      0,
    );
    // The button is clear of the name.
    expect(button.x + button.width <= after.x || button.x >= after.x + after.width).toBe(true);
  }
});
