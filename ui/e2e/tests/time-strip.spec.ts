// A trace's time in one strip: its own lane in its shares' colours, a long stretch of its code with no recorded
// calls hatched and said, a lane per system it called named by what its marks are, the legend under them. Its
// header says what it called in one line, no tiles. In the call tree a span whose code ran long without calls says
// so in a row of its own, and a transaction says how long it was open and how much of that was SQL.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { HELD_REPORT } from "../seed.ts";

type Scope = Page | FrameLocator;

/** The middle of what a locator finds, on the page. */
async function centre(locator: Locator): Promise<[number, number]> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} isn't on the page`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

function row(scope: Scope, kind: string, name: string | RegExp): Locator {
  return scope.locator(`.dt-map-row[data-kind="${kind}"]`).filter({ hasText: name });
}

test("the header says what the trace called in one line, and no tiles", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("GET /account/orders/")}`);

  await expect(page.locator(".dt-trace-facts")).toHaveText(/^· 151 queries \d+ ms · 4 unique · 3 HTTP calls \d+ ms$/);
  await expect(page.locator(".dt-metrics, .dt-metric")).toHaveCount(0);
});

test("the strip names its lanes by what their marks are and says a long stretch with no recorded calls", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=tree`);
  const strip = page.getByRole("region", { name: "Time" });
  const lanes = strip.getByRole("figure", { name: "Timeline" });

  await expect(lanes.locator(".dt-lane-label")).toHaveText(["task", "139 queries", "1 log record"]);
  // One number for the code's own time, the same in the strip and its legend.
  const legend = page.getByRole("list", { name: /^Where the time went/ });
  await expect(lanes.locator(".dt-quiet-label")).toHaveText("your code · 1.6 s");
  await expect(legend).toContainText("Database");
  await expect(legend.locator(".dt-share-quiet")).toHaveText("of it 1.6 s unrecorded");

  const middle = await centre(lanes.locator(".dt-quiet-said"));
  await page.mouse.move(...middle);

  // Its profile says where its own code was, over the whole trace; a click opens it.
  const tip = page.getByRole("tooltip").filter({ hasText: "nothing recorded inside" });
  await expect(tip).toContainText("Of it 1.6 s with nothing recorded inside");
  await expect(tip).toContainText("over the whole trace's profile");
  await expect(tip).toContainText("aggregate 69% · render_csv 21% · reconcile_stock 8%");

  await page.mouse.click(...middle);

  await expect(page.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
});

test("a transaction's time says on hover how long it was open and its SQL; its name says its database once", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=tree`);
  const transaction = row(page, "transaction", "transaction app.sqlite3");

  await expect(transaction.locator(".dt-map-time")).toHaveText("1.6 s");
  await expect(transaction.locator(".dt-map-time")).toHaveAttribute(
    "title",
    /^Open 1\.6 s; SQL inside took \d+ ms, the rest is code running while it's held$/,
  );
  await expect(transaction.locator(".dt-alias")).toHaveCount(0);
  await expect(row(page, "sql", "SELECT order").first().locator(".dt-alias")).toHaveText("app.sqlite3");
  for (const part of await transaction.locator("[data-slot='badge'], .dt-map-text").all()) {
    expect(await part.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  // The code's own time is the strip's to say, not a row of the tree.
  await expect(page.locator('.dt-map-row[data-kind="quiet"]')).toHaveCount(0);
});

test("the strip is the Call tree tab's only, on the page and in the panel; the first tab has none", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=request`);

  await expect(page.getByRole("region", { name: "Time" })).toHaveCount(0);

  await page.getByRole("tab", { name: /^Call tree/ }).click();

  await expect(page.getByRole("tabpanel").getByRole("region", { name: "Time" })).toBeVisible();

  await openApp(page, { held: { status: 200, trace: await traceId(HELD_REPORT), queries: 139, totalMs: 1600 } });
  await page.getByRole("button", { name: "Load held" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();

  await expect(frame.getByRole("region", { name: "Time" }).locator(".dt-quiet-label")).toHaveText("your code · 1.6 s");

  await frame.getByRole("tablist").first().getByRole("tab").first().click();

  await expect(frame.getByRole("tabpanel").first()).toContainText("Task ID");
  await expect(frame.getByRole("region", { name: "Time" })).toHaveCount(0);
});

test("only warnings and worse show by default; the Logs chip, or a row's note, shows every record", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=tree`);
  const legend = page.getByRole("list", { name: /^Where the time went/ });
  const chip = legend.getByRole("button", { name: /^Logs/ });
  const lanes = page.getByRole("figure", { name: "Timeline" });
  const logs = page.locator('.dt-map-row[data-kind="log"]');

  // Its warning shows, a lane and a row; its ten info and debug records don't, a note on the spans they were in.
  await expect(logs).toHaveCount(1);
  await expect(logs).toContainText("stock below threshold");
  await expect(lanes.locator(".dt-lane-label")).toHaveText(["task", "139 queries", "1 log record"]);
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await expect(chip).toContainText("11");
  await expect(row(page, "task", HELD_REPORT).locator(".dt-map-logs")).toHaveText("1 log");
  await expect(row(page, "transaction", "transaction app.sqlite3").locator(".dt-map-logs")).toHaveText("9 logs");

  await row(page, "transaction", "transaction app.sqlite3").locator(".dt-map-logs").click();

  await expect(logs).toHaveCount(11);
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(lanes.locator(".dt-lane-label")).toHaveText(["task", "139 queries", "11 log records"]);
  await expect(page).toHaveURL(/[?&]logs=all/);
  await expect(page.locator(".dt-map-logs")).toHaveCount(0);

  await chip.click();

  await expect(logs).toHaveCount(1);
  await expect(page).not.toHaveURL(/logs=/);

  // The Logs tab has every record, as it always had.
  await page.getByRole("tab", { name: /^Logs/ }).click();

  await expect(page.getByRole("tabpanel")).toContainText("stock reconciled");
});

test("a request with no view recorded: its own time is its code's", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("POST /api/reports/sales")}?tab=tree`);
  const legend = page.getByRole("list", { name: /^Where the time went/ });

  await expect(legend.locator('[data-category="code"]')).toContainText(/Your code\s*\d+ ms\s*100%/);
  await expect(legend.locator('[data-category="django"]')).toHaveCount(0);

  await page.goto(`/#/t/${await traceId("GET /account/orders/")}?tab=tree`);

  await expect(legend.locator('[data-category="django"]')).toContainText("Framework & middleware");
});

test("with no profile, the code's own time says how to get one; in the panel the legend turns its Profile on", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("POST /api/reports/sales")}?tab=tree`);
  const said = page.locator(".dt-quiet-said");
  await page.mouse.move(...(await centre(said)));

  await expect(page.getByRole("tooltip").filter({ hasText: "nothing recorded inside" })).toContainText(
    "To see what ran here, turn on Profile and run it again: the panel's Profile toggle, or an X-Tracepanel-Profile: 1 header.",
  );

  // An app that profiles on request: the panel offers its toggle.
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ json: { explain: false, users: false, profile: true, request: true } }),
  );
  await openApp(page, {
    one: { status: 202, trace: await traceId("POST /api/reports/sales"), queries: 0, totalMs: 42 },
  });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  const turnOn = frame.getByRole("button", { name: "Turn on Profile to see what ran" });

  await turnOn.click();

  await expect(frame.getByRole("button", { name: "Profile is on: run it again" })).toBeDisabled();
  await expect(frame.getByRole("button", { name: "Profiling is on" })).toHaveAttribute("aria-pressed", "true");
  expect((await page.context().cookies()).find((cookie) => cookie.name === "tracepanel_profile")?.value).toBe("1");
});

test("in the panel, an app that doesn't profile on request offers no Profile from the strip", async ({ page }) => {
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ json: { explain: false, users: false, profile: false, request: true } }),
  );
  await openApp(page, {
    one: { status: 202, trace: await traceId("POST /api/reports/sales"), queries: 0, totalMs: 42 },
  });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();

  await expect(frame.locator(".dt-quiet-said")).toBeVisible();
  await expect(frame.getByRole("button", { name: /^Turn on Profile/ })).toHaveCount(0);
});
