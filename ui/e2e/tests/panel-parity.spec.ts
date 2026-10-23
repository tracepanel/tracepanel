// The panel shows what the console's trace page shows: the Request tab has the tiles and the lanes the page has
// above its tabs, and a request's row counts its findings as its Issues tab does.
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("the panel's Request tab has the page's tiles and lanes, and its row counts the Issues tab's findings", async ({
  page,
}) => {
  await openApp(page, { home: { status: 200, trace: await traceId("GET /"), queries: 151, totalMs: 28 } });
  await page.getByRole("button", { name: "Load home" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Request/ }).click();
  const tab = frame.getByRole("tabpanel");

  await expect(tab.locator(".dt-metric-label")).toHaveText(["Duration", "Database"]);
  await expect(tab.getByRole("figure", { name: "Timeline" })).toBeVisible();

  const issues = frame.getByRole("tab", { name: /^Issues/ });
  const row = frame.getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button").first();

  await expect(issues).toContainText("3");
  await expect(row.locator('[data-slot="badge"]').last()).toHaveText("3");
});
