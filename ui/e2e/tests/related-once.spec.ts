// A trace this one is linked to in two ways is listed once: a task a broker delivered was both enqueued and sent by
// the same request.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("a request that both enqueued and sent a task is listed once, as what enqueued it", async ({ page }) => {
  await page.route("**/api/traces/*/related", async (route) => {
    const related = await (await route.fetch()).json();
    // biome-ignore lint/style/useNamingConvention: the wire format.
    await route.fulfill({ json: { ...related, sent_by: related.enqueued_by } });
  });
  await page.goto(`/#/t/${await traceId("shop.jobs.publish_image")}`);
  await page.getByRole("tab", { name: /^Task/ }).click();
  const related = page.getByRole("region", { name: "Related traces" });

  await expect(related.locator("dt", { hasText: /^Enqueued by$/ })).toHaveCount(1);
  await expect(related.locator("dt", { hasText: /^Sent by$/ })).toHaveCount(0);
  await expect(related.getByText("/api/images")).toHaveCount(1);
});

test("a task a request both enqueued and delivered to is listed once, as its enqueued task", async ({ page }) => {
  await page.route("**/api/traces/*/related", async (route) => {
    const related = await (await route.fetch()).json();
    await route.fulfill({ json: { ...related, delivered: related.enqueued } });
  });
  await page.goto(`/#/t/${await traceId("POST /api/images")}`);
  await page.getByRole("tab", { name: /^Request/ }).click();
  const related = page.getByRole("region", { name: "Related traces" });

  await expect(related.locator("dt", { hasText: /^Enqueued tasks? \(\d+\)$|^Enqueued task$/ })).toHaveCount(1);
  await expect(related.locator("dt", { hasText: /^Delivered to/ })).toHaveCount(0);
});
