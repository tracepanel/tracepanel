// The open record's first row says what its closed row did: when it was, its status, what it found.
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("the open record's first row has its when and its status, as a closed record's row", async ({ page }) => {
  await openApp(page, {
    posts: { status: 200, trace: await traceId("GET /api/posts"), queries: 1, totalMs: 10 },
    broken: { status: 500, trace: await traceId("GET /api/error"), queries: 0, totalMs: 10 },
  });
  await page.getByRole("button", { name: "Load posts" }).click();
  await page.getByRole("button", { name: "Load broken" }).click();
  await pill(page).click();
  const list = panel(page).locator(".panel-wf");
  const root = list.locator(".tp-requests-open .tp-map-row[data-root]").first();
  const closed = list.locator(".tp-record").filter({ hasText: "/api/posts" });

  await expect(root).toContainText("/api/error");
  await expect(root.locator(".tp-record-ago")).toHaveText(/ago$/);
  await expect(root.locator(".tp-status")).toHaveText("500");

  await expect(closed.locator(".tp-record-ago")).toHaveText(/ago$/);
  await expect(closed.locator(".tp-status")).toHaveText("200");
});
