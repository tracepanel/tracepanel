// Switching apps in the sidebar: the menu, the switcher and the page change together. The chosen app's answers are
// held back here, so whatever shows in between is seen: never an item of the last app's menu that then goes, never
// the last app's rows under the new app's name, and the page never wider than the window.
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

interface Sample {
  app: string;
  nav: string[];
  /** The rows seen, by their first cell: an endpoint's method and route. */
  rows: string[];
  wide: boolean;
}

/** Records what the console shows on every change from now on: the switcher's app, the menu, the rows seen. */
async function record(page: Page): Promise<() => Promise<Sample[]>> {
  await page.evaluate(() => {
    const samples: Sample[] = [];
    (window as unknown as { samples: Sample[] }).samples = samples;
    const sample = () => {
      const aside = document.querySelector("aside");
      samples.push({
        app: aside?.querySelector("button[aria-haspopup]")?.textContent?.trim() ?? "",
        nav: [...(aside?.querySelectorAll("nav a") ?? [])].map((link) => link.textContent?.trim() ?? ""),
        rows: [...document.querySelectorAll("main tbody tr")]
          .filter((row) => row.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
          .map((row) => row.querySelector("td")?.textContent?.trim() ?? ""),
        wide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      });
    };
    sample();
    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  return () => page.evaluate(() => (window as unknown as { samples: Sample[] }).samples);
}

/** The answers for `app` come late: what shows while they load is on screen long enough to be seen. */
async function slow(page: Page, app: string): Promise<void> {
  await page.route(
    (url) => url.pathname.includes("/api/") && decodeURIComponent(url.search).includes(app),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    },
  );
}

/** The switcher: its button says the app shown. */
const switcher = (page: Page) => page.locator("aside button[aria-haspopup]");

async function choose(page: Page, app: string): Promise<void> {
  await switcher(page).click();
  // Each choice is named by what runs it and the app: "Browser shop-web".
  await page.getByRole("menuitemradio", { name: new RegExp(`(^| )${app}$`) }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}

const menu = (page: Page) => page.locator("aside nav a");

test("another app's menu shows once its sections are known, and the last app's rows never show under its name", async ({
  page,
}) => {
  await slow(page, "shop-web");
  await page.goto("/#/endpoints");
  await expect(page.locator("[data-first-paint=shown]")).toBeVisible();
  await expect(page.getByRole("main").locator("tbody tr").first()).toBeVisible();
  const before = await menu(page).allTextContents();
  const samples = await record(page);

  await choose(page, "shop-web");
  await expect(switcher(page)).toHaveText("shop-web");
  await expect(page.getByRole("heading", { level: 1, name: "HTTP" })).toBeVisible();
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  const after = (await menu(page).allTextContents()).map((name) => name.trim());
  const seen = await samples();
  const own = seen.at(-1)?.rows ?? [];

  // The browser app has pages, not the server's tasks: the two menus differ, or there would be nothing to see.
  expect(after).toContain("Pages");
  expect(after).not.toContain("Tasks");
  expect(before.map((name) => name.trim())).toContain("Tasks");

  const switched = seen.filter((sample) => sample.app === "shop-web");
  expect(switched.length).toBeGreaterThan(0);
  // Under the new app's name only its own menu, from the first moment: no item shown, then gone.
  for (const sample of switched) expect(sample.nav).toEqual(after);
  // Under its name only its own rows, the ones it ends with (its pages' requests other tests stored, or none): any
  // other is the last app's.
  for (const sample of switched) for (const row of sample.rows) expect(own).toContain(row);
  expect(seen.some((sample) => sample.app !== "shop-web" && sample.rows.some((row) => !own.includes(row)))).toBe(true);
  for (const sample of seen) expect(sample.wide).toBe(false);
});

test("switching back before the first switch answered ends on the app chosen last", async ({ page }) => {
  await slow(page, "shop-web");
  await page.goto("/#/endpoints");
  await expect(page.locator("[data-first-paint=shown]")).toBeVisible();
  await choose(page, "shop");
  await expect(switcher(page)).toHaveText("shop");
  const shop = await menu(page).allTextContents();

  // shop-web's answers come 800 ms late; shop is chosen again before they do.
  await choose(page, "shop-web");
  await choose(page, "shop");
  await page.waitForTimeout(1200);

  await expect(switcher(page)).toHaveText("shop");
  expect(await menu(page).allTextContents()).toEqual(shop);
  await expect(page.getByRole("main").locator("tbody tr").first()).toBeVisible();
});
