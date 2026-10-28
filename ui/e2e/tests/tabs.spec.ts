// A trace's tabs at any width, in the panel (either dock) and the console: each one whole in the row or in its
// More menu, none cut.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const TRACE = "GET /account/orders/";
// The console has the app's own page: its trace has no App tab.
const TABS = ["Request", "Call tree", "Issues", "DB", "HTTP calls", "Logs"];
const PANEL_TABS = [...TABS, "App"];
const WIDTHS = [1440, 1024, 768, 480];

/** What the tab row shows: each tab's name and whether it is whole, inside the row and not cut inside itself. */
function shown(row: Locator) {
  return row.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll<HTMLElement>("button")].filter((button) => !button.closest("[inert]"));
    return {
      overflows: element.scrollWidth > element.clientWidth,
      tabs: buttons.map((button) => {
        const own = button.getBoundingClientRect();
        return {
          name: button.title,
          whole:
            own.width > 0 &&
            own.left >= box.left - 0.5 &&
            own.right <= box.right + 0.5 &&
            button.scrollWidth <= button.clientWidth,
        };
      }),
    };
  });
}

/** Every tab of the trace is in the row, whole, or in its More menu. */
async function expectAllReachable(scope: Page | FrameLocator, names: readonly string[]) {
  const tablist = scope.getByRole("tablist", { name: "Trace details" });
  await expect(tablist.getByRole("tab", { name: "Call tree" })).toBeVisible();
  const row = tablist.locator("xpath=..");
  const { overflows, tabs } = await shown(row);

  expect(overflows).toBe(false);
  expect(tabs.filter((tab) => !tab.whole)).toEqual([]);

  const inRow = tabs.map((tab) => tab.name).filter((name) => name !== "More tabs");
  const more = row.getByRole("button", { name: /^More tabs/ });
  let inMenu: string[] = [];
  if (tabs.some((tab) => tab.name === "More tabs")) {
    await more.click();
    await expect(scope.getByRole("menu")).toBeVisible();
    inMenu = await scope.getByRole("menuitem").locator(".dt-tab-label").allTextContents();
    await scope.getByRole("menuitem").first().press("Escape");
  }

  expect([...inRow, ...inMenu].sort()).toEqual([...names].sort());
}

async function openPanel(page: Page, dock: "bottom" | "right") {
  await openApp(page, { orders: { status: 200, trace: await traceId(TRACE), queries: 152, totalMs: 40, issues: 2 } });
  await page.getByRole("button", { name: "Load orders" }).click();
  await pill(page).click();
  if (dock === "right") await panel(page).getByRole("button", { name: "Dock to right" }).click();
  await expect(
    panel(page).getByRole("button", { name: dock === "right" ? /Dock to bottom/ : "Dock to right" }),
  ).toBeVisible();
  // Docked anew, the panel takes its size: measured once it holds still.
  const frame = page.locator("iframe");
  let last = "";
  await expect
    .poll(async () => {
      const size = JSON.stringify(await frame.boundingBox());
      const still = size === last;
      last = size;
      return still;
    })
    .toBe(true);
}

for (const width of WIDTHS) {
  for (const dock of ["bottom", "right"] as const) {
    test(`docked ${dock} in a window ${width} px wide, every tab of the panel's trace is whole or in More`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPanel(page, dock);

      await expectAllReachable(panel(page), PANEL_TABS);
    });
  }

  test(`in a window ${width} px wide, every tab of the console's trace is whole or in More`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/t/${await traceId(TRACE)}`);

    await expectAllReachable(page, TABS);
  });
}

test("a tab chosen from More opens, and takes a place in the row", async ({ page }) => {
  // The list wider than its default: the trace's room is narrow enough that the last tab, App, is in More.
  await page.addInitScript(() => localStorage.setItem("tracepanel:list-width", "320"));
  await page.setViewportSize({ width: 900, height: 900 });
  await openPanel(page, "bottom");
  const tablist = panel(page).getByRole("tablist", { name: "Trace details" });
  await expect(tablist.getByRole("tab", { name: "Call tree" })).toBeVisible();
  const more = panel(page).getByRole("button", { name: /^More tabs/ });

  await expect(more).toHaveAccessibleName(/App/);

  await more.click();
  await panel(page).getByRole("menuitem", { name: /^App/ }).click();

  await expect(tablist.getByRole("tab", { name: /^App/ })).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByRole("tabpanel", { name: "Settings" })).toContainText("SECRET_KEY");
});

test("in the panel's toolbar Explore is an icon, the first after Console, before the panel's own", async ({ page }) => {
  await openPanel(page, "bottom");
  const x = async (name: string) => (await panel(page).getByRole("button", { name, exact: true }).boundingBox())?.x;
  const consoleLink = panel(page).getByRole("link", { name: /^Console/ });
  const toConsole = (await consoleLink.boundingBox())?.x;
  const explore = await x("Explore");

  await expect(panel(page).getByRole("button", { name: "Explore", exact: true })).toHaveText("");
  expect(toConsole !== undefined && explore !== undefined && toConsole < explore).toBe(true);
  expect(explore !== undefined && explore < ((await x("Dock to right")) ?? 0)).toBe(true);

  // Its menu, focused as it opens, keeps its own surface: no focus tint over it, its shadow kept.
  await panel(page).getByRole("button", { name: "Explore", exact: true }).click();
  const menu = panel(page).getByRole("menu", { name: "Explore" });

  await expect(menu).toHaveCSS("background-image", "none");
  await expect(menu).not.toHaveCSS("box-shadow", "none");
});

test("on the trace page the call tree, the Logs tab's table and the loading bar sit on the tabs' edges", async ({
  page,
}) => {
  const id = await traceId(TRACE);
  const edges = async (locator: Locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`${locator} isn't on the page`);
    return [Math.round(box.x), Math.round(box.x + box.width)];
  };
  await page.goto(`/#/t/${id}?tab=calls`);
  const tabs = await edges(page.locator(".dt-tabs").first());

  expect(await edges(page.locator(".dt-map-head").first())).toEqual(tabs);

  await page.getByRole("tab", { name: /^Logs/ }).click();

  expect(await edges(page.locator("[role=tabpanel] table").first())).toEqual(tabs);

  await page.route("**/api/traces/**", async (route) => {
    await new Promise((done) => setTimeout(done, 1500));
    await route.continue().catch(() => undefined);
  });
  await page.goto("/#/endpoints");
  await page.goto(`/#/t/${id}`);

  // Its loading shape (its name, its tabs, its first rows) on the same edges.
  expect(await edges(page.getByRole("main").getByRole("status"))).toEqual(tabs);
});
