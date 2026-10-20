// Pages that load hold still: with a slow agent, nothing shown is taken away again and nothing shown moves. Each
// test records what the page shows at every change of the DOM, then reads the recording.
import type { Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

interface Frame {
  /** Per watched selector: its first visible element's top and text, or null when none is visible. */
  seen: Record<string, { top: number; text: string } | null>;
}

/** Records the watched elements at every change of the page, into window.frames. */
async function record(page: Page, watch: Record<string, string>): Promise<void> {
  await page.addInitScript((selectors: Record<string, string>) => {
    const frames: Frame[] = [];
    (window as unknown as { frames: Frame[] }).frames = frames;
    const visible = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].find((element) =>
        element.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
      );
    const snap = () => {
      const seen: Frame["seen"] = {};
      for (const [name, selector] of Object.entries(selectors)) {
        const element = visible(selector);
        seen[name] = element
          ? { top: Math.round(element.getBoundingClientRect().top), text: element.innerText.replace(/\s+/g, " ") }
          : null;
      }
      frames.push({ seen });
    };
    new MutationObserver(snap).observe(document, { subtree: true, childList: true, attributes: true });
  }, watch);
}

async function frames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => (window as unknown as { frames: Frame[] }).frames);
}

/** Each answer of the agent a little late, unevenly, as from a store with more in it. */
async function slow(page: Page, pattern = "**/api/**"): Promise<void> {
  await page.route(pattern, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 450));
    await route.continue();
  });
}

/** The distinct places an element was seen at, from when it first showed. */
function tops(recorded: Frame[], name: string): number[] {
  return [...new Set(recorded.flatMap((frame) => (frame.seen[name] ? [frame.seen[name].top] : [])))];
}

/** Whether an element, once shown, stayed shown to the end. */
function stayed(recorded: Frame[], name: string): boolean {
  const first = recorded.findIndex((frame) => frame.seen[name]);
  return first >= 0 && recorded.slice(first).every((frame) => frame.seen[name]);
}

test("the menu shows no entry point it takes away once the counts come", async ({ page }) => {
  await slow(page, "**/api/counts*");
  await record(page, { menu: "aside nav" });

  await page.goto("/#/logs");
  await expect(page.getByRole("complementary").getByRole("link", { name: "Tasks" })).toBeVisible();
  const recorded = await frames(page);
  const final = (recorded.at(-1)?.seen["menu"]?.text ?? "").split(" ");
  const shown = new Set(recorded.flatMap((frame) => (frame.seen["menu"]?.text ?? "").split(" ").filter(Boolean)));

  expect([...shown].filter((word) => !final.includes(word))).toEqual([]);
});

for (const path of ["#/endpoints", "#/tasks", "#/pages", "#/jobs"]) {
  test(`${path}: the filters, the overview, the switch and the list show at once, in their places`, async ({
    page,
  }) => {
    await slow(page);
    await record(page, {
      filters: "fieldset[aria-label=Filters]",
      overview: "main [aria-label=Overview]",
      switch: "main nav[aria-label=List]",
      list: "main table",
    });

    await page.goto(`/${path}`);
    await expect(page.getByRole("main").getByRole("table").first()).toBeVisible();
    await page.waitForTimeout(800);
    const recorded = await frames(page);

    for (const name of ["overview", "switch", "list"]) {
      expect(tops(recorded, name), `${name} moved`).toHaveLength(1);
      expect(stayed(recorded, name), `${name} went away`).toBe(true);
    }

    // The filters come in one step, with every value they offer: never some first, the rest after.
    const filters = new Set(
      recorded.map((frame) => (frame.seen["filters"]?.text ?? "").replace(/\s*\d+ shown$/, "")).filter(Boolean),
    );

    expect([...filters]).toEqual([expect.any(String)]);
  });
}

test("By task to All runs keeps the rows on screen, dimmed, until the runs come", async ({ page }) => {
  await page.goto("/#/tasks");
  await expect(page.getByRole("main").getByRole("table")).toBeVisible();
  await slow(page, "**/api/traces*");
  await record(page, { list: "main table", busy: "main [aria-busy=true] table" });
  await page.reload();
  await expect(page.getByRole("main").getByRole("table")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { frames: Frame[] }).frames.length = 0;
  });

  await page.getByRole("navigation", { name: "List" }).getByRole("link", { name: "All runs" }).click();
  // The runs' table: its own columns, nothing dimmed any more.
  await expect(page.getByRole("main").getByRole("columnheader", { name: "Trace" })).toBeVisible();
  await expect(page.locator("main [aria-busy=true]")).toHaveCount(0);
  const recorded = await frames(page);

  // A table all along: the tasks' (dimmed while the runs load), then the runs'.
  expect(recorded.every((frame) => frame.seen["list"])).toBe(true);
  expect(recorded.some((frame) => frame.seen["busy"])).toBe(true);
});

for (const path of ["#/logs", "#/tasks"]) {
  test(`${path}: with Live on, Live is the only clock`, async ({ page }) => {
    await page.goto(`/${path}`);
    const header = page.getByRole("main").locator("header").first();

    await expect(header.getByRole("button", { name: /^Every 15s/ })).toBeVisible();

    await header.getByText("Live", { exact: true }).click();

    await expect(header.getByText("Live · every 2s")).toBeVisible();
    await expect(header.getByRole("button", { name: /^Every/ })).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Refresh now" })).toBeVisible();

    await header.getByText("Live · every 2s").click();

    await expect(header.getByRole("button", { name: /^Every 15s/ })).toBeVisible();
  });
}

test("a system's tiles fill their row", async ({ page }) => {
  await page.goto("/#/calls/sql");
  const tiles = page.getByRole("region", { name: "Summary" });
  await expect(tiles).toBeVisible();
  const columns = await tiles.evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);

  expect(columns).toBe(await tiles.locator("> *").count());
});

test("an entry point with nothing stored shows no search it then takes away", async ({ page }) => {
  await slow(page);
  await record(page, { search: "main input[type=search]" });

  await page.goto("/#/graphql");
  await expect(page.getByText("No GraphQL traffic yet")).toBeVisible();

  expect((await frames(page)).every((frame) => frame.seen["search"] === null)).toBe(true);
});

test("an issue's requests don't move down when its latest occurrence loads", async ({ page }) => {
  const issues = (await (await page.request.get("/api/issues")).json()).issues as { fingerprint: string }[];
  await slow(page);
  await record(page, { requests: "main section:last-of-type table" });

  await page.goto(`/#/issue/${issues[0]?.fingerprint}`);
  await expect(page.getByRole("main").getByRole("tab").first()).toBeVisible();
  await page.waitForTimeout(800);

  expect(tops(await frames(page), "requests")).toHaveLength(1);
});

test("a trace page's tiles look like the other pages' tiles, with no line under them", async ({ page }) => {
  const look = (element: Element) => {
    const style = getComputedStyle(element);
    return { radius: style.borderRadius, border: style.borderTopWidth, background: style.backgroundColor };
  };
  await page.goto("/#/endpoints");
  const stat = await page
    .getByRole("region", { name: "Overview" })
    .getByText("Requests", { exact: true })
    .locator("..")
    .evaluate(look);
  await page.goto(`/#/t/${await traceId("PATCH /campaigns/{id}/report")}`);
  const metrics = page.locator(".dt-metrics");
  await expect(metrics).toBeVisible();

  expect(await metrics.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
  expect(await metrics.locator(".dt-metric").first().evaluate(look)).toEqual(stat);
});
