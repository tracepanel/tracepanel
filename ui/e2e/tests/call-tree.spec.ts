// A call tree's rows keep their parts apart: the call's own text shows beside a long database alias and an issue chip,
// and nothing of the name runs into the bar or the time.
import type { Locator } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error(`${locator} isn't on the page`);
  return found;
}

for (const width of [1440, 900]) {
  test(`a row with a long alias and an issue shows its text and its issue, clear of its bar (${width} px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const id = await traceId("PATCH /campaigns/{id}/report");
    await page.goto(`/#/t/${id}?tab=calls`);
    await page
      .getByRole("button", { name: /^transaction/ })
      .first()
      .click();
    const rows = page.locator('.dt-map-row:is([data-kind="sql"], [data-kind="transaction"])');
    await expect(rows).toHaveCount(5);

    for (const row of await rows.all()) {
      const name = await box(row.locator(".dt-map-name"));
      const text = await box(row.locator(".dt-map-text"));
      const chip = await box(row.locator('[data-slot="badge"]'));
      const track = await box(row.locator(".dt-map-track"));

      // At least the 2.5rem (37.5 px) a narrow tree keeps of the call's text, a few characters: the chips beside it
      // give way first. Linux's font rendering leaves it exactly there at 900 px, macOS's a few pixels more.
      expect(text.width).toBeGreaterThanOrEqual(37);
      expect(chip.x + chip.width).toBeLessThanOrEqual(name.x + name.width + 0.5);
      expect(name.x + name.width).toBeLessThanOrEqual(track.x + 0.5);
    }
  });
}

test("a row's fold opens and closes its rows without opening its details; the arrow keys do too", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("PATCH /campaigns/{id}/report")}?tab=calls`);
  const row = page.getByRole("button", { name: /^transaction/ }).first();
  const fold = row.locator(".dt-map-caret[data-toggle]");
  const details = page.getByRole("complementary", { name: "Details" });

  await expect(row).toHaveAttribute("aria-expanded", "true");

  await fold.click();

  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(row).not.toHaveAttribute("aria-current", "true");
  await expect(details).toHaveCount(0);

  await fold.click();

  await expect(row).toHaveAttribute("aria-expanded", "true");

  await row.focus();
  await page.keyboard.press("ArrowLeft");

  await expect(row).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("ArrowRight");

  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(details).toHaveCount(0);
});

test("a call's details give its fields and all its attributes one column of names: every value starts at one edge", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("PATCH /campaigns/{id}/report")}?tab=calls`);
  await page
    .getByRole("button", { name: /^transaction/ })
    .first()
    .click();
  await page.locator('.dt-map-row[data-kind="sql"]').first().click();
  const values = page.locator(":is(.dt-map-side, .dt-map-inline) dd");
  await expect(values.first()).toBeVisible();
  const starts = await values.evaluateAll((cells) =>
    cells.map((cell) => Math.round(cell.getBoundingClientRect().left)),
  );

  expect(starts.length).toBeGreaterThan(2);
  expect(new Set(starts).size).toBe(1);
});

for (const theme of ["dark", "light"]) {
  test(`a row's kind, its bar and the strip's legend share one colour; a query's verb is set apart (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((chosen) => localStorage.setItem("tracepanel:theme", chosen), theme);
    await page.goto(`/#/t/${await traceId("GET /")}?tab=tree`);
    const query = page.locator('.dt-map-row[data-category="sql"]').first();
    const colour = (locator: Locator, property: "color" | "backgroundColor") =>
      locator.evaluate((element, name) => getComputedStyle(element)[name], property);
    const legend = await colour(
      page.locator('.dt-breakdown-legend [data-category="sql"] .dt-swatch'),
      "backgroundColor",
    );

    expect(await colour(query.locator(".dt-map-kind"), "color")).toBe(legend);
    expect(await colour(query.locator(".dt-map-bar"), "backgroundColor")).toBe(legend);
    await expect(query.locator(".dt-map-op")).toHaveText("SELECT");
  });
}
