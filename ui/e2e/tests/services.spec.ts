// Services: the map of what calls what, its Mermaid copy and zoom, and the table's way into each app's work.
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

  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^flowchart/);

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
