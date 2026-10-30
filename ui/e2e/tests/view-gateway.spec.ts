// A browser's view whose calls went through a GraphQL gateway (one trace per operation, over OTLP), in the panel's
// list: the gateway's traces in a run (×N) only when they are the same operation, each named by its operation as a
// row outside a run is; and every row's numbers counted as the pill and the tabs count them: the view's row its
// whole chain, an app's or a run's row everything under it, a trace with nothing under it its own.
import type { Page } from "@playwright/test";
import { openApp, panel, pill } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { gatewayView } from "../gateway.ts";

const FIVE = ["query Features", "query Profile", "query Roles", "query Notifications", "query Items"];

/** The panel open on the seeded view, its list's rows. */
async function listed(page: Page, view: string) {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await openApp(page, {}, { recording: true, view });
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  await expect(list.locator('.dt-request-row[data-chain="app"]').first()).toBeVisible();
  // What the last operation called, opened down to the service.
  const folded = list.locator('.dt-request-row[data-chain="trace"][aria-expanded="false"]');
  for (let opened = 0; opened < 2; opened += 1) {
    await expect(folded).toHaveCount(1);
    await folded.locator("[data-toggle]").click();
  }
  await expect(folded).toHaveCount(0);
  return {
    list,
    view: list.locator('.dt-request-row[data-kind="page"]').first(),
    apps: list.locator('.dt-request-row[data-chain="app"]'),
    runs: list.locator('.dt-request-row[data-chain="run"]'),
    traces: list.locator('.dt-request-row[data-chain="trace"]'),
  };
}

test("different operations through one gateway are rows of their own, each named by its operation", async ({
  page,
}) => {
  const seeded = await gatewayView(1, FIVE);
  const { apps, runs, traces } = await listed(page, seeded.view);

  await expect(apps.first().locator(".dt-app-chip")).toHaveText("gateway");
  await expect(apps.first().locator(".dt-map-times")).toHaveText("×5");
  await expect(runs).toHaveCount(0);
  // The gateway's five, then the subgraph's and the service's under the last.
  await expect(traces.locator(".dt-request-path")).toHaveText([...FIVE, "query Items", "/items"]);
  for (const row of (await traces.all()).slice(0, 5)) await expect(row.locator(".dt-kind")).toHaveText(/^gql$/i);
});

test("one operation three times in a row is a run; its rows look as the same row outside a run", async ({ page }) => {
  const seeded = await gatewayView(2, [
    "query Roles",
    "query Roles",
    "query Roles",
    "query Profile",
    "query Roles",
    "query Items",
  ]);
  const { runs, traces } = await listed(page, seeded.view);

  await expect(runs).toHaveCount(1);
  await expect(runs.locator(".dt-map-times")).toHaveText("×3");
  await expect(runs.locator(".dt-kind")).toHaveText(/^gql$/i);
  await expect(runs.locator(".dt-request-path")).toHaveText("query Roles");
  await expect(traces.locator(".dt-request-path")).toHaveText([
    "query Roles",
    "query Roles",
    "query Roles",
    "query Profile",
    "query Roles",
    "query Items",
    "query Items",
    "/items",
  ]);

  // A run's row and the same operation's row after it: the same badge, name, status and numbers.
  const inRun = traces.nth(0);
  const outside = traces.nth(4);
  const look = async (row: typeof inRun) => ({
    badge: await row.locator(".dt-kind").textContent(),
    name: await row.locator(".dt-request-path").textContent(),
    meta: await row.locator(".dt-request-meta").innerText(),
  });

  expect(await look(inRun)).toEqual(await look(outside));
  expect(await look(inRun)).toEqual({
    badge: "gql",
    name: "query Roles",
    meta: expect.stringMatching(/^800 ms\s+0\s+1$/),
  });
});

test("the view's row counts its chain as the pill and the tabs do; a row with rows under it counts all of them", async ({
  page,
}) => {
  const seeded = await gatewayView(3, FIVE);
  const { view, apps, traces } = await listed(page, seeded.view);
  const queries = (row: typeof view) => row.locator(".dt-request-queries-n");
  const issues = (row: typeof view) => row.locator(".dt-request-chips");

  // The service's three queries; four issues: the same slow call in four gateway traces is one, as the tabs say.
  await expect(pill(page).locator(".seg").nth(2)).toHaveText("3");
  await expect(pill(page)).toHaveAccessibleName(/3 queries, 11 HTTP calls, 4 issues down its calls/);
  await expect(queries(view)).toHaveText("3");
  await expect(issues(view)).toHaveText("4");

  await view.click();

  await expect(panel(page).getByRole("tab", { name: /^DB/ })).toContainText("3");
  await expect(panel(page).getByRole("tab", { name: /^Issues/ })).toContainText("4");

  // The gateway's row: all five and what is under them; the queries of the rows under it add up to its.
  await expect(queries(apps.nth(0))).toHaveText("3");
  await expect(issues(apps.nth(0))).toHaveText("4");
  await expect(queries(traces)).toHaveText(["0", "0", "0", "0", "3", "3", "3"]);
  await expect(issues(traces)).toHaveText(["1", "2", "1", "1", "2", "2", "2"]);
  await expect(queries(apps)).toHaveText(["3", "3", "3"]);

  // The app's row opens its tabs under it: they count what the row says.
  await apps.nth(0).click();

  await expect(panel(page).locator(".dt-scope-chip")).toContainText("Under gateway");
  await expect(panel(page).getByRole("tab", { name: /^Issues/ })).toContainText("4");
  await expect(panel(page).getByRole("tab", { name: /^DB/ })).toContainText("3");
});

test("a view's chain folds under its row and opens again; its call tree and first tab call it a view", async ({
  page,
}) => {
  const seeded = await gatewayView(4, FIVE);
  const { view, apps } = await listed(page, seeded.view);

  await expect(view).toHaveAttribute("aria-expanded", "true");
  await view.locator("[data-toggle]").click();

  await expect(view).toHaveAttribute("aria-expanded", "false");
  await expect(apps).toHaveCount(0);

  await view.locator("[data-toggle]").click();

  await expect(apps.first()).toBeVisible();
  // The same name as the list's row: VIEW, not PAGE.
  const frame = panel(page);
  await expect(frame.getByRole("tab", { name: /^View/ })).toBeVisible();
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await expect(frame.locator(".dt-map-row[data-root] .dt-kind").first()).toHaveText(/^view$/i);
});
