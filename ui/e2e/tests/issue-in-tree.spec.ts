// An issue's "In the call tree": the row its spans are all under, shown in the tree (the rows on its way opened, it
// in view, picked), the row itself folded: an N+1's group, not one of its calls opened among the others.
import type { Page } from "@playwright/test";
import { openApp, panel, pill } from "../app.ts";
import { chain } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

type Placed = { trace: { name: string; issues?: unknown[] } };

/** A finding on these spans of one trace of the chain, as the agent would have it. */
function finding(kind: string, title: string, spans: string[]) {
  // biome-ignore-start lint/style/useNamingConvention: the trace format.
  return {
    fingerprint: `${kind}-${spans[0]}`,
    fingerprint_version: 1,
    kind,
    title,
    culprit: null,
    hint: null,
    count: spans.length,
    span_ids: spans,
  };
  // biome-ignore-end lint/style/useNamingConvention: the trace format.
}

/** The chain with a finding added to its trace named `name`. */
async function withIssue(page: Page, name: string, issue: ReturnType<typeof finding>): Promise<string> {
  const view = await chain();
  await page.route(`**/api/traces/${view}/chain`, async (route) => {
    const answer = await route.fetch();
    const body = (await answer.json()) as { traces: Placed[] };
    for (const each of body.traces) if (each.trace.name === name) each.trace.issues = [issue];
    await route.fulfill({ response: answer, json: body });
  });
  return view;
}

/** The chain's view open in the panel, its Issues tab, the In the call tree of the issue titled so clicked. */
async function showInTree(page: Page, view: string, title: RegExp) {
  await openApp(page, { one: { status: 200, trace: view, queries: 0, totalMs: 10 } });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const frame = panel(page);
  const details = frame.locator(".panel-wf-details");
  await details.getByRole("tab", { name: /^Issues/ }).click();
  await details
    .getByRole("article")
    .filter({ hasText: title })
    .getByRole("button", { name: "In the call tree" })
    .click();
  return frame.locator('.panel-wf .tp-map-row[aria-current="true"]');
}

test("an N+1's In the call tree picks its group's row, open to it, the group itself folded", async ({ page }) => {
  const view = await withIssue(
    page,
    "POST /graphql",
    finding("n+1", "N+1: 3 similar calls · GET /authors/{id}", ["c0", "c1", "c2"]),
  );
  const current = await showInTree(page, view, /3 similar calls/);

  await expect(current).toContainText("Book.author");
  await expect(current).toContainText("×3");
  await expect(current).toHaveAttribute("aria-expanded", "false");
  await expect(current).toBeInViewport();
});

test("an issue in another app's trace opens the rows down to it, the calls' traces too, and picks it", async ({
  page,
}) => {
  const view = await withIssue(page, "GET /authors/2", finding("slow-sql", "Slow query · SELECT author", ["q1"]));
  const current = await showInTree(page, view, /Slow query/);

  await expect(current).toContainText("SELECT author");
  await expect(current).toBeInViewport();
});
