// The panel resized: dragged taller or shorter docked at the bottom (never past three quarters of the window), the
// window resized docked right. The details beside the tree follow: their end scrolls into view, and the line between
// the tree and them runs down to the bottom.
import type { Locator, Page } from "@playwright/test";
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
 * Every view in the panel scrolled to its end: whether the details are in view whole (above the frame's bottom),
 * where the line between the tree and the details ends, and the frame's height.
 */
async function ends(page: Page): Promise<{ pane: boolean; divider: number; frame: number }> {
  const frame = page.frames().find((one) => one !== page.mainFrame());
  if (!frame) throw new Error("no panel frame");
  return frame.evaluate(() => {
    const scrollers = [...document.querySelectorAll<HTMLElement>("*")].filter((element) =>
      /auto|scroll/.test(getComputedStyle(element).overflowY),
    );
    for (const element of scrollers) element.scrollTop = element.scrollHeight;
    const box = document.querySelector<HTMLElement>(".panel-wf-details")?.getBoundingClientRect();
    const split = document.querySelector<HTMLElement>(".panel-wf-details-split")?.getBoundingClientRect();
    // Docked right, the details are under the tree: their line runs across, the frame's bottom is theirs.
    const across = document.querySelector('.panel-wf[data-dock="right"]') !== null;
    return {
      pane: box !== undefined && box.top >= -1 && box.bottom <= window.innerHeight + 1,
      divider: Math.round(split?.bottom ?? Number.NaN),
      frame: window.innerHeight,
      ...(across ? { divider: Math.round(box?.bottom ?? Number.NaN) } : {}),
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
  await frame.locator('.tp-map-row[data-kind="sql"]').first().click();
  await expect(frame.getByRole("complementary", { name: "Details" })).toBeVisible();
}

test("dragged taller, the details pane and the line beside it run down to the panel's bottom", async ({ page }) => {
  await openDetails(page);
  await dragTo(page, { y: 100 });

  // Three quarters of the window at most: the page stays in sight above it.
  await expect.poll(async () => (await ends(page)).frame).toBe(750);

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
  await expect.poll(async () => (await ends(page)).frame).toBe(750);
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
  // As wide as it goes (seven tenths of the window), settled: the wheel goes over the details, not the panel on its
  // way.
  await expect.poll(async () => (await page.locator("iframe").boundingBox())?.x).toBe(480);
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
 * The details wheeled to their end, the tree left where it is: the pane scrolled to its last line, and that line in
 * the panel's frame.
 */
async function lastAttributeInView(page: Page): Promise<boolean> {
  const pane = panel(page).getByRole("complementary", { name: "Details" });
  const box = await pane.boundingBox();
  if (!box) throw new Error("no details pane");
  // Over the middle of the details, off their title (its hint, once shown, would take the wheel).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 5000);
  return pane.evaluate((side) => {
    const end = side.scrollTop + side.clientHeight >= side.scrollHeight - 1;
    return end && side.getBoundingClientRect().bottom <= window.innerHeight + 1;
  });
}

test("a short panel: the details pane wheels to its last attribute, before and after a resize", async ({ page }) => {
  await openDetails(page);
  await dragTo(page, { y: 700 });
  await expect.poll(async () => (await ends(page)).frame).toBe(300);
  await panel(page)
    .locator(".panel-wf-rows")
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
  // As wide as it goes (seven tenths of the window), settled: the wheel goes over the details, not the panel on its
  // way.
  await expect.poll(async () => (await page.locator("iframe").boundingBox())?.x).toBe(480);
  await expect(panel(page).getByRole("complementary", { name: "Details" })).toBeVisible();

  await expect.poll(() => lastAttributeInView(page)).toBe(true);

  await page.setViewportSize({ width: 1600, height: 450 });
  await expect.poll(async () => (await ends(page)).frame).toBe(450);
  await panel(page)
    .locator(".panel-wf-rows")
    .evaluate((view) => {
      view.scrollTop = 0;
    });

  await expect.poll(() => lastAttributeInView(page)).toBe(true);
});

/** What a resize edge draws (its `::after` or `::before`, the line): how thick, and in which colour. */
function line(element: Element, [pseudo, thickness]: [string, string]): { thickness: number; colour: string } {
  const style = getComputedStyle(element, pseudo);
  return { thickness: Number.parseFloat(style.getPropertyValue(thickness)), colour: style.backgroundColor };
}

/** An edge of the panel's own, dragged a little and held: the line it draws then. */
async function held(page: Page, edge: Locator, by: { x?: number; y?: number }, pseudo: [string, string]) {
  const box = await edge.boundingBox();
  if (!box) throw new Error("no edge");
  const [x, y] = [box.x + box.width / 2, box.y + Math.min(box.height / 2, 100)];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (by.x ?? 0), y + (by.y ?? 0), { steps: 3 });
  const drawn = {
    hit: Math.round(Math.min(box.width, box.height)),
    ...(await edge.evaluate(line, pseudo)),
  };
  await page.mouse.up();
  return drawn;
}

test("in hand, every resize edge stays a thin neutral line, its hit area wider", async ({ page }) => {
  await openDetails(page);
  const frame = panel(page);
  const neutral = await frame.locator("html").evaluate((html) => {
    const probe = html.ownerDocument.createElement("i");
    probe.style.color = "var(--tp-divider-active)";
    html.ownerDocument.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });

  const panelEdge = await held(page, page.locator(".resize"), { y: -40 }, ["::after", "height"]);
  const barsEdge = await held(page, frame.locator(".panel-wf-split"), { x: 40 }, ["::before", "width"]);
  const detailsEdge = await held(page, frame.locator(".panel-wf-details-split"), { x: -40 }, ["::before", "width"]);

  expect(panelEdge).toEqual({ hit: 10, thickness: 1, colour: neutral });

  // The panel's own edges are its root's 0.5625rem (about 8 px), the line within them 1 px.
  for (const edge of [barsEdge, detailsEdge]) {
    expect(edge).toEqual({ hit: expect.any(Number), thickness: 1, colour: neutral });
    expect(edge.hit).toBeGreaterThanOrEqual(8);
  }
});

test("in the panel, the line between the tree and the details drags anywhere along it", async ({ page }) => {
  await openDetails(page);
  const frame = panel(page);
  const pane = frame.getByRole("complementary", { name: "Details" });
  const width = async () => Math.round((await pane.boundingBox())?.width ?? 0);
  const before = await width();
  const edge = await frame.locator(".panel-wf-details-split").boundingBox();
  const tree = await frame.locator(".panel-wf").boundingBox();
  if (!(edge && tree)) throw new Error("no details edge");

  // The whole line is the edge: down the tree and the details it parts, and on up through the bar over them.
  expect(Math.round(edge.height)).toBeGreaterThanOrEqual(Math.round(tree.height));

  const y = edge.y + edge.height - 20;
  await page.mouse.move(edge.x + edge.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 120, y, { steps: 5 });
  await page.mouse.up();

  await expect.poll(width).toBe(before + 120);
});
