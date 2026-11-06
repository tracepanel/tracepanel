// A task a request started, picked in the panel's tree: the details are the task's (its name and time, the way to
// its trace), not the request's it sits under.
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("a task's row picked in the panel has the task's details, its own time, and the way to its trace", async ({
  page,
}) => {
  await openApp(page, {
    thumbnails: { status: 202, trace: await traceId("POST /api/thumbnails"), queries: 0, totalMs: 40 },
  });
  await page.getByRole("button", { name: "Load thumbnails" }).click();
  await pill(page).click();
  const frame = panel(page);
  const task = frame.locator('.panel-wf .tp-map-row[data-kind="task"]').first();
  await task.click();
  const details = frame.locator(".panel-wf-details");
  const took = await task.locator(".tp-map-time").innerText();

  await expect(details.locator(".tp-details-title")).toContainText("shop.tasks.make_thumbnail");
  await expect(details.locator(".tp-details-took")).toHaveText(took);
  await expect(details.getByRole("link", { name: /Open the task's trace/ })).toBeVisible();
});
