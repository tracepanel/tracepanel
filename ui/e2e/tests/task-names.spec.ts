// A task's name wherever it shows: cut at its start when it doesn't fit, so the handlers of one consumer, alike but
// for their ends, tell apart; whole on hover. One look in every list, heading, menu and the panel.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { HANDLERS } from "../seed.ts";

const [REGENERATE, PURGE, NOTIFY] = HANDLERS as [string, string, string];

// Narrower than the other tests' window: the names are cut wherever they show, whatever the fonts of the machine.
test.use({ viewport: { width: 1100, height: 900 } });

/** Every place in `scope` that names `name`: whole on hover, cut at its start; `cut` when it doesn't fit there. */
async function shownByItsEnd(scope: Page | Locator | FrameLocator, name: string, cut = true): Promise<void> {
  const names = scope.getByTitle(name, { exact: true });
  await expect(names.first()).toBeVisible();
  for (const element of await names.all()) {
    await expect(element).toHaveCSS("direction", "rtl");
    await expect(element).toHaveText(name);
  }
  if (cut) expect(await names.first().evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
}

test("the Tasks page: By task, its Overview's lists and All runs", async ({ page }) => {
  await page.goto("/#/tasks?view=overview");

  await shownByItsEnd(page.getByRole("table"), REGENERATE);
  await shownByItsEnd(page.getByRole("table"), PURGE);
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

  await shownByItsEnd(page, `enqueue ${REGENERATE}`);
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

test("the panel's list: a task's run as the console lists it, its kind and its name", async ({ page }) => {
  await openApp(page, { regenerate: { status: 200, trace: await traceId(REGENERATE), queries: 0, totalMs: 42 } });
  await page.getByRole("button", { name: "Load regenerate" }).click();
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });

  // Its kind's badge, not its name as a method.
  await expect(list.getByRole("button").first()).toContainText(`task${REGENERATE}`);
  await shownByItsEnd(list, REGENERATE);
});
