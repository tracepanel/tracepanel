// The panel's details dragged as narrow as they go: never under 24rem, so the top's actions over them, the time strip's
// scale and a field's value still fit (their share alone, a fifth of a 1100 px panel, left them 220 px).
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test("details at their narrowest keep 24rem, the top's actions over them", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await openApp(page, { a: { status: 201, trace: await traceId("POST /api/thumbnails"), queries: 1, totalMs: 10 } });
  await page.getByRole("button", { name: "Load a" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.locator(".panel-wf .tp-requests-open .tp-map-row").first().waitFor();
  const line = frame.getByRole("separator", { name: "Resize the details" });
  await line.focus();
  for (let step = 0; step < 20; step++) await page.keyboard.press("ArrowRight");

  await expect(line).toHaveAttribute("aria-valuenow", "20");
  const details = await frame.locator(".panel-wf-details").boundingBox();
  const console = await frame.getByRole("link", { name: /Console/ }).boundingBox();

  const rem = await frame.locator("html").evaluate((html) => Number.parseFloat(getComputedStyle(html).fontSize));
  expect(details?.width).toBeGreaterThanOrEqual(24 * rem - 1);
  expect(console?.x).toBeGreaterThanOrEqual(details?.x ?? Number.POSITIVE_INFINITY);
});
