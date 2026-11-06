// An issue's "In the call tree": the row its spans are all under, shown in the tree (the rows on its way opened, it
// in view, picked), the row itself folded: an N+1's group, not one of its calls opened among the others.
import type { Page } from "@playwright/test";
import { openApp, panel, pill } from "../app.ts";
import { chain } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

type Placed = { trace: { name: string; issues?: unknown[] } };

/** The chain with the BFF's three calls to the service one N+1, as the agent would find it. */
async function withN1(page: Page): Promise<string> {
  const view = await chain();
  await page.route(`**/api/traces/${view}/chain`, async (route) => {
    const answer = await route.fetch();
    const body = (await answer.json()) as { traces: Placed[] };
    for (const each of body.traces) {
      if (each.trace.name !== "POST /graphql") continue;
      each.trace.issues = [
        {
          fingerprint: "authors-n1",
          // biome-ignore lint/style/useNamingConvention: the trace format.
          fingerprint_version: 1,
          kind: "n+1",
          title: "N+1: 3 similar calls · GET /authors/{id}",
          culprit: null,
          hint: null,
          count: 3,
          // biome-ignore lint/style/useNamingConvention: the trace format.
          span_ids: ["c0", "c1", "c2"],
        },
      ];
    }
    await route.fulfill({ response: answer, json: body });
  });
  return view;
}

test("an N+1's In the call tree picks its group's row, open to it, the group itself folded", async ({ page }) => {
  const view = await withN1(page);
  await openApp(page, { one: { status: 200, trace: view, queries: 0, totalMs: 10 } });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const frame = panel(page);
  const details = frame.locator(".panel-wf-details");
  await details.getByRole("tab", { name: /^Issues/ }).click();
  await details.getByRole("button", { name: "In the call tree" }).first().click();
  const current = frame.locator('.panel-wf .tp-map-row[aria-current="true"]');

  await expect(current).toContainText("Book.author");
  await expect(current).toContainText("×3");
  await expect(current).toHaveAttribute("aria-expanded", "false");
  await expect(current).toBeInViewport();
});
