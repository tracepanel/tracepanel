// A browser's view whose calls went through a GraphQL gateway (one trace per operation, over OTLP), in the panel's
// list: each call a row of its own under the view, as it was in flight, named by its operation (the same operation
// again is a row again, never folded into a run: the view made each call), what each called under it; and every
// row's numbers counted as the pill and the tabs count them: the view's row its whole chain, a call's row everything
// under it.
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
  const calls = list.locator('.dt-request-row[data-call="trace"]');
  await expect(calls.first()).toBeVisible();
  // What the last operation called, opened down to the service.
  const folded = list.locator('.dt-request-row:is([data-call="trace"], [data-chain="trace"])[aria-expanded="false"]');
  for (let opened = 0; opened < 2; opened += 1) {
    await expect(folded).toHaveCount(1);
    await folded.locator("[data-toggle]").click();
  }
  await expect(folded).toHaveCount(0);
  return {
    list,
    view: list.locator('.dt-request-row[data-kind="page"]').first(),
    calls,
    group: list.locator('.dt-request-row[data-call="group"]'),
    apps: list.locator('.dt-request-row[data-chain="app"]'),
    runs: list.locator('.dt-request-row[data-chain="run"]'),
    traces: list.locator('.dt-request-row[data-chain="trace"]'),
  };
}

test("different operations through one gateway are rows of their own, each named by its operation", async ({
  page,
}) => {
  const seeded = await gatewayView(1, FIVE);
  const { calls, group, apps, runs, traces } = await listed(page, seeded.view);

  // The gateway's five, a row each under the gateway's row.
  await expect(group.locator(".dt-app-chip")).toHaveText("gateway");
  await expect(group.locator(".dt-map-times")).toHaveText("×5");
  await expect(calls.locator(".dt-request-path")).toHaveText(FIVE);
  for (const row of await calls.all()) await expect(row.locator(".dt-kind")).toHaveText(/^gql$/i);
  for (const row of await calls.all()) await expect(row).toHaveAttribute("data-depth", "2");
  await expect(runs).toHaveCount(0);
  // The subgraph's and the service's under the last.
  await expect(apps.locator(".dt-app-chip")).toHaveText(["subgraph", "shop"]);
  await expect(traces.locator(".dt-request-path")).toHaveText(["query Items", "/items"]);
});

test("one operation three times in a row is three rows, each as the view made it, all alike", async ({ page }) => {
  const seeded = await gatewayView(2, [
    "query Roles",
    "query Roles",
    "query Roles",
    "query Profile",
    "query Roles",
    "query Items",
  ]);
  const { calls, runs } = await listed(page, seeded.view);

  await expect(runs).toHaveCount(0);
  await expect(calls.locator(".dt-request-path")).toHaveText([
    "query Roles",
    "query Roles",
    "query Roles",
    "query Profile",
    "query Roles",
    "query Items",
  ]);

  // The first and the same operation's row later: the same badge, name, status and numbers.
  const inRun = calls.nth(0);
  const outside = calls.nth(4);
  const look = async (row: typeof inRun) => ({
    badge: await row.locator(".dt-kind").textContent(),
    name: await row.locator(".dt-request-path").textContent(),
    meta: await row.locator(".dt-request-meta").innerText(),
  });

  expect(await look(inRun)).toEqual(await look(outside));
  expect(await look(inRun)).toEqual({
    badge: "gql",
    name: "query Roles",
    // The call's time, as the view made it (its trace took 800 ms of it).
    meta: expect.stringMatching(/^900 ms\s+0\s+1$/),
  });
});

test("the view's row counts its chain as the pill and the tabs do; a row with rows under it counts all of them", async ({
  page,
}) => {
  const seeded = await gatewayView(3, FIVE);
  const { view, group, calls, apps, traces } = await listed(page, seeded.view);
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

  // The gateway's row: all five and what is under them, its finding across them once.
  await expect(queries(group)).toHaveText("3");
  await expect(issues(group)).toHaveText("4");
  // Each call's row: its trace and what is under it; the rows under the last add up to its.
  await expect(queries(calls)).toHaveText(["0", "0", "0", "0", "3"]);
  await expect(issues(calls)).toHaveText(["1", "2", "1", "1", "2"]);
  await expect(queries(apps)).toHaveText(["3", "3"]);
  await expect(queries(traces)).toHaveText(["3", "3"]);

  // A call's row opens its trace: its tabs count what the row says.
  await calls.nth(4).click();

  await expect(panel(page).getByRole("tab", { name: /^DB/ })).toContainText("3");
  await expect(panel(page).getByRole("tab", { name: /^Issues/ })).toContainText("2");

  // The gateway's row opens the view's call tree at its part, its tabs under it: they count what the row says.
  await group.click();

  await expect(panel(page).getByRole("tab", { name: /^Call tree/ })).toHaveAttribute("aria-selected", "true");

  await panel(page)
    .getByRole("tab", { name: /^Issues/ })
    .click();

  await expect(panel(page).locator(".dt-scope-chip")).toContainText("Under gateway");
  await expect(panel(page).getByRole("tab", { name: /^Issues/ })).toContainText("4");
  await expect(panel(page).getByRole("tab", { name: /^DB/ })).toContainText("3");
});

test("a view's calls fold under its row and open again; its call tree and first tab call it a view", async ({
  page,
}) => {
  const seeded = await gatewayView(4, FIVE);
  const { view, group, calls, apps } = await listed(page, seeded.view);

  await expect(view).toHaveAttribute("aria-expanded", "true");
  await view.locator("[data-toggle]").click();

  await expect(view).toHaveAttribute("aria-expanded", "false");
  await expect(calls).toHaveCount(0);
  await expect(apps).toHaveCount(0);

  await view.locator("[data-toggle]").click();

  await expect(calls).toHaveCount(5);
  await expect(apps.first()).toBeVisible();

  // The gateway's row folds its calls too.
  await group.locator("[data-toggle]").click();
  await expect(calls).toHaveCount(0);
  await group.locator("[data-toggle]").click();
  await expect(calls).toHaveCount(5);
  // The same name as the list's row: VIEW, not PAGE.
  const frame = panel(page);
  await expect(frame.getByRole("tab", { name: /^View/ })).toBeVisible();
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await expect(frame.locator(".dt-map-row[data-root] .dt-kind").first()).toHaveText(/^view$/i);
});
