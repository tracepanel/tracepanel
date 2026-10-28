// A segment hovered on a bar lights in its own colour, with its legend item; a legend item hovered lights its
// segments: one way on every bar, the trace's time strip (its own lane and the lanes of its calls) and the Profile
// tab's packages, in the console and in the panel, light and dark.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { chooseTheme, openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

/**
 * The lit segments' ring colours against their fills, solid (a translucent fill rings in its colour, opaque): a ring
 * in a colour of its own (black, white) differs. A hatched wait's fill is its hatching's grey, which is its ring.
 */
async function rings(segments: Locator): Promise<{ ring: string; fill: string }[]> {
  return segments.evaluateAll((all) => {
    /** A colour without its alpha, in one notation: "rgb(r, g, b)" from rgb(), rgba() and color(srgb). */
    const solid = (colour: string): string => {
      const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(colour);
      if (srgb)
        return `rgb(${srgb
          .slice(1, 4)
          .map((part) => Math.round(Number(part) * 255))
          .join(", ")})`;
      const rgb = /^rgba?\((\d+), (\d+), (\d+)/.exec(colour);
      if (rgb) return `rgb(${rgb.slice(1, 4).join(", ")})`;
      return colour.replace(/ \/ [\d.]+\)$/, ")");
    };
    return all.map((each) => {
      const style = getComputedStyle(each);
      const fill = "waiting" in (each as HTMLElement).dataset ? style.outlineColor : style.backgroundColor;
      return { ring: style.outlineStyle === "solid" ? solid(style.outlineColor) : "none", fill: solid(fill) };
    });
  });
}

async function checkStrip(scope: Page | FrameLocator): Promise<void> {
  const strip = scope.getByRole("region", { name: "Time" });
  const query = strip.locator('.dt-mark[data-lit-key="sql"]').first();
  await query.hover({ force: true });

  const lit = strip.locator(".dt-mark[data-lit]");
  await expect(lit).toHaveCount(1);
  for (const { ring, fill } of await rings(lit)) expect(ring).toBe(fill);
  await expect(strip.locator(".dt-share[data-lit]")).toHaveText([/^Database/]);

  await strip.getByRole("button", { name: /^Database/ }).hover();

  const stretches = strip.locator('.dt-stretch[data-category="sql"]');
  await expect(strip.locator(".dt-stretch[data-lit]")).toHaveCount(await stretches.count());
  for (const { ring, fill } of await rings(stretches)) expect(ring).toBe(fill);
  await expect(strip.locator('.dt-mark[data-lit-key="sql"]:not([data-lit])')).toHaveCount(0);
}

test("on the time strip a query's mark lights in its own colour with Database, and Database its stretches", async ({
  page,
}) => {
  await chooseTheme(page, "light");
  await page.goto(`/#/t/${await traceId("GET /account/orders/")}`);

  await checkStrip(page);
});

test("in the panel, dark, the strip lights the same way", async ({ page }) => {
  await openApp(page, {
    home: { status: 200, trace: await traceId("GET /account/orders/"), queries: 151, totalMs: 28 },
  });
  await page.getByRole("button", { name: "Load home" }).click();
  await pill(page).click();
  await panel(page)
    .getByRole("tab", { name: /^Call tree/ })
    .click();

  await checkStrip(panel(page));
});

test("the Profile tab's package bar lights a package in its own colour with its legend item, both ways", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("GET /reports/sales")}?tab=profile`);
  const packages = page.getByRole("region", { name: "Time by package" });
  const segments = packages.locator(".dt-share-bar > span");
  await segments.nth(1).hover();

  await expect(packages.locator(".dt-share[data-lit]")).toHaveText([/^django\.template/]);
  for (const { ring, fill } of await rings(packages.locator(".dt-share-bar > span[data-lit]"))) expect(ring).toBe(fill);

  await packages.getByRole("button", { name: /^your code/ }).hover();

  await expect(segments.last()).toHaveAttribute("data-lit", "");
  await expect(packages.locator(".dt-share-bar > span[data-lit]")).toHaveCount(1);
});
