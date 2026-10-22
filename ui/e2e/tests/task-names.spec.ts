// A task's name wherever it shows: cut at its start when it doesn't fit, so the handlers of one consumer, alike but
// for their ends, tell apart; whole on hover. One look in every list, heading, menu and the panel.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { HANDLERS } from "../seed.ts";

const [REGENERATE, PURGE, NOTIFY] = HANDLERS as [string, string, string];

// Narrower than the other tests' window: the names are cut wherever they show, whatever the fonts of the machine.
test.use({ viewport: { width: 1100, height: 900 } });

/** Where an element's text starts on the screen, and where its box does. */
function edges(element: Element): { text: number; box: number } {
  const range = document.createRange();
  range.selectNodeContents(element);
  return { text: range.getBoundingClientRect().left, box: element.getBoundingClientRect().left };
}

/**
 * Every place in `scope` that names `name`: whole on hover, and its end in sight, after a "…" when cut; its text
 * starts at its box's left edge, cut or not. `cut` when it must be cut there.
 */
async function shownByItsEnd(scope: Page | Locator | FrameLocator, name: string, cut = true): Promise<void> {
  const names = scope.getByTitle(name, { exact: true });
  await expect(names.first()).toBeVisible();
  for (const element of await names.all()) {
    const text = (await element.textContent()) ?? "";
    expect(text === name || (text.startsWith("…") && name.endsWith(text.slice(1)))).toBe(true);
    const { text: left, box } = await element.evaluate(edges);
    expect(Math.abs(left - box)).toBeLessThan(0.5);
  }
  if (cut) await expect(names.first()).toHaveText(/^…/);
}

/** The left edge of the text named `name` in `scope`. */
async function textLeft(scope: Page | Locator | FrameLocator, name: string): Promise<number> {
  return (await scope.getByTitle(name, { exact: true }).first().evaluate(edges)).text;
}

test("the Tasks page: By task, its Overview's lists and All runs", async ({ page }) => {
  await page.goto("/#/tasks?view=overview");

  const table = page.getByRole("table");
  await shownByItsEnd(table, REGENERATE);
  await shownByItsEnd(table, PURGE);
  // A cut name starts where a whole one does.
  await shownByItsEnd(table, "shop.tasks.send_receipt", false);
  expect(await textLeft(table, REGENERATE)).toBeCloseTo(await textLeft(table, "shop.tasks.send_receipt"), 0);
  // In the table, under Slowest and under Failing.
  await expect(page.getByTitle(NOTIFY, { exact: true })).toHaveCount(3);
  await shownByItsEnd(page, NOTIFY);

  await page.goto("/#/tasks?q=ThumbnailConsumer");

  await shownByItsEnd(page.getByRole("table"), REGENERATE);
});

test("a task's page: its heading and its crumb", async ({ page }) => {
  await page.goto(`/#/group/tasks/${encodeURIComponent(REGENERATE)}`);

  await shownByItsEnd(page.getByRole("heading", { level: 1 }), REGENERATE);
  await shownByItsEnd(page.getByRole("navigation", { name: "Breadcrumb" }), REGENERATE, false);
});

test("a run's trace: its heading and its row in the call tree", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(REGENERATE)}`);

  await shownByItsEnd(page.getByRole("heading", { level: 2 }), REGENERATE);
  await shownByItsEnd(page.getByRole("main").getByRole("button", { name: /^task(?!\.)/i }), REGENERATE, false);
});

test("the request that sent them: the call tree and the tasks it enqueued", async ({ page }) => {
  const request = await traceId("POST /api/media/rebuild");
  await page.goto(`/#/t/${request}`);

  // Sending it: "enqueue " whole, then the task's name, cut.
  const sent = page.getByRole("button", { name: /^task\.enqueue/i }).first();
  await expect(sent).toContainText(/enqueue …/);
  await shownByItsEnd(sent, REGENERATE);
  await shownByItsEnd(page, PURGE, false);

  await page.goto(`/#/t/${request}?tab=request`);

  for (const name of HANDLERS) await shownByItsEnd(page, name, false);
});

test("⌘K and the Task filter", async ({ page }) => {
  await page.goto("/#/tasks");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search traces" });
  await palette.getByRole("combobox").fill("ThumbnailConsumer");

  await shownByItsEnd(palette, NOTIFY);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Task", exact: true }).click();

  await shownByItsEnd(page.getByRole("dialog"), REGENERATE);
});

test("the panel, docked to the right: the call tree and the tasks the request enqueued", async ({ page }) => {
  const request = await traceId("POST /api/media/rebuild");
  await openApp(page, { rebuild: { status: 202, trace: request, queries: 0, totalMs: 42 } });
  await page.getByRole("button", { name: "Load rebuild" }).click();
  await pill(page).click();
  await panel(page).getByRole("button", { name: "Dock to right" }).click();
  await panel(page)
    .getByRole("tab", { name: /Call tree/ })
    .click();

  for (const name of HANDLERS) await shownByItsEnd(panel(page).getByRole("button", { name: /^task(?!\.)/i }), name);

  await panel(page)
    .getByRole("tab", { name: /Request/ })
    .click();

  for (const name of HANDLERS) await shownByItsEnd(panel(page), name);
});

test("Now: the tasks in flight", async ({ page }) => {
  const now = Date.now() * 1000;
  // biome-ignore-start lint/style/useNamingConvention: the agent's answer, its field names the wire format.
  const tasks = HANDLERS.map((name, n) => ({
    id: `now-${n}`,
    system: "channels",
    name,
    service: "shop",
    state: "running",
    queue: "default",
    worker: "worker-1",
    enqueued_at: now,
    started_at: now,
    retries: 0,
    args: null,
    kwargs: null,
    error: null,
    enqueued_by: null,
  }));
  // biome-ignore-end lint/style/useNamingConvention: the agent's answer, its field names the wire format.
  await page.route("**/api/tasks/live*", (route) => route.fulfill({ json: { now, tasks, workers: [] } }));
  await page.goto("/#/tasks");
  const inFlight = page.getByRole("region", { name: "Now" });
  await inFlight.getByRole("button", { expanded: false }).click();

  for (const name of HANDLERS) await shownByItsEnd(inFlight.getByRole("table"), name);
});

test("the panel's list: a task's run as the console lists it, its time in a request's column", async ({ page }) => {
  await openApp(page, {
    regenerate: { status: 200, trace: await traceId(REGENERATE), queries: 0, totalMs: 42 },
    rebuild: { status: 202, trace: await traceId("POST /api/media/rebuild"), queries: 0, totalMs: 42 },
  });
  await page.getByRole("button", { name: "Load regenerate" }).click();
  await page.getByRole("button", { name: "Load rebuild" }).click();
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  const task = list.getByRole("button").filter({ hasText: /^task/ });
  const request = list.getByRole("button").filter({ hasText: "/api/media/rebuild" });

  // Its kind's badge, not its name as a method.
  await expect(task).toContainText(/^task…/);
  await shownByItsEnd(list, REGENERATE);

  // No status of its own, its time and queries still under a request's.
  const time = async (row: Locator) => (await row.getByText("42 ms", { exact: true }).boundingBox())?.x;
  expect(await time(task)).toBeCloseTo((await time(request)) ?? Number.NaN, 0);
});
