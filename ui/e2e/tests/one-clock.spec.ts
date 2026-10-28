// A trace's calls tables say a row's time as the header says the scope's: on the clock, calls side by side counted
// once, what they add up to on hover. Every app is named by one chip. The line between the call tree and its details
// runs the whole height and drags anywhere along it.
import type { Locator, Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { chain, fanout } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

test("a group of calls that ran side by side: its time on the clock, the sum on hover, its share of the header's", async ({
  page,
}) => {
  // /books alone (0–0.9 ms), then three authors overlapping (1.0–1.9, 1.1–2.0, 1.2–2.1 ms): 1.1 ms on the clock,
  // 2.7 ms added up; the four 2.0 ms on the clock.
  const { bff } = await fanout(11, [
    { route: "/books", path: "/books", at: 0 },
    { route: "/authors/{author_id}", path: "/authors/1", at: 1_000 },
    { route: "/authors/{author_id}", path: "/authors/2", at: 1_100 },
    { route: "/authors/{author_id}", path: "/authors/3", at: 1_200 },
  ]);
  await page.goto(`/#/t/${bff}?tab=http`);
  const rows = page.getByRole("tabpanel").locator("tbody > tr");
  const authors = rows.filter({ hasText: "/authors/{id}" });
  const books = rows.filter({ hasText: "/books" });
  const time = (row: Locator) => row.locator("td").nth(1).locator("span");
  const share = (row: Locator) => row.locator("td").nth(2).locator("span");

  await expect(page.locator(".dt-scope-summary-text")).toHaveText(
    "4 HTTP calls · 2 unique · 2 ms on the clock · slowest 0.9 ms",
  );

  await expect(time(authors)).toHaveText("1 ms");
  await expect(time(authors)).toHaveAttribute("title", "3 ms total, 3 HTTP calls");
  await expect(share(authors)).toHaveText("55%");
  await expect(share(authors)).toHaveAttribute("title", /^Of the 2 ms on the clock/);

  await expect(time(books)).toHaveText("0.9 ms");
  await expect(time(books)).not.toHaveAttribute("title");
  await expect(share(books)).toHaveText("45%");

  // The longest on the clock first, as the column shows it: the group (3 ms added up), then /books.
  await expect(rows.locator("td:first-child")).toHaveText([/\/authors\/\{id\}/, /\/books/]);

  await authors.click();

  await expect(page.getByText("3 similar HTTP calls · 1 ms on the clock · 3 ms total")).toBeVisible();
});

/** Every app chip on the page: its class, shape and font. */
function chipLooks(page: Page) {
  return page.locator(".dt-app-chip").evaluateAll((chips) =>
    chips.map((chip) => {
      const style = getComputedStyle(chip);
      return {
        radius: style.borderTopLeftRadius,
        font: style.fontFamily,
        icon: chip.querySelector(".dt-icon") !== null,
      };
    }),
  );
}

test("every app is named by one chip: the filters, the Profile tab's table and headings, the issue, the call tree", async ({
  page,
}) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=profile`);
  const panel = page.getByRole("tabpanel");

  await expect(panel.locator(".dt-profile-sums .dt-app-chip")).toHaveText(["shop"]);
  await expect(panel.locator(".dt-app-profile .dt-app-chip")).toHaveText(["shop"]);

  const looks = [...(await chipLooks(page))];
  let filtered = 0;
  for (const tab of [/^Issues/, /^DB/, /^HTTP calls/, /^Logs/, /^Call tree/]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    // The filters past "All apps" are the app's chip, as a button.
    const filters = panel.getByRole("list", { name: "Scope" }).getByRole("button", { name: /^(?!All apps)/ });
    for (const filter of await filters.all()) {
      await expect(filter).toHaveClass(/\bdt-app-chip\b/);
      filtered += 1;
    }
    looks.push(...(await chipLooks(page)));
  }
  const font = await page.locator("body").evaluate((body) => getComputedStyle(body).fontFamily);

  expect(filtered).toBeGreaterThan(1);
  expect(looks.length).toBeGreaterThan(6);
  expect(new Set(looks.map((look) => JSON.stringify(look)))).toEqual(
    new Set([JSON.stringify({ radius: "999px", font, icon: true })]),
  );
});

/** The call tree's split on the console's trace page: the tree's box, the edge's, the pane's width. */
async function split(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const tree = box(".dt-map-body[data-side] .dt-map-tree");
    const edge = box(".dt-map-resize");
    return {
      tree: { top: Math.round(tree?.top ?? 0), bottom: Math.round(tree?.bottom ?? 0), right: tree?.right ?? 0 },
      edge: { top: Math.round(edge?.top ?? 0), bottom: Math.round(edge?.bottom ?? 0) },
      pane: Math.round(box(".dt-map-side")?.width ?? 0),
      view: window.innerHeight,
    };
  });
}

async function scrollToEnd(page: Page): Promise<void> {
  await page.locator("main").evaluate((main) => {
    main.scrollTop = main.scrollHeight;
  });
}

test("the line between the call tree and its details runs the whole height, before and after scrolling and a resize", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("GET /")}?tab=calls`);
  await page.locator('.dt-map-row[data-kind="sql"]').first().click();
  await expect(page.getByRole("complementary", { name: "Details" })).toBeVisible();

  const first = await split(page);
  expect(first.edge).toEqual({ top: first.tree.top, bottom: first.tree.bottom });
  expect(first.tree.bottom).toBeGreaterThanOrEqual(first.view);

  await scrollToEnd(page);

  await expect.poll(async () => (await split(page)).tree.bottom).toBe(900);

  await page.setViewportSize({ width: 1440, height: 640 });
  await scrollToEnd(page);

  await expect.poll(async () => (await split(page)).tree.bottom).toBe(640);
  const resized = await split(page);
  expect(resized.edge).toEqual({ top: resized.tree.top, bottom: resized.tree.bottom });
});

test("the line drags anywhere along it, the arrow keys move it, and the width is kept", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("GET /")}?tab=calls`);
  await page.locator('.dt-map-row[data-kind="sql"]').first().click();
  await expect(page.getByRole("complementary", { name: "Details" })).toBeVisible();
  const before = await split(page);
  // Low on the line, below the rows the pane shows: the edge is there too.
  const x = before.tree.right;
  const y = Math.min(before.tree.bottom, before.view) - 20;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 150, y, { steps: 5 });
  await page.mouse.up();

  await expect.poll(async () => (await split(page)).pane).toBe(before.pane + 150);

  await page.getByRole("separator", { name: "Resize the details" }).focus();
  await page.keyboard.press("ArrowLeft");

  await expect.poll(async () => (await split(page)).pane).toBe(before.pane + 182);

  await page.reload();
  await page.locator('.dt-map-row[data-kind="sql"]').first().click();

  await expect.poll(async () => (await split(page)).pane).toBe(before.pane + 182);
});
