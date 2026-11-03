// A snapshot file opens in the theme of whoever opens it (their OS's), and has the console's theme switch: the pick
// is kept for the next time, offline, with no agent.
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { chain } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

/** The trace on screen shared as a snapshot file, saved: its path. */
async function saved(page: Page, info: TestInfo): Promise<string> {
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this trace" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Download snapshot" }).click(),
  ]);
  const file = info.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  return file;
}

/** The file opened offline in a page whose OS theme is `scheme`. */
async function opened(context: BrowserContext, file: string, scheme: "light" | "dark"): Promise<Page> {
  const offline = await context.newPage();
  await offline.emulateMedia({ colorScheme: scheme });
  await offline.route("http://127.0.0.1/**", (route) => route.abort());
  await offline.goto(`file://${file}`);
  await expect(offline.getByRole("tab", { name: /^DB/ })).toBeVisible();
  return offline;
}

const theme = (page: Page) => page.locator("html").getAttribute("data-theme");

test("a snapshot opens in its viewer's theme; its theme switch is the console's, the pick kept", async ({
  page,
  context,
}, info) => {
  const view = await chain();
  // The console's own pick (dark) is not the file's: the file follows whoever opens it.
  await page.goto(`/#/t/${view}?tab=calls`);
  const file = await saved(page, info);

  const light = await opened(context, file, "light");
  expect(await theme(light)).toBe("light");
  await light.close();

  const dark = await opened(context, file, "dark");
  expect(await theme(dark)).toBe("dark");

  // The switch: Auto (the OS's) → Dark → Light, as in the console.
  const toggle = dark.getByRole("button", { name: /^Theme: / });
  await expect(toggle).toHaveAccessibleName(/^Theme: Auto/);
  await toggle.click();
  await expect(toggle).toHaveAccessibleName(/^Theme: Dark/);
  await toggle.click();
  await expect(toggle).toHaveAccessibleName(/^Theme: Light/);
  expect(await theme(dark)).toBe("light");

  // Kept: the file opened again, on a dark OS, is light.
  await dark.reload();
  await expect(dark.getByRole("tab", { name: /^DB/ })).toBeVisible();
  expect(await theme(dark)).toBe("light");
});
