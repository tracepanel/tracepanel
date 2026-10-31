// Services: the map of what calls what, its numbers on hover, its canvas (pan and zoom), its Mermaid copy, and the
// table's way into each app's work.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("the map draws the apps, their systems, and where their work comes from", async ({ page }) => {
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });

  await expect(map.getByRole("link", { name: /^Browser browser/ })).toBeVisible();
  await expect(map.getByRole("link", { name: /^Django web/ }).first()).toBeVisible();
  await expect(map.getByText("Users")).toBeVisible();
  await expect(map.getByText("CLI · cron")).toBeVisible();
});

test("every line of the map is drawn whole, its bends inside the diagram", async ({ page }) => {
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });
  await expect(map.getByText("CLI · cron")).toBeVisible();

  // Each line's box against the diagram's: a line routed around the boxes once bent past its top, and was cut.
  const outside = await map.locator("svg.absolute").evaluate((svg: SVGSVGElement) => {
    const width = svg.width.baseVal.value;
    const height = svg.height.baseVal.value;
    return [...svg.querySelectorAll<SVGPathElement>("g > path")].filter((path) => {
      const box = path.getBBox();
      return box.x < 0 || box.y < 0 || box.x + box.width > width || box.y + box.height > height;
    }).length;
  });

  expect(outside).toBe(0);
});

test("every line of the map starts and ends on a box, a call from a role the app has no box for too", async ({
  page,
}) => {
  // Calls stored under a role no box is drawn for (traces whose role is "", beside the shop's three): from the
  // shop's box, not from an empty node dagre placed out in space.
  await page.route("**/api/services*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const edge = body.edges.find((one: { service: string }) => one.service === "shop");
    body.edges.push({ ...edge, role: "" });
    body.links.push({
      // biome-ignore-start lint/style/useNamingConvention: the API's fields.
      service: "shop",
      role: "",
      to_service: "todo",
      to_role: "web",
      peer: null,
      traces: 1,
      total: 1,
      errors: 0,
      // biome-ignore-end lint/style/useNamingConvention: the API's fields.
    });
    await route.fulfill({ response, json: body });
  });
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });
  await expect(map.getByText("CLI · cron")).toBeVisible();

  const loose = await map.locator("svg.absolute").evaluate((svg: SVGSVGElement) => {
    const boxes = [...(svg.parentElement?.querySelectorAll<HTMLElement>(":scope > a, :scope > span") ?? [])];
    const on = (point: DOMPoint) =>
      boxes.some((box) => {
        const [left, top] = [box.offsetLeft, box.offsetTop];
        const [right, bottom] = [left + box.offsetWidth, top + box.offsetHeight];
        return point.x >= left - 1 && point.x <= right + 1 && point.y >= top - 1 && point.y <= bottom + 1;
      });
    return [...svg.querySelectorAll<SVGPathElement>("g > path:first-child")]
      .filter((path) => !(on(path.getPointAtLength(0)) && on(path.getPointAtLength(path.getTotalLength()))))
      .map((path) => path.getAttribute("d"));
  });

  expect(loose).toEqual([]);
});

test("Mermaid copies the map as a flowchart, and zoom changes its scale", async ({ page }) => {
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });
  await map.getByRole("button", { name: /^Copy as Mermaid/ }).click();

  const mermaid = await page.evaluate(() => navigator.clipboard.readText());

  expect(mermaid).toMatch(/^flowchart/);
  // Who calls what, no counts on the arrows: the map has none on its lines either.
  expect(mermaid).toContain(" --> ");
  expect(mermaid).not.toMatch(/-->\|/);

  const scale = map.getByRole("button", { name: "Actual size" });
  const before = await scale.textContent();
  await map.getByRole("button", { name: "Zoom out" }).click();

  await expect(scale).not.toHaveText(before ?? "");
});

test("a browser app's row opens its page: no settings from its SDK, and a way to its pages", async ({ page }) => {
  await page.goto("/#/services");
  await page
    .getByRole("region", { name: "Services" })
    .getByRole("table")
    .getByRole("link", { name: /^Browser shop-web/ })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "shop-web" })).toBeVisible();
  await expect(page.getByText("No settings or versions from this app")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Its work" })
    .getByRole("link", { name: /^Pages/ })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "Pages" })).toBeVisible();
});

test("a web app's row opens its page, and the console narrows to that app", async ({ page }) => {
  await page.goto("/#/services");
  await page
    .getByRole("region", { name: "Services" })
    .getByRole("table")
    .getByRole("link", { name: /^FastAPI shop-api/ })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "shop-api" })).toBeVisible();
  // The app switcher names the app now, with its mark.
  await expect(page.getByRole("button", { name: "FastAPI shop-api" })).toBeVisible();

  await page.getByRole("navigation", { name: "Its work" }).getByRole("link", { name: /^HTTP/ }).click();

  await expect(page.getByRole("heading", { level: 1, name: "HTTP" })).toBeVisible();
});

test("an app's mark is its framework's wherever it shows, whichever of its roles is busiest", async ({ page }) => {
  // The shop's worker (Python alone) far busier than its web (Django): its mark is still Django's.
  await page.route("**/api/services*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const app of body.apps as { service: string; role: string; runtime: string | null; traces: number }[]) {
      if (app.service !== "shop") continue;
      app.runtime = app.role === "web" ? "Python 3.12 · Django 6.0" : "Python 3.12";
      if (app.role === "worker") app.traces = 1_000_000;
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto("/#/services");

  const map = page.getByRole("region", { name: "Architecture" });
  await expect(map.getByRole("link", { name: /^Django web/ }).first()).toBeVisible();
  await expect(map.getByRole("link", { name: /^Django worker/ }).first()).toBeVisible();
  await expect(map.getByRole("link", { name: /^Python worker/ })).toHaveCount(0);

  await page
    .getByRole("region", { name: "Services" })
    .getByRole("table")
    .getByRole("link", { name: /^Django shop Python 3\.12 · Django 6\.0/ })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "Django shop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Django shop" })).toBeVisible();
});

test("a call's line leaves its box's right side and arrives at the middle of the other's left", async ({ page }) => {
  await page.goto("/#/services");
  const map = page.getByRole("main").locator("svg path[marker-end]");
  await expect(map.first()).toBeVisible();
  const paths = await map.evaluateAll((lines) => lines.map((line) => line.getAttribute("d") ?? ""));

  // Side to side: one S curve (M … C …), not dagre's bends ending anywhere on a border.
  expect(paths.filter((d) => /^M [\d.-]+ [\d.-]+ C /.test(d)).length).toBeGreaterThan(paths.length / 2);
});

test("a project's frames never overlap: its roles in a layer sit together, one under another", async ({ page }) => {
  await page.goto("/#/services");
  const frames = page.getByRole("main").locator(".border-dashed");
  await expect(frames.first()).toBeVisible();
  const boxes = await frames.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  );
  const overlaps = boxes.flatMap((a, i) =>
    boxes
      .slice(i + 1)
      .filter((b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1),
  );

  expect(boxes.length).toBeGreaterThan(1);
  expect(overlaps).toEqual([]);
});

test("an app's traces with no role are its roles by their kind: one frame per app, every box marked and named", async ({
  page,
}) => {
  await page.goto("/#/services");
  const main = page.getByRole("main");
  await expect(main.locator(".border-dashed").first()).toBeVisible();
  const frames = await main.locator(".border-dashed > span").allTextContents();

  // One frame per app and layer: the shop's role-less requests and tasks are its web's and its worker's.
  expect(frames.filter((name) => name === "shop")).toHaveLength(1);
  expect(frames.filter((name) => name === "blog")).toHaveLength(1);

  const rows = main.locator("table tbody tr").filter({ hasText: "App" });
  for (const row of await rows.all()) await expect(row.locator("td").first().locator("svg").first()).toBeVisible();
});

/** A box's middle on the screen. */
async function placeOf(box: Locator): Promise<{ x: number; y: number }> {
  const at = await box.boundingBox();
  if (!at) throw new Error("the box is not drawn");
  return { x: at.x + at.width / 2, y: at.y + at.height / 2 };
}

/** A point of the canvas off every box: its top-left corner, left of the toolbar and above the diagram. */
async function emptyCanvas(page: Page): Promise<{ x: number; y: number }> {
  const canvas = await page.getByRole("application").boundingBox();
  if (!canvas) throw new Error("no canvas");
  return { x: canvas.x + 12, y: canvas.y + 12 };
}

/**
 * The whole map in view: the other tests' traces make the store's map bigger than the seed's, a box below the
 * canvas's edge at first.
 */
async function fitted(page: Page): Promise<Locator> {
  const map = page.getByRole("region", { name: "Architecture" });
  await map.getByRole("button", { name: "Fit the map" }).click();
  return map;
}

test("a box says what it is and its problems, no counts; its numbers show on hover", async ({ page }) => {
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });
  const browser = map.getByRole("link", { name: /^Browser browser/ });
  const sqlite = map.getByRole("link", { name: /^SQLite .*db\.sqlite3/ });

  await expect(browser).toContainText("1 failed");
  await expect(browser).not.toContainText(/trace|\d ms|\d\.\d s/);
  await expect(sqlite).not.toContainText(/calls?\b|\d ms|\d\.\d s/);

  await fitted(page);
  await browser.hover();
  const tip = page.getByRole("tooltip");

  await expect(tip).toContainText("shop-web · browser");
  await expect(tip).toContainText("Traces");
  await expect(tip).toContainText("p50");
  await expect(tip).toContainText("p95");
  await expect(tip).toContainText(/Errors\s*1 · \d+%/);

  await sqlite.hover();

  await expect(tip).toContainText("Calls");
  await expect(tip).toContainText("Avg per call");
});

test("the canvas is a usable height, and dragging it moves the map", async ({ page }) => {
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });
  const browser = map.getByRole("link", { name: /^Browser browser/ });
  await expect(browser).toBeVisible();
  const canvas = await page.getByRole("application").boundingBox();

  expect(canvas?.height).toBeGreaterThanOrEqual(440);

  const before = await placeOf(browser);
  const from = await emptyCanvas(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y - 40, { steps: 5 });
  await page.mouse.move(from.x + 120, from.y - 80, { steps: 5 });
  await page.mouse.up();
  const after = await placeOf(browser);

  expect({ x: Math.round(after.x - before.x), y: Math.round(after.y - before.y) }).toEqual({ x: 120, y: -80 });
  await expect(page).toHaveURL(/#\/services/);
});

test("a press on a box that jitters still opens it; one that drags only moves the map", async ({ page }) => {
  await page.goto("/#/services");
  const map = await fitted(page);
  const browser = map.getByRole("link", { name: /^Browser browser/ });
  const at = await placeOf(browser);

  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 100, at.y + 40, { steps: 8 });
  await page.mouse.up();

  await expect(page).toHaveURL(/#\/services/);

  const moved = await placeOf(browser);
  await page.mouse.move(moved.x, moved.y);
  await page.mouse.down();
  await page.mouse.move(moved.x + 2, moved.y + 1);
  await page.mouse.up();

  await expect(page).toHaveURL(/#\/pages/);
});

test("the arrow keys and a scroll pan the map, ctrl+wheel and Fit zoom it", async ({ page }) => {
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });
  const browser = map.getByRole("link", { name: /^Browser browser/ });
  const scale = map.getByRole("button", { name: "Actual size" });
  await expect(browser).toBeVisible();
  const start = await placeOf(browser);

  await page.getByRole("application").focus();
  await page.keyboard.press("ArrowRight");

  expect(Math.round((await placeOf(browser)).x - start.x)).toBe(-48);

  const point = await emptyCanvas(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 100);

  // A scroll's 100px, give or take a pixel's rounding.
  await expect.poll(async () => (await placeOf(browser)).y - start.y).toBeCloseTo(-100, -1);

  const before = await scale.textContent();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");

  await expect(scale).not.toHaveText(before ?? "");

  await map.getByRole("button", { name: "Fit the map" }).click();
  const canvas = await page.getByRole("application").boundingBox();
  const diagram = await page.locator("[data-map=diagram]").boundingBox();

  // The whole diagram in the canvas.
  expect(diagram && canvas && diagram.y >= canvas.y && diagram.y + diagram.height <= canvas.y + canvas.height).toBe(
    true,
  );
});

/** A computed CSS colour as sRGB channels: rgb(), or color(srgb …) for a color-mix(). */
function channels(color: string): [number, number, number] {
  const srgb = color.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
  const rgb = color.match(/rgba?\((\d+), (\d+), (\d+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`not a colour: ${color}`);
}

/** WCAG's contrast ratio of two colours. */
function contrast(a: string, b: string): number {
  const luminance = (color: string) => {
    const [r, g, b] = channels(color).map((value) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

for (const theme of ["dark", "light"]) {
  test(`the map's lines and arrowheads stand out from its canvas, its dots stay quiet (${theme})`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("tracepanel:theme", value), theme);
    await page.goto("/#/services");
    const map = page.getByRole("region", { name: "Architecture" });
    const line = map.locator('path[marker-end="url(#arch-arrow-edge)"]').first();
    await expect(line).toBeVisible();
    const colours = await map.evaluate((section) => {
      const head = section.querySelector("#arch-arrow-edge path");
      const root = getComputedStyle(document.documentElement);
      // A dot's colour as the browser computes it: through an element's color.
      const probe = document.createElement("i");
      probe.style.color = root.getPropertyValue("--map-dot");
      section.append(probe);
      const dot = getComputedStyle(probe).color;
      probe.remove();
      return {
        canvas: getComputedStyle(section).backgroundColor,
        line: getComputedStyle(section.querySelector('path[marker-end="url(#arch-arrow-edge)"]') as Element).stroke,
        head: getComputedStyle(head as Element).fill,
        dot,
      };
    });

    // WCAG's non-text contrast: a line and its head at least 3:1 on the canvas, in the line's colour.
    expect(contrast(colours.line, colours.canvas)).toBeGreaterThanOrEqual(3);
    expect(colours.head).toBe(colours.line);

    // The dots a texture under the lines: far below them.
    expect(contrast(colours.dot, colours.canvas)).toBeLessThan(1.3);
  });
}

test("a small map opens at actual size in the canvas's middle, and Fit brings it back there", async ({ page }) => {
  // The shop's web role and two servers it calls: a map far smaller than the canvas.
  const shopWeb = (one: { service: string; role: string }) => one.service === "shop" && one.role === "web";
  await page.route("**/api/services*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const edges = body.edges.filter(shopWeb).slice(0, 2);
    const peers = new Set(edges.map((edge: { peer: string }) => edge.peer));
    await route.fulfill({
      response,
      json: {
        ...body,
        apps: body.apps.filter(shopWeb),
        edges,
        links: [],
        services: body.services.filter((service: { id: string }) => peers.has(service.id)),
      },
    });
  });
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });
  const scale = map.getByRole("button", { name: "Actual size" });
  const middle = async () => {
    const canvas = await page.getByRole("application").boundingBox();
    const diagram = await page.locator("[data-map=diagram]").boundingBox();
    if (!(canvas && diagram)) throw new Error("no map");
    return Math.round(canvas.x + canvas.width / 2 - (diagram.x + diagram.width / 2));
  };

  await expect(scale).toHaveText("100%");
  expect(await middle()).toBe(0);

  await map.getByRole("button", { name: "Zoom in" }).click();
  await map.getByRole("button", { name: "Zoom in" }).click();

  await expect(scale).toHaveText("125%");

  await page.reload();

  // A zoom the user chose is kept.
  await expect(scale).toHaveText("125%");

  await map.getByRole("button", { name: "Fit the map" }).click();

  await expect(scale).toHaveText("100%");
  expect(await middle()).toBe(0);

  await page.reload();

  // Fit forgets the chosen zoom: the map opens fitted again.
  await expect(scale).toHaveText("100%");
});
