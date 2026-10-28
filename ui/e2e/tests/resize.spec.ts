// The panel resized: dragged taller or shorter docked at the bottom, the window resized docked right. The call
// tree's details pane follows the view it scrolls in: its end scrolls into view, and the line between the tree and
// the pane runs down to the bottom.
import type { Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

/** Drags the panel's edge (its top docked at the bottom, its left docked right) to `to`. */
async function dragTo(page: Page, to: { x?: number; y?: number }): Promise<void> {
  const edge = await page.locator(".resize").boundingBox();
  if (!edge) throw new Error("no resize edge on the panel");
  const [x, y] = [edge.x + edge.width / 2, edge.y + edge.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(to.x ?? x, to.y ?? y, { steps: 5 });
  await page.mouse.up();
}

/**
 * Every view in the panel scrolled to its end: whether the details pane is in view whole (under the trace's sticky
 * tabs, above the frame's bottom), where the line between the tree and the pane ends, and the frame's height. A pane
 * taller than the view has its end or its head out of reach; a line in mid-air ends above the frame's bottom.
 */
async function ends(page: Page): Promise<{ pane: boolean; divider: number; frame: number }> {
  const frame = page.frames().find((one) => one !== page.mainFrame());
  if (!frame) throw new Error("no panel frame");
  return frame.evaluate(() => {
    const scrollers = [...document.querySelectorAll<HTMLElement>("*")].filter((element) =>
      /auto|scroll/.test(getComputedStyle(element).overflowY),
    );
    for (const element of scrollers) element.scrollTop = element.scrollHeight;
    const pane = document.querySelector<HTMLElement>(".dt-map-side");
    const tree = document.querySelector<HTMLElement>(".dt-map-body[data-side] .dt-map-tree");
    const box = pane?.getBoundingClientRect();
    const tabs = document.querySelector(".dt-trace")?.querySelector(".dt-trace-strip, .dt-tabs");
    const under = tabs?.getBoundingClientRect().bottom ?? 0;
    return {
      pane: box !== undefined && box.top >= under - 1 && box.bottom <= window.innerHeight + 1,
      divider: Math.round(tree?.getBoundingClientRect().bottom ?? Number.NaN),
      frame: window.innerHeight,
    };
  });
}

/** The call tree of a request with its first query's details beside it, in the panel docked at the bottom. */
async function openDetails(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openApp(page, { home: { status: 200, trace: await traceId("GET /"), queries: 151, totalMs: 28 } });
  await page.getByRole("button", { name: "Load home" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await frame.locator('.dt-map-row[data-kind="sql"]').first().click();
  await expect(frame.getByRole("complementary", { name: "Details" })).toBeVisible();
}

test("dragged taller, the details pane and the line beside it run down to the panel's bottom", async ({ page }) => {
  await openDetails(page);
  await dragTo(page, { y: 100 });

  await expect.poll(async () => (await ends(page)).frame).toBe(900);

  await expect
    .poll(async () => {
      const { divider, frame } = await ends(page);
      return frame - divider;
    })
    .toBeLessThanOrEqual(1);
});

test("dragged shorter, the details pane is in view whole, its own rows scrolling", async ({ page }) => {
  await openDetails(page);
  await dragTo(page, { y: 100 });
  await expect.poll(async () => (await ends(page)).frame).toBe(900);
  await dragTo(page, { y: 700 });

  await expect.poll(async () => (await ends(page)).frame).toBe(300);

  await expect
    .poll(async () => {
      return (await ends(page)).pane;
    })
    .toBe(true);
});

test("docked right, a shorter window: the details pane scrolls to its end, the line runs down", async ({ page }) => {
  await openDetails(page);
  await panel(page).getByRole("button", { name: "Dock to right" }).click();
  // Docked (the panel slides in), then wide enough for the details beside the tree.
  await expect.poll(async () => (await page.locator("iframe").boundingBox())?.x).toBe(1000);
  await dragTo(page, { x: 300 });
  await expect(panel(page).getByRole("complementary", { name: "Details" })).toBeVisible();
  await expect.poll(async () => (await ends(page)).frame).toBe(1000);
  await page.setViewportSize({ width: 1600, height: 500 });

  await expect.poll(async () => (await ends(page)).frame).toBe(500);

  await expect
    .poll(async () => {
      const { pane, divider, frame } = await ends(page);
      return pane && frame - divider <= 1;
    })
    .toBe(true);
});
