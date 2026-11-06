// A call a click made is in the click's record, never a record of its own: opened from the pill's card (one of its
// findings), or a row of it picked in the tree, its click's record stays the one open, at it.
import { CONSOLE } from "../agent.ts";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { trace } from "../seed.ts";

/** The recording's ids in this test: its click (the second) is stored, as the browser's SDK sends it. */
const IDS = "01M4NPK";

async function storeClick(): Promise<void> {
  const doc = trace("page", '/app/ › click "posts"', { "service.name": "shop-web" });
  doc["id"] = `${IDS}${"2".padStart(19, "0")}`;
  // Hours ago: no other test's list opens on it.
  doc["start"] = Date.now() * 1000 - 3 * 3_600_000_000;
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);
}

test("a click's call opened from the pill's card, or a row of it picked, stays in the click's record", async ({
  page,
}) => {
  await storeClick();
  const posts = { status: 200, trace: await traceId("GET /api/posts"), queries: 1, totalMs: 10 };
  await openApp(page, { posts }, { recording: true, ids: IDS });
  await page.getByRole("button", { name: "Do posts" }).click();
  // The pill's card opens the call itself: its N+1, on the call's trace.
  await pill(page).hover();
  await page.getByRole("dialog", { name: "This request at a glance" }).locator(".card-row").first().click();
  const list = panel(page).locator(".panel-wf");
  const records = list.locator(".tp-record");
  const call = list.locator(".tp-requests-open .tp-map-row:not(.tp-record)").filter({ hasText: "/api/posts" });

  // The view and its click, the click open with its call in it.
  await expect(records).toHaveCount(2);
  await expect(records.first()).toContainText('"posts"');
  await expect(records.filter({ hasText: "/api/posts" })).toHaveCount(0);
  await expect(call).toHaveCount(1);

  // A row of the call's own trace: its query.
  const query = list.locator('.tp-requests-open .tp-map-row[data-kind="sql"]').first();
  await query.click();

  await expect(records).toHaveCount(2);
  await expect(records.first()).toContainText('"posts"');
  await expect(records.filter({ hasText: "/api/posts" })).toHaveCount(0);
  await expect(query).toHaveAttribute("aria-current", "true");
});
