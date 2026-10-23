// A task run's arguments and result in its facts: as JSON (None is null), each copy button right after its value.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("a task's result None reads null, and its copy button sits by the value, not at the row's end", async ({
  page,
}) => {
  await page.route("**/api/traces/*", async (route) => {
    const trace = await (await route.fetch()).json();
    if (trace.attrs) {
      trace.attrs["task.args"] = "({'number': 'A-10002', 'reason': 'changed my mind'},)";
      trace.attrs["task.kwargs"] = "{}";
      trace.attrs["task.result"] = "None";
    }
    await route.fulfill({ json: trace });
  });
  await page.goto(`/#/t/${await traceId("shop.tasks.send_receipt")}`);
  await page.getByRole("tab", { name: /^Task/ }).click();
  const facts = page.getByRole("tabpanel").locator("dl").first();
  const result = facts.locator("dt", { hasText: /^Result$/ }).locator("xpath=following-sibling::dd[1]");

  await expect(result).toContainText("null");

  const args = facts.locator("dt", { hasText: /^Arguments$/ }).locator("xpath=following-sibling::dd[1]");
  await args.hover();
  const copy = args.getByRole("button", { name: "Copy arguments" });
  const value = await args.locator("span").first().boundingBox();
  const button = await copy.boundingBox();
  expect(button && value ? button.x - (value.x + value.width) : -1).toBeLessThan(16);
});
