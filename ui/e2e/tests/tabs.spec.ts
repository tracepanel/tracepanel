// A trace's tabs at any width, in the panel (either dock) and the console: each one whole in the row or in its
// More menu, none cut.
import type { Locator, Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const TRACE = "GET /account/orders/";

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
  const tabs = await edges(page.locator(".tp-tabs").first());

  expect(await edges(page.locator(".tp-map-head").first())).toEqual(tabs);

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
