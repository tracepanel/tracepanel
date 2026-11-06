// An error's row in the call tree: its details are the error as its trace's Error tab shows it (its type and
// message, whether it was handled, its frames), not its message alone.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { HANDLERS } from "../seed.ts";

test("an error's row opens the error as its Error tab shows it", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(HANDLERS.at(-1) ?? "")}?tab=tree`);
  await page.locator('.tp-map-row[data-kind="error"]').first().click();
  const error = page.locator(":is(.tp-map-side, .tp-map-inline) .tp-error");

  await expect(error).toContainText("ConnectionError");
  await expect(error).toContainText("thumbnail service unavailable");
  await expect(error).toContainText("Unhandled");
});
