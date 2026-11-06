// A record whose call failed in the app it reached: its Error tab has that error, down its chain, as its Issues and
// Logs tabs have the chain's; a row that isn't on the error's way has none.
import type { Page } from "@playwright/test";
import { openApp, panel, pill } from "../app.ts";
import { chain } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

type Placed = { trace: { name: string; errors?: unknown[] } };

/** The chain with the service's second trace failed, its error raised in its query. */
async function withError(page: Page): Promise<string> {
  const view = await chain();
  await page.route(`**/api/traces/${view}/chain`, async (route) => {
    const answer = await route.fetch();
    const body = (await answer.json()) as { traces: Placed[] };
    for (const each of body.traces) {
      if (each.trace.name !== "GET /authors/2") continue;
      // biome-ignore-start lint/style/useNamingConvention: the trace format.
      each.trace.errors = [
        { type: "LookupError", message: "no author 2", handled: false, frames: [], chain: [], span_id: "q1", time: 0 },
      ];
      // biome-ignore-end lint/style/useNamingConvention: the trace format.
    }
    await route.fulfill({ response: answer, json: body });
  });
  return view;
}

test("a record's Error tab has the errors down its chain; a row off their way has none", async ({ page }) => {
  const view = await withError(page);
  await openApp(page, { one: { status: 200, trace: view, queries: 0, totalMs: 10 } });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const frame = panel(page);
  const tabs = frame.locator(".panel-wf-details .tp-tabs");
  const error = tabs.getByRole("tab", { name: /^Error/ });

  await expect(error).toContainText("1");

  await error.click();

  await expect(frame.locator(".panel-wf-details .tp-error")).toContainText("no author 2");

  // The first call to the service, beside the one that failed: not on the error's way.
  await frame
    .locator(".panel-wf .tp-map-row")
    .filter({ hasText: "Book.author" })
    .first()
    .locator(".tp-map-caret")
    .click();
  await frame.locator('.panel-wf .tp-map-row[data-hop=""]').filter({ hasText: "GET /authors/1" }).first().click();

  await expect(tabs.getByRole("tab", { name: /^Error/ })).toHaveCount(0);
});
