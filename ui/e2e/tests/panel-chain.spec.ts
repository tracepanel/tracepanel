// Under a row of the panel's list whose trace called other apps: an app's row (folded), then its traces by route,
// as the call tree's chain has them. A trace's row opens it; the app's row opens the row's trace under that app.
import { openApp, panel, pill } from "../app.ts";
import { chain, chainTrace } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

test("a row that called another app has that app's traces under it, folded, by route; each opens", async ({ page }) => {
  await chain();
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, { graphql: { status: 200, trace: chainTrace("bff"), queries: 0, totalMs: 8 } });
  await page.getByRole("button", { name: "Load graphql" }).click();
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  const app = list.locator('.dt-request-row[data-chain="app"]');
  const group = list.locator('.dt-request-row[data-chain="group"]');

  await expect(app).toHaveCount(1);
  await expect(app).toContainText("shop");
  await expect(app).toContainText("3 traces");
  await expect(app.locator(".dt-request-queries")).toHaveText("3");
  await expect(app).toHaveAttribute("aria-expanded", "false");
  await expect(group).toHaveCount(0);

  // As in the call tree: → opens it.
  await app.focus();
  await page.keyboard.press("ArrowRight");

  await expect(app).toHaveAttribute("aria-expanded", "true");
  await expect(group).toHaveCount(1);
  await expect(group).toContainText("/authors/{id}");
  await expect(group).toContainText("×3");
  await expect(group.locator(".dt-request-queries")).toHaveText("3");

  await group.click();

  // The first of the three, beside the list; the group's row is the one selected, the rows stay open.
  await expect(group).toHaveAttribute("aria-current", "true");
  await expect(panel(page).getByRole("tab", { name: /^Request/ })).toBeVisible();
  await expect(panel(page).locator("body")).toContainText("GET /authors/1");
  await expect(app).toHaveAttribute("aria-expanded", "true");

  await app.click();

  // The BFF's trace, its tabs under the app's traces.
  await expect(panel(page).locator(".dt-scope-chip")).toContainText("Under shop");
  await expect(panel(page).getByRole("tab", { name: /^DB/ })).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByText("3 queries · 1 unique")).toBeVisible();

  // ← folds it again.
  await app.focus();
  await page.keyboard.press("ArrowLeft");

  await expect(group).toHaveCount(0);
});
