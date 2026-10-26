// Inside a trace: a span's details, the tabs, Explore's ways out, and the snapshot a person can send.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

/** The trace of a call to GET /api/posts: 14 queries, 13 of them the same author lookup. */
async function openPostsTrace(page: Page): Promise<void> {
  await page.goto("/#/endpoints?view=overview");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^GET \/api\/posts / })
    .first()
    .click();
  await page.getByRole("table").last().getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 2, name: "/api/posts" })).toBeVisible();
  // From its endpoint's page it opens on its Request tab: the tests start in its call tree.
  await page.getByRole("tab", { name: "Call tree" }).click();
}

test("a repeated query's details: its SQL, how many, and the line that runs it", async ({ page }) => {
  await openPostsTrace(page);
  await page.getByRole("button", { name: /SELECT author .*×13/ }).click();
  const details = page.getByRole("complementary", { name: "Details" });

  await expect(details).toContainText("13 similar queries");
  await expect(details.getByRole("code").first()).toHaveText(
    "SELECT author.id, author.name FROM author WHERE author.id = ?",
  );
  await expect(details).toContainText("app/main.py:60 in posts");

  await details.getByRole("button", { name: "Close the details" }).click();

  await expect(details).toBeHidden();
});

test("the Request tab lists the trace's attributes, the DB tab its queries grouped or in order", async ({ page }) => {
  await openPostsTrace(page);
  await page.getByRole("tab", { name: /^Request/ }).click();
  const panel = page.getByRole("tabpanel");

  await expect(panel.getByRole("definition").filter({ hasText: "FastAPI 0.142.4" }).first()).toBeVisible();
  // The app among the facts, a link to its page; again among the attributes, as service.name.
  await expect(panel.getByRole("link", { name: "shop-api", exact: true })).toHaveAttribute("href", "#/app/shop-api");
  await expect(panel.getByRole("definition").filter({ hasText: "shop-api" })).toHaveCount(2);

  await page.getByRole("tab", { name: /^DB/ }).click();

  await expect(panel).toContainText(/14 queries · 2 unique · \d+(\.\d+)? ms/);
  // A table as the console's: its head, a row per statement; a count beside the repeated one only.
  await expect(panel.getByRole("columnheader")).toHaveText(["Query", "Time", "Share", ""]);
  const queries = panel.locator("tr[aria-expanded]");
  await expect(queries).toHaveCount(2);
  await expect(queries.first()).toContainText(/SELECT author\s*×13/);
  await expect(queries.nth(1).locator(".dt-map-times")).toHaveCount(0);

  await queries.first().click();

  await expect(panel).toContainText("13 similar queries");
  await expect(panel.getByText("Called 13 times from")).toBeVisible();

  await panel.getByRole("tab", { name: "In order" }).click();

  await expect(panel.getByRole("tab", { name: "In order" })).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator("tr[aria-expanded]")).toHaveCount(14);
  await expect(panel.getByText("SELECT author").first()).toBeVisible();
});

test("a query a template made says so in the DB tab; in the call tree its template's row says it", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("GET /")}`);
  await page.getByRole("tab", { name: /^DB/ }).click();
  const panel = page.getByRole("tabpanel");
  const rows = panel.locator("tr[aria-expanded]");
  const authors = rows.filter({ hasText: "SELECT auth_user" });

  await expect(authors.getByTitle(/^From the template blog\/post_list\.html/)).toHaveText(
    "template blog/post_list.html",
  );
  // The posts the view read are its own: no template.
  await expect(rows.filter({ hasText: "SELECT blog_post" }).getByTitle(/^From the template/)).toHaveCount(0);

  await authors.click();

  await expect(panel.getByRole("listitem").first()).toContainText(
    /template blog\/post_list\.html\s*rendered from\s*blog\/views\.py:28 in post_list/,
  );

  await page.getByRole("tab", { name: "Call tree" }).click();

  const query = page.locator(".dt-map-row").filter({ hasText: "SELECT auth_user" });

  // It hangs under the template's own row: the template isn't said again beside it.
  await expect(query).toBeVisible();
  await expect(query.locator(".dt-from-template")).toHaveCount(0);
  await expect(page.locator(".dt-map-row").filter({ hasText: "blog/post_list.html" }).first()).toContainText(
    "template",
  );
});

test("Explore leads to the endpoint's calls, the issue and the logs around the trace", async ({ page }) => {
  await openPostsTrace(page);
  await page.getByRole("button", { name: "Explore" }).click();
  const menu = page.getByRole("menu", { name: "Explore" });

  await expect(menu.getByRole("menuitem")).toHaveCount(3);

  await menu.getByRole("menuitem", { name: /^All requests to GET \/api\/posts/ }).click();

  await expect(page.getByRole("heading", { level: 1, name: "GET /api/posts" })).toBeVisible();

  await openPostsTrace(page);
  await page.getByRole("button", { name: "Explore" }).click();
  await page.getByRole("menuitem", { name: /^Logs around this moment/ }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Logs" })).toBeVisible();
});

test("Share downloads one HTML file that shows the trace with no agent behind it", async ({ page, context }, info) => {
  await openPostsTrace(page);
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share this trace" });

  await expect(dialog.getByRole("checkbox")).not.toBeChecked();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Download snapshot" }).click(),
  ]);
  // Saved under its own name: a browser opens a file by its extension, and the download's path has none.
  const file = info.outputPath(download.suggestedFilename());
  await download.saveAs(file);

  expect(download.suggestedFilename()).toMatch(/\.html$/);
  expect(readFileSync(file, "utf8")).toContain("/api/posts");

  // Offline: the file holds the console and the trace, nothing comes from the agent.
  const offline = await context.newPage();
  await offline.route("http://127.0.0.1/**", (route) => route.abort());
  await offline.emulateMedia({ colorScheme: "light" });
  await offline.goto(`file://${file}`);

  await expect(offline.getByRole("heading", { level: 2, name: "/api/posts" })).toBeVisible();
  // Dark, as the console starts, with no theme chosen and on a light system.
  await expect(offline.locator("html")).toHaveAttribute("data-theme", "dark");
});
