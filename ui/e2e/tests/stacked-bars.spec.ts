// Every bar chart draws one solid bar: its parts stacked flush, no gap between them, its top rounded and its base
// square; and its tooltip's legend says each part by the swatch of its colour, in the text's own colour, top first.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

const chart = (page: Page) => page.getByRole("img", { name: "Log records over time, by level" });

/** The parts of each bar, bottom up: their top and bottom (px), whether each is the rounded top, and its level. */
async function bars(svg: Locator) {
  return svg.locator("g").evaluateAll((groups) =>
    groups
      .map((group) =>
        [...group.querySelectorAll<SVGGraphicsElement>("[data-part]")].map((part) => {
          const box = part.getBBox();
          return {
            level: part.dataset["part"],
            top: box.y,
            bottom: box.y + box.height,
            rounded: part.tagName === "path",
          };
        }),
      )
      .filter((parts) => parts.length > 0),
  );
}

test("a stacked bar is one solid bar, its top part alone rounded, its parts flush", async ({ page }) => {
  await page.goto("/#/logs");
  await expect(chart(page)).toBeVisible();
  const all = await bars(chart(page));
  const stacked = all.filter((parts) => parts.length > 1);

  expect(all.length).toBeGreaterThan(0);
  expect(stacked.length).toBeGreaterThan(0);
  for (const parts of all) {
    expect(parts.map((part) => part.rounded)).toEqual(parts.map((_, index) => index === parts.length - 1));
    for (let at = 1; at < parts.length; at++) {
      expect(Math.abs((parts[at]?.bottom ?? 0) - (parts[at - 1]?.top ?? 0))).toBeLessThan(0.01);
    }
  }
});

test("a bar's tooltip names each part by its swatch, in the text's colour, top first", async ({ page }) => {
  await page.goto("/#/logs");
  const svg = chart(page);
  await expect(svg).toBeVisible();
  const index = (await bars(svg)).findIndex((parts) => parts.length > 1);
  const group = svg
    .locator("g")
    .filter({ has: page.locator("[data-part]") })
    .nth(index);
  await group.hover();
  const lines = page.locator("[data-tip-series]");

  const levels = await group
    .locator("[data-part]")
    .evaluateAll((parts) => parts.map((part) => part.getAttribute("data-part")));
  await expect(lines).toHaveCount(levels.length);
  // Top first, as the stack: its last part, the worst level, heads the lines.
  const named = await lines.allInnerTexts();
  expect(named.map((line) => line.split(" ").at(-1))).toEqual([...levels].reverse());
  const look = await lines.evaluateAll((spans) =>
    spans.map((span) => ({
      swatch: getComputedStyle(span.querySelector("i") as Element).backgroundColor,
      text: getComputedStyle(span).color,
      tip: getComputedStyle(span.parentElement as Element).color,
    })),
  );
  for (const line of look) {
    expect(line.swatch).not.toBe("rgba(0, 0, 0, 0)");
    expect(line.text).toBe(line.tip);
  }
  expect(new Set(look.map((line) => line.swatch)).size).toBe(look.length);
});
