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

/**
 * The details pane wheeled to its end, the view itself left where it is (the tree's head still above the pane): the
 * last attribute's row is whole in the pane's box and in the panel's frame.
 */
async function lastAttributeInView(page: Page): Promise<boolean> {
  const pane = panel(page).getByRole("complementary", { name: "Details" });
  const box = await pane.boundingBox();
  if (!box) throw new Error("no details pane");
  await page.mouse.move(box.x + box.width / 2, box.y + 30);
  await page.mouse.wheel(0, 5000);
  const frame = page.frames().find((one) => one !== page.mainFrame());
  if (!frame) throw new Error("no panel frame");
  return frame.evaluate(() => {
    const side = document.querySelector<HTMLElement>(".dt-map-side");
    const rows = side?.querySelectorAll('[aria-label="All attributes"] dl > div');
    const last = rows?.[rows.length - 1]?.getBoundingClientRect();
    const shown = side?.getBoundingClientRect();
    if (!(last && shown)) return false;
    return last.top >= shown.top - 1 && last.bottom <= Math.min(shown.bottom, window.innerHeight) + 1;
  });
}

test("a short panel: the details pane wheels to its last attribute, before and after a resize", async ({ page }) => {
  await openDetails(page);
  await dragTo(page, { y: 700 });
  await expect.poll(async () => (await ends(page)).frame).toBe(300);
  await panel(page)
    .locator("main")
    .evaluate((view) => {
      view.scrollTop = 0;
    });

  await expect.poll(() => lastAttributeInView(page)).toBe(true);

  await dragTo(page, { y: 450 });
  await expect.poll(async () => (await ends(page)).frame).toBe(550);

  await expect.poll(() => lastAttributeInView(page)).toBe(true);

  await dragTo(page, { y: 750 });
  await expect.poll(async () => (await ends(page)).frame).toBe(250);

  await expect.poll(() => lastAttributeInView(page)).toBe(true);
});

test("docked right, the window made shorter: the details pane wheels to its last attribute", async ({ page }) => {
  await openDetails(page);
  await panel(page).getByRole("button", { name: "Dock to right" }).click();
  await expect.poll(async () => (await page.locator("iframe").boundingBox())?.x).toBe(1000);
  await dragTo(page, { x: 300 });
  await expect(panel(page).getByRole("complementary", { name: "Details" })).toBeVisible();

  await expect.poll(() => lastAttributeInView(page)).toBe(true);

  await page.setViewportSize({ width: 1600, height: 450 });
  await expect.poll(async () => (await ends(page)).frame).toBe(450);
  await panel(page)
    .locator("main")
    .evaluate((view) => {
      view.scrollTop = 0;
    });

  await expect.poll(() => lastAttributeInView(page)).toBe(true);
});

/** What a resize edge draws (its `::after`, the line): how thick, and in which colour. */
function line(element: Element, thickness: string): { thickness: number; colour: string } {
  const style = getComputedStyle(element, "::after");
  return { thickness: Number.parseFloat(style.getPropertyValue(thickness)), colour: style.backgroundColor };
}

test("in hand, every resize edge stays a thin neutral line, its hit area wider", async ({ page }) => {
  await openDetails(page);
  const frame = panel(page);
  const neutral = await frame.locator("html").evaluate((html) => {
    const probe = html.ownerDocument.createElement("i");
    probe.style.color = "var(--dt-divider-active)";
    html.ownerDocument.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });

  // The panel's edge, mid-drag.
  const edge = page.locator(".resize");
  const box = await edge.boundingBox();
  if (!box) throw new Error("no resize edge on the panel");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 40, { steps: 3 });
  const panelEdge = { hit: box.height, ...(await edge.evaluate(line, "height")) };
  await page.mouse.up();

  // The list's edge in the panel, mid-drag.
  const split = frame.locator(".split-handle");
  const handle = await split.boundingBox();
  if (!handle) throw new Error("no split handle in the panel");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + 100, { steps: 3 });
  const listEdge = await split.evaluate(line, "width");
  await page.mouse.up();

  // The details pane's edge, mid-drag: what shows is the line between the tree and the pane, the tree's edge.
  const side = frame.locator(".dt-map-resize");
  const sideBox = await side.boundingBox();
  if (!sideBox) throw new Error("no details pane edge");
  await page.mouse.move(sideBox.x + sideBox.width / 2, sideBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(sideBox.x - 40, sideBox.y + 100, { steps: 3 });
  const paneEdge = await side.evaluate((element) => {
    const tree = getComputedStyle(element.parentElement?.querySelector(".dt-map-tree") as Element);
    return {
      thickness: Number.parseFloat(tree.borderRightWidth),
      colour: tree.borderRightColor,
      drawn: getComputedStyle(element).backgroundImage,
    };
  });
  await page.mouse.up();

  expect(panelEdge).toEqual({ hit: 10, thickness: 1, colour: neutral });

  expect(listEdge).toEqual({ thickness: 1, colour: neutral });

  expect(paneEdge).toEqual({ thickness: 1, colour: neutral, drawn: "none" });
});

test("in the panel, the line between the tree and the details drags anywhere along it", async ({ page }) => {
  await openDetails(page);
  const frame = panel(page);
  const pane = frame.getByRole("complementary", { name: "Details" });
  const width = async () => Math.round((await pane.boundingBox())?.width ?? 0);
  const before = await width();
  const edge = await frame.locator(".dt-map-resize").boundingBox();
  const tree = await frame.locator(".dt-map-body[data-side] .dt-map-tree").boundingBox();
  if (!(edge && tree)) throw new Error("no details pane edge");

  // As tall as the tree beside it: the whole line is the edge.
  expect(Math.round(edge.height)).toBe(Math.round(tree.height));

  const y = Math.min(edge.y + edge.height, 1000) - 20;
  await page.mouse.move(edge.x + edge.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 120, y, { steps: 5 });
  await page.mouse.up();

  await expect.poll(width).toBe(before + 120);
});
