// A trace's time in one strip: its own lane in its shares' colours, a long stretch of its code with no recorded
// calls hatched and said, a lane per system it called named by what its marks are, the legend under them. Its
// header says what it called in one line, no tiles. In the call tree a span whose code ran long without calls says
// so in a row of its own, and a transaction says how long it was open and how much of that was SQL.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { HELD_REPORT } from "../seed.ts";

/** The widest of what a locator finds. */
async function widest(found: Locator): Promise<Locator> {
  const widths = await found.evaluateAll((all) => all.map((each) => each.getBoundingClientRect().width));
  return found.nth(widths.indexOf(Math.max(...widths)));
}

/** The trace lane's code time with nothing recorded inside: its share's colour, a click away from its profile. */
const QUIET = ".tp-time-track .tp-stretch[data-quiet]";

type Scope = Page | FrameLocator;

/** The middle of what a locator finds, on the page. */
async function centre(locator: Locator): Promise<[number, number]> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} isn't on the page`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

function row(scope: Scope, kind: string, name: string | RegExp): Locator {
  return scope.locator(`.tp-map-row[data-kind="${kind}"]`).filter({ hasText: name });
}

test("the header says what the trace called in one line, and no tiles", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("GET /account/orders/")}`);

  await expect(page.locator(".tp-trace-facts")).toHaveText(/^· 151 queries \d+ ms · 4 unique · 3 HTTP calls \d+ ms$/);
  await expect(page.locator(".tp-metrics, .tp-metric")).toHaveCount(0);
});

test("the strip names its lanes by what their marks are and says a long stretch with no recorded calls", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=tree`);
  const strip = page.getByRole("region", { name: "Time" });
  const lanes = strip.getByRole("figure", { name: "Timeline" });

  await expect(lanes.locator(".tp-lane-label")).toHaveText(["task", "1 log record"]);
  // One number for the code's own time, the same in the strip and its legend.
  const legend = page.getByRole("list", { name: /^Where the time went/ });
  // One clear line: its code's own time is its share's colour, unlabelled; only a wait is said.
  await expect(lanes.locator(".tp-quiet-label")).toHaveCount(0);
  await expect(legend).toContainText("Database");
  // Said once, on the strip: the legend has no word of it but on hover.
  await expect(legend).not.toContainText("untraced");

  const middle = await centre(await widest(lanes.locator(QUIET)));
  await page.mouse.move(...middle);

  // Its share's numbers, nothing more: a click opens the profile.
  const tip = page.locator(".tp-lane-tip");
  await expect(tip).toContainText(/ · \d+% · \d+ calls?/);
  await expect(tip).not.toContainText("Profile");

  await page.mouse.click(...middle);

  await expect(page.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
});

test("a transaction's time says on hover how long it was open and its SQL; its name says its database once", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=tree`);
  const transaction = row(page, "transaction", "transaction app.sqlite3");

  await expect(transaction.locator(".tp-map-time")).toHaveText("1.6 s");
  await expect(transaction.locator(".tp-map-time")).toHaveAttribute(
    "title",
    /^Open 1\.6 s; SQL inside took \d+ ms, the rest is code running while it's held$/,
  );
  await expect(transaction.locator(".tp-alias")).toHaveCount(0);
  await expect(row(page, "sql", "SELECT order").first().locator(".tp-alias")).toHaveText("app.sqlite3");
  for (const part of await transaction.locator("[data-slot='badge'], .tp-map-text").all()) {
    expect(await part.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  // The code's own time is a row of its own too: a "code" row, its time the strip's.
  const code = page.locator('.tp-map-row[data-kind="code"]');
  await expect(code).toHaveCount(1);
  await expect(code.locator(".tp-map-kind")).toHaveText("code");
  await expect(code.locator(".tp-map-text")).toHaveText("aggregate in reconcile_stock");
  await expect(code.locator(".tp-map-time")).toHaveText("1.6 s");
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

  await expect(frame.getByRole("region", { name: "Time" }).locator(QUIET).first()).toBeVisible();

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
  const logs = page.locator('.tp-map-row[data-kind="log"]');

  // Its warning shows, a lane and a row; its ten info and debug records don't, a note on the spans they were in.
  await expect(logs).toHaveCount(1);
  await expect(logs).toContainText("stock below threshold");
  await expect(lanes.locator(".tp-lane-label")).toHaveText(["task", "1 log record"]);
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await expect(chip).toContainText("11");
  await expect(row(page, "task", HELD_REPORT).locator(".tp-map-logs")).toHaveAccessibleName("1 log");
  await expect(row(page, "transaction", "transaction app.sqlite3").locator(".tp-map-logs")).toHaveAccessibleName(
    "9 logs",
  );

  await row(page, "transaction", "transaction app.sqlite3").locator(".tp-map-logs").click();

  await expect(logs).toHaveCount(11);
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(lanes.locator(".tp-lane-label")).toHaveText(["task", "11 log records"]);
  await expect(page).toHaveURL(/[?&]logs=all/);
  await expect(page.locator(".tp-map-logs")).toHaveCount(0);

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

/** The agent's answer for the trace's app: whether it profiles on request. */
async function profiles(page: Page, yes: boolean): Promise<void> {
  await page.route("**/api/capabilities**", (route) =>
    // biome-ignore lint/style/useNamingConvention: the API's wire format.
    route.fulfill({ json: { explain: false, users: false, profile: yes, request: true, live_tasks: false } }),
  );
}

async function openSales(page: Page): Promise<FrameLocator> {
  await openApp(page, {
    one: { status: 202, trace: await traceId("POST /api/reports/sales"), queries: 0, totalMs: 42 },
  });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  return frame;
}

test("with no profile, even where the app profiles, the strip's code time is a plain stretch: nothing of Profile", async ({
  page,
}) => {
  await profiles(page, true);
  await page.goto(`/#/t/${await traceId("POST /api/reports/sales")}?tab=tree`);
  await page.mouse.move(...(await centre(page.locator(QUIET).first())));
  const tip = page.locator(".tp-lane-tip");

  await expect(tip).toBeVisible();
  await expect(tip).not.toContainText("Profile");

  const frame = await openSales(page);

  // Profile is turned on in the panel's toolbar only: nothing on the trace does it.
  await expect(frame.getByRole("list", { name: /^Where the time went/ })).not.toContainText("Profile");
  await expect(frame.locator(".tp-map-flame")).toHaveCount(0);

  await page.mouse.move(...(await centre(frame.locator(QUIET).first())));
  const panelTip = frame.locator(".tp-lane-tip");

  await expect(panelTip).toBeVisible();
  await expect(panelTip).not.toContainText("Profile");
});

test("an app that can't profile is offered no Profile: no hint, no link, on the page or in the panel", async ({
  page,
}) => {
  await profiles(page, false);
  await page.goto(`/#/t/${await traceId("POST /api/reports/sales")}?tab=tree`);
  await page.mouse.move(...(await centre(page.locator(QUIET).first())));
  const tip = page.locator(".tp-lane-tip");

  await expect(tip).toBeVisible();
  await expect(tip).not.toContainText("Profile");

  const frame = await openSales(page);

  await expect(frame.locator(QUIET).first()).toBeVisible();
  await expect(frame.getByRole("button", { name: /^Turn on Profile/ })).toHaveCount(0);
});

test("an app the agent doesn't know (not connected) is offered no Profile either", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("POST /api/reports/sales")}?tab=tree`);
  await page.mouse.move(...(await centre(page.locator(QUIET).first())));
  const tip = page.locator(".tp-lane-tip");

  await expect(tip).toBeVisible();
  await expect(tip).not.toContainText("Profile");
});

test("the tree's code row leads to the profile: its flame, a click opens it, in the panel too", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=tree`);
  const code = page.locator('.tp-map-row[data-kind="code"]');

  await expect(code.locator(".tp-map-flame")).toBeVisible();
  await expect(code.locator(".tp-map-text")).toHaveText("aggregate in reconcile_stock");

  await code.hover();

  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await code.click();

  await expect(page.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");

  await openApp(page, { one: { status: 200, trace: await traceId(HELD_REPORT), queries: 139, totalMs: 1600 } });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await frame.locator('.tp-map-row[data-kind="code"]').click();

  await expect(frame.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
});

test("with no profile, the tree's code row has no flame, and a click on it picks no range", async ({ page }) => {
  await profiles(page, true);
  await page.goto(`/#/t/${await traceId("POST /api/reports/sales")}?tab=tree`);
  const code = page.locator('.tp-map-row[data-kind="code"]');

  await expect(code.locator(".tp-map-time")).toHaveText("42 ms");
  await expect(code.locator(".tp-map-text")).toHaveText("untraced code");
  await expect(code.locator(".tp-map-flame")).toHaveCount(0);

  await code.locator(".tp-map-text").hover();

  await expect(page.getByRole("tooltip")).toContainText("Untraced code");
  await expect(page.getByRole("tooltip")).toContainText("profile the request");

  await code.click();
  await page.mouse.click(...(await centre(page.locator(QUIET).first())));

  await expect(page).not.toHaveURL(/[?&]range=/);
  await expect(page.getByRole("button", { name: /^Time / })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Call tree" })).toHaveAttribute("aria-selected", "true");

  const frame = await openSales(page);
  await frame.locator('.tp-map-row[data-kind="code"] .tp-map-text').hover();

  await expect(frame.getByRole("tooltip")).toContainText("Untraced code");
});

test("an app that can't profile: the tree's code row is a plain row, nothing offered", async ({ page }) => {
  await profiles(page, false);
  await page.goto(`/#/t/${await traceId("POST /api/reports/sales")}?tab=tree`);
  const code = page.locator('.tp-map-row[data-kind="code"]');

  await expect(code).toHaveText(/untraced code\s*42 ms$/);
  await expect(code.locator(".tp-map-flame")).toHaveCount(0);

  await code.hover();

  await expect(page.getByRole("tooltip")).toHaveCount(0);

  const frame = await openSales(page);

  await expect(frame.locator('.tp-map-row[data-kind="code"]')).not.toContainText("Profile");
});

/** A task of `duration` µs (a JVM's, 3 ms), stored under `id`: one span, nothing else. */
async function storeTask(id: string, duration: number): Promise<void> {
  const start = Date.now() * 1000 - 7 * 3_600_000_000;
  const root = { id: "r", ["parent_id"]: null, kind: "task.run", name: "warm-cache", start, duration, status: "ok" };
  const doc = {
    id,
    kind: "task",
    name: "warm-cache",
    start,
    duration,
    status: "ok",
    attrs: { "service.name": "orders", "task.name": "warm-cache", "telemetry.sdk.language": "java" },
    spans: [{ ...root, attrs: {} }],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${id}`)).status).toBe(200);
}

for (const [duration, id, said] of [
  [2_987, "01M4WA1TS0000000000000AX01", ["0", "0.5 ms", "1.0 ms", "1.5 ms", "2.0 ms", "2.5 ms"]],
  [136_776, "01M4WA1TS0000000000000AX02", ["0", "25 ms", "50 ms", "75 ms", "100 ms", "125 ms"]],
] as const) {
  test(`the axis of a ${duration} µs trace counts in round steps, evenly spaced, no two the same`, async ({ page }) => {
    await storeTask(id, duration);
    await page.goto(`/#/t/${id}?tab=tree`);
    const ticks = page.locator(".tp-timeline-axis span:not(.tp-timeline-unit)");

    await expect(ticks).toHaveText([...said]);
    // Each where its time is: the same distance apart, the first at the axis' start.
    const lefts = await ticks.evaluateAll((spans) =>
      spans.map((span) => Number.parseFloat((span as HTMLElement).style.left)),
    );
    const gaps = lefts.slice(1).map((left, n) => left - (lefts[n] ?? 0));
    expect(lefts[0]).toBe(0);
    for (const gap of gaps) expect(Math.abs(gap - (gaps[0] ?? 0))).toBeLessThan(0.01);
  });
}
