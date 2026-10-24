// Every trace's first tab is one anatomy: in the panel a head line (its badge, name, outcome and time, what
// handled it under), then its own facts in one order (its kind's first, then App, Runtime, Started, Trace ID), nothing
// its head says again; then its related traces, each a row as the call tree draws a linked trace.
import type { FrameLocator, Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { SALES_REPORT } from "../seed.ts";

const COMMON = ["App", "Runtime", "Started", "Trace ID"];

async function terms(scope: Page | FrameLocator): Promise<string[]> {
  return scope.getByRole("tabpanel").first().locator("dl").first().getByRole("term").allInnerTexts();
}

/** The common facts, in their one order, after any of the kind's own. */
function inOrder(names: string[]): boolean {
  const at = COMMON.map((name) => names.indexOf(name));
  return at.every((index, n) => index >= 0 && (n === 0 || index > (at[n - 1] ?? 0)));
}

async function openInPanel(page: Page, name: string): Promise<FrameLocator> {
  await openApp(page, { one: { status: 200, trace: await traceId(name), queries: 0, totalMs: 10 } });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tablist").first().getByRole("tab").first().click();
  return frame;
}

for (const name of [SALES_REPORT, "POST /api/reports/sales", "manage.py rebuild_index", '/books › click "Save"']) {
  test(`in the panel, ${name}'s first tab: a head line, then its facts in one order, nothing said twice`, async ({
    page,
  }) => {
    const frame = await openInPanel(page, name);
    const head = frame.locator(".dt-hero");

    await expect(head.locator(".dt-kind, .dt-method").first()).toBeVisible();
    await expect(head).toContainText(/\d+ ms/);
    const names = await terms(frame);

    expect(inOrder(names)).toBe(true);
    expect(names).not.toContain("Duration");
    expect(names).not.toContain("State");
    expect(names).not.toContain("Task");
    expect(names).not.toContain("URL");
    expect(names).not.toContain("Status");
  });
}

test("a request and the task it enqueued link each other with the call tree's row: a grey kind box, its time", async ({
  page,
}) => {
  const request = await openInPanel(page, "POST /api/reports/sales");
  const enqueued = request.getByRole("region", { name: "Related traces" });

  await expect(enqueued.getByRole("term")).toHaveText("Enqueued task");
  await expect(enqueued.locator(".dt-kind[data-muted]")).toHaveText("task");
  await expect(enqueued).toContainText(/\d+ ms/);

  await page.goto(`/#/t/${await traceId(SALES_REPORT)}?tab=request`);
  const by = page.getByRole("region", { name: "Related traces" });

  await expect(by.getByRole("term")).toHaveText("Enqueued by");
  await expect(by.locator(".dt-kind[data-muted]")).toHaveText("request");
  // As every request row says it: its method and path, its status.
  await expect(by.getByRole("definition")).toContainText("POST /api/reports/sales");
  await expect(by.locator(".dt-status")).toHaveText("202");
});

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
