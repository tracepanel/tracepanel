// The Logs page's Level filter: the levels once each, a level and every one above it said as one pick.
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

const region = (page: Page) => page.getByRole("region", { name: "Logs" });
const levelsShown = (page: Page) => region(page).locator("tr[data-record] td:nth-child(2)").allTextContents();
const levelChip = (page: Page) => page.getByRole("button", { name: /^Level\b/ });
const legend = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/** A level's row in the open menu: its tag is the level as stored, in capitals by its style. */
const levelRow = (page: Page, level: string) => page.getByRole("option", { name: new RegExp(`^${level}\\b`) });

async function expectOnly(page: Page, levels: readonly string[]): Promise<void> {
  await expect.poll(async () => (await levelsShown(page)).length).toBeGreaterThan(0);
  for (const level of await levelsShown(page)) {
    expect(levels).toContain(level);
  }
}

test("the Level menu lists each level once; a level's own 'and above' picks it and every one above it", async ({
  page,
}) => {
  await page.goto("/#/logs");
  await levelChip(page).click();

  // The levels, no other rows.
  await expect(page.getByRole("option")).toHaveCount(5);
  for (const level of ["debug", "info", "warning", "error", "critical"]) {
    await expect(levelRow(page, level)).toHaveCount(1);
  }

  await levelRow(page, "warning").hover();
  await page.getByRole("button", { name: "WARNING and above" }).click();

  await expect(page).toHaveURL(/level(%3E|>)(%3D|=)warning/);
  await expect(page.getByRole("button", { name: "Edit level>=warning" })).toBeVisible();
  await expect(levelChip(page)).toHaveText(/WARNING and above/);
  await expect(legend(page, "info")).toHaveAttribute("aria-pressed", "false");
  await expect(legend(page, "error")).toHaveAttribute("aria-pressed", "true");
  await expectOnly(page, ["warning", "error", "critical"]);

  // ERROR unchecked from there: the levels left, one by one.
  await levelRow(page, "error").click();

  await expect(page.getByRole("button", { name: "Edit level:warning,critical" })).toBeVisible();
  await expect(levelChip(page)).toHaveText(/2 selected/);
  await expectOnly(page, ["warning", "critical"]);

  // Checked again: WARNING and every level above it, said so.
  await levelRow(page, "error").click();

  await expect(page.getByRole("button", { name: "Edit level>=warning" })).toBeVisible();
  await expect(levelChip(page)).toHaveText(/WARNING and above/);
});

test("levels checked one by one filter by those levels", async ({ page }) => {
  await page.goto("/#/logs");
  await levelChip(page).click();
  await levelRow(page, "debug").click();
  await levelRow(page, "warning").click();

  await expect(page.getByRole("button", { name: "Edit level:debug,warning" })).toBeVisible();
  await expectOnly(page, ["debug", "warning"]);
});

test("a link with level>= from before filters the same, its levels checked and the chip saying so", async ({
  page,
}) => {
  await page.goto(`/#/logs?q=${encodeURIComponent("level>=error")}`);

  await expect(levelChip(page)).toHaveText(/ERROR and above/);
  await expect(legend(page, "warning")).toHaveAttribute("aria-pressed", "false");
  await expect(legend(page, "error")).toHaveAttribute("aria-pressed", "true");
  await expectOnly(page, ["error", "critical"]);

  // CRITICAL unchecked: ERROR alone, as a list.
  await levelChip(page).click();
  await levelRow(page, "critical").click();

  await expect(page.getByRole("button", { name: "Edit level:error" })).toBeVisible();
});
