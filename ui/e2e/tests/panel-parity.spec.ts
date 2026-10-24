// The panel shows what the console's trace page shows: the Request tab its facts, no tiles and no lanes (the time
// strip is the Call tree tab's), and a request's row counts its findings as its Issues tab does.
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("the panel's Request tab has no tiles and no lanes, its Call tree tab the strip, and its row counts the Issues tab's findings", async ({
  page,
}) => {
  await openApp(page, { home: { status: 200, trace: await traceId("GET /"), queries: 151, totalMs: 28 } });
  await page.getByRole("button", { name: "Load home" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Request/ }).click();
  const tab = frame.getByRole("tabpanel").first();

  // No tiles: the tabs carry the duration and the queries; the time is the Call tree tab's.
  await expect(tab).toContainText("GET");
  await expect(tab.locator(".dt-metric-label")).toHaveCount(0);
  await expect(tab.getByRole("figure", { name: "Timeline" })).toHaveCount(0);

  await frame.getByRole("tab", { name: /^Call tree/ }).click();

  await expect(frame.getByRole("tabpanel").first().getByRole("figure", { name: "Timeline" })).toBeVisible();

  const issues = frame.getByRole("tab", { name: /^Issues/ });
  const row = frame.getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button").first();

  await expect(issues).toContainText("3");
  await expect(row.locator('[data-slot="badge"]').last()).toHaveText("3");
});

test("in the panel too, the first tab has no lanes and the call tree has its own lane and its tasks'", async ({
  page,
}) => {
  await openApp(page, {
    feed: { status: 200, trace: await traceId("shop.tasks.parse_feed"), queries: 0, totalMs: 42 },
  });
  await page.getByRole("button", { name: "Load feed" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tablist").first().getByRole("tab").first().click();

  await expect(frame.getByRole("tabpanel").first()).toContainText("Task ID");
  await expect(frame.getByRole("figure", { name: "Timeline" })).toHaveCount(0);

  await frame.getByRole("tab", { name: /^Call tree/ }).click();

  await expect(frame.locator(".dt-map-head")).toBeVisible();
  await expect(frame.getByRole("figure", { name: "Timeline" }).locator(".dt-lane-label")).toHaveText([
    "task",
    "1 task enqueued",
  ]);
});
