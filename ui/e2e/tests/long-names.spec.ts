// Long names stay whole: an attribute's name gets the room it needs, and library frames read as their packages.
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

async function first(request: APIRequestContext, q: string): Promise<string> {
  const found = (await (await request.get(`/api/traces?q=${encodeURIComponent(q)}&limit=1`)).json()) as {
    traces: { id: string }[];
  };
  return found.traces[0]?.id ?? "";
}

test("a long attribute name is shown whole, not cut", async ({ page, request }) => {
  const name = "messaging.rabbitmq.destination.routing_key";
  await page.route("**/api/traces/*", async (route) => {
    const trace = await (await route.fetch()).json();
    if (trace.attrs) trace.attrs[name] = "orders.cancelled";
    await route.fulfill({ json: trace });
  });
  await page.goto(`/#/t/${await first(request, "system:rabbitmq")}`);
  await page.getByRole("tab", { name: /^Task/ }).click();
  await page.getByRole("tab", { name: /^Attributes/ }).click();
  const term = page.locator("dt", { hasText: "rabbitmq.destination.routing_key" });

  await expect(term).toBeVisible();
  expect(await term.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("library frames are summed up by their packages, on one line", async ({ page, request }) => {
  await page.goto(`/#/t/${await first(request, "route:/boom service:api")}`);
  await page.getByRole("tab", { name: /^Error/ }).click();
  const names = page.locator(".dt-frame-group-names").first();

  await expect(names).toHaveText("runtime · net/http ×5 · example.com/api/internal/tracepanel ×3");
  expect(await names.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
