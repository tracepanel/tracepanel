// A call's details pane never scrolls sideways: a long path wraps (a repeated query's "from …" too), and a long
// statement scrolls in its own block.
import type { FrameLocator, Page } from "@playwright/test";
import { chooseTheme, openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const ORIGIN = "src/main/java/shop/catalog/CatalogController.java:109 in card";
// A laptop's width: the pane beside the tree is narrower than the path.
const NARROW = { width: 1100, height: 900 };
const WORD = `catalog_${"product_".repeat(40)}view`;

/** Every query of the trace called from a long Java path, with a statement wider than any pane. */
async function longQueries(page: Page): Promise<void> {
  await page.route("**/api/traces/*", async (route) => {
    const trace = await (await route.fetch()).json();
    const each = (spans: { kind?: string; attrs?: Record<string, unknown>; children?: unknown[] }[]) => {
      for (const span of spans) {
        if (span.kind === "sql" && span.attrs) {
          span.attrs["code.origin"] = ORIGIN;
          span.attrs["db.statement"] = `SELECT ${WORD}.id FROM ${WORD} WHERE ${WORD}.id = %s`;
        }
        each((span.children ?? []) as typeof spans);
      }
    };
    each(trace.spans ?? []);
    await route.fulfill({ json: trace });
  });
}

async function expectNoSideways(scope: Page | FrameLocator): Promise<void> {
  const side = scope.locator(".dt-map-side");
  await expect(side).toContainText("CatalogController.java:109");
  expect(await side.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
}

test("in the console, a query's long path wraps in a repeated query's details pane, which never scrolls sideways", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  await longQueries(page);
  await page.goto(`/#/t/${await traceId("GET /")}?tab=tree`);
  await page.locator('.dt-map-group .dt-map-row[data-kind="sql"]').first().click();

  await expectNoSideways(page);
  await expect(page.locator(".dt-map-side")).toContainText(`from ${ORIGIN}`);
});

test("in the panel too, a query's long path wraps in the details pane", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await chooseTheme(page, "dark");
  await longQueries(page);
  await openApp(page, { home: { status: 200, trace: await traceId("GET /"), queries: 151, totalMs: 28 } });
  await page.getByRole("button", { name: "Load home" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await frame.locator('.dt-map-group .dt-map-row[data-kind="sql"]').first().click();

  await expectNoSideways(frame);
});
