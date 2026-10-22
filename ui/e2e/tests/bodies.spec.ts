// A request's and its response's bodies, as the SDK keeps them: JSON laid out and coloured, a cut one as far as it
// goes and marked, one kept by its size only saying so; the same parts in the console, on the call tree's request row
// and in the in-page panel.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { indentedJson, indentedPartialJson } from "../../packages/ui/src/json.ts";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const ORDER = "POST /api/orders/";

async function part(scope: Page | Locator | FrameLocator, name: string): Promise<Locator> {
  await scope.getByRole("tablist", { name: "Request details" }).getByRole("tab", { name }).click();
  return scope.getByRole("tabpanel", { name });
}

async function expectBodies(scope: Page | Locator | FrameLocator): Promise<void> {
  const request = await part(scope, "Request body");

  await expect(request.locator(".token.string").first()).toHaveText('"book"');
  await expect(request).toContainText('"cvc": "********"');

  const response = await part(scope, "Response body");

  await expect(response.locator("pre")).toContainText(/^\{\s*"order": 7,\s*"access_token": "\*{8}",\s*"items": \[/);
  await expect(response.locator(".token.number").first()).toHaveText("7");
  await expect(response).toContainText(/Cut: its first 1\.0 KB of \d\.\d KB\./);
}

test("a JSON body is laid out and coloured; a cut response as far as it goes, marked as cut", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(ORDER)}?tab=request`);

  await expect(page.getByRole("tablist", { name: "Request details" }).getByRole("tab")).toHaveText([
    /^Headers\s*1$/,
    /^Request body$/,
    /^Response headers\s*1$/,
    /^Response body$/,
    /^Attributes\s*\d+$/,
  ]);
  await expectBodies(page);
});

test("the call tree's request row shows the same bodies behind the same switch", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(ORDER)}?tab=calls`);
  await page.locator(".dt-map-row").first().click();

  await expectBodies(page.getByRole("complementary", { name: "Details" }));
});

test("the in-page panel shows the same bodies", async ({ page }) => {
  await openApp(page, { orders: { status: 201, trace: await traceId(ORDER), queries: 2, totalMs: 4 } });
  await page.getByRole("button", { name: "Load orders" }).click();
  await pill(page).click();
  await panel(page)
    .getByRole("tab", { name: /^Request/ })
    .click();

  await expectBodies(panel(page));
});

test("an upload is its fields and its file by name and size; a binary answer is kept by its size only", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("POST /api/covers/")}?tab=request`);

  await expect(await part(page, "Request body")).toContainText("<file dune.png, 48213 bytes>");
  await expect(await part(page, "Response body")).toHaveText(
    "47 KB of image/png: kept by its size only. JSON, forms and text are kept, uncompressed.",
  );
});

test("JSON cut short is laid out as the whole of it would be, as far as it goes", () => {
  const whole = JSON.stringify({ a: [1, { b: 'x, "y" {' }], c: {}, d: [], e: null });

  expect(indentedPartialJson(whole)).toBe(indentedJson(whole));
  expect(indentedPartialJson('{"a":[1,{"b":"x, \\"y')).toBe('{\n  "a": [\n    1,\n    {\n      "b": "x, \\"y');
});
