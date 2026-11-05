// Every trace's first tab is one anatomy: in the panel a head line (its badge, name, outcome and time, what
// handled it under), then its own facts in one order (its kind's first, then App, Runtime, Started, Trace ID), nothing
// its head says again; then its related traces, each a row as the call tree draws a linked trace.
import type { FrameLocator, Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const COMMON = ["App", "Runtime", "Started", "Trace ID"];

/** The first tab's facts, once its trace has loaded: before it, the tab has none to read. */
async function terms(scope: Page | FrameLocator): Promise<string[]> {
  const facts = scope.getByRole("tabpanel").first().locator("dl").first().getByRole("term");
  // Every trace's facts say its ID: there, they are all there.
  await expect(facts.filter({ hasText: /^Trace ID$/ })).toBeVisible();
  return facts.allInnerTexts();
}

/** The common facts, in their one order, after any of the kind's own. */
function inOrder(names: string[]): boolean {
  const at = COMMON.map((name) => names.indexOf(name));
  return at.every((index, n) => index >= 0 && (n === 0 || index > (at[n - 1] ?? 0)));
}

test("on the console's page the header is the head: the facts don't say its URL, status or duration again", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("GET /account/orders/")}?tab=request`);
  const names = await terms(page);

  expect(inOrder(names)).toBe(true);
  expect(names).toContain("View");
  expect(names).not.toContain("URL");
  expect(names).not.toContain("Status");
  expect(names).not.toContain("Duration");
});
