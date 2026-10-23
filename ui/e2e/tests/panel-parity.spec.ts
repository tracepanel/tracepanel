// The panel shows what the console's trace page shows: the Request tab has the lanes the page has (not its tiles)
// above its tabs, and a request's row counts its findings as its Issues tab does.
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("the panel's Request tab has the page's lanes, not its tiles, and its row counts the Issues tab's findings", async ({
  page,
}) => {
  await openApp(page, { home: { status: 200, trace: await traceId("GET /"), queries: 151, totalMs: 28 } });
  await page.getByRole("button", { name: "Load home" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Request/ }).click();
  const tab = frame.getByRole("tabpanel");

  // No tiles: the tabs carry the duration and the queries.
  await expect(tab.locator(".dt-metric-label")).toHaveCount(0);
  await expect(tab.getByRole("figure", { name: "Timeline" })).toBeVisible();

  const issues = frame.getByRole("tab", { name: /^Issues/ });
  const row = frame.getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button").first();

  await expect(issues).toContainText("3");
  await expect(row.locator('[data-slot="badge"]').last()).toHaveText("3");
});

test("in the panel too, a trace with nothing but its own lane has no lanes", async ({ page }) => {
  await openApp(page, {
    feed: { status: 200, trace: await traceId("shop.tasks.parse_feed"), queries: 0, totalMs: 42 },
  });
  await page.getByRole("button", { name: "Load feed" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tablist").first().getByRole("tab").first().click();

  await expect(frame.getByRole("tabpanel").first()).toContainText("Task ID");
  await expect(frame.getByRole("figure", { name: "Timeline" })).toHaveCount(0);
  await expect(frame.locator(".dt-panel-overview")).toBeHidden();
});
