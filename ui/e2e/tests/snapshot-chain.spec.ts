// A snapshot of a trace holds its whole chain of calls, as the console shows it: the service's traces two calls
// down (the view calls the BFF, whose steps call the service) are in its tabs and its call tree, with no agent.
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { chain } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

/** The trace on screen shared as a snapshot file, opened offline in a page of its own. */
async function shared(page: Page, context: BrowserContext, info: TestInfo): Promise<Page> {
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this trace" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Download snapshot" }).click(),
  ]);
  const file = info.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const offline = await context.newPage();
  await offline.route("http://127.0.0.1/**", (route) => route.abort());
  await offline.goto(`file://${file}`);
  return offline;
}

test("a snapshot's tabs add up its whole chain: the service's queries two calls down", async ({
  page,
  context,
}, info) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=calls`);
  await expect(page.getByRole("tab", { name: /^DB/ })).toContainText("3");

  const offline = await shared(page, context, info);

  await expect(offline.getByRole("tab", { name: /^DB/ })).toContainText("3");

  await offline.getByRole("tab", { name: /^DB/ }).click();

  await expect(offline.getByText(/SELECT author\s*×3/)).toBeVisible();
  await expect(offline.locator(".dt-scope-summary-text")).toContainText("3 queries");

  await offline.getByRole("tab", { name: /^Profile/ }).click();

  // The BFF's and the service's three, as the console has them.
  await expect(offline.getByRole("region", { name: "Profile of shop", exact: true })).toContainText(
    "Profile of 4 traces",
  );
});
