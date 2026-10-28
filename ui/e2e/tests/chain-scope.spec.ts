// A trace's DB, HTTP calls and Issues tabs list its whole chain of calls: the service's query, once per call of the
// BFF's Book.author steps, adds up as one statement ×3 in 3 traces, and as one N+1 across apps on the BFF's calls.
// A row of the call tree opens what is under it in each.
import type { Page } from "@playwright/test";
import { chain } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

const sums = (page: Page) => page.locator(".dt-scope-summary-text");
const chip = (page: Page) => page.locator(".dt-scope-chip");

test("the DB tab adds up the chain's queries: the service's, one per call, as one statement", async ({ page }) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=sql`);

  await expect(page.getByRole("tab", { name: /^DB/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /^DB/ })).toContainText("3");
  await expect(sums(page)).toContainText("3 queries");
  await expect(sums(page)).toContainText("on the clock");
  await expect(page.getByText(/SELECT author\s*×3/)).toBeVisible();
  await expect(sums(page)).toHaveText(/^3 queries · 1 unique · \d+(\.\d+)? ms on the clock · slowest \d+(\.\d+)? ms$/);
});

test("Inside this span: a group of steps opens its services' queries; only its own on the chip's menu", async ({
  page,
}) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=calls`);
  await page
    .getByRole("button", { name: /^function Book\.author/i })
    .first()
    .click();
  const under = page.getByRole("list", { name: "Inside these calls" });

  await expect(under.getByRole("button")).toHaveText(["1 issue", "3 queries", "3 HTTP calls", "4 logs", "4 profiles"]);
  await expect(under.getByRole("button", { name: "3 queries" })).toHaveAttribute(
    "title",
    "Open the DB tab scoped to these calls",
  );
  await under.getByRole("button", { name: "3 queries" }).click();

  await expect(page.getByRole("tab", { name: /^DB/ })).toHaveAttribute("aria-selected", "true");
  await expect(chip(page)).toContainText("Under Book.author ×3");
  await expect(sums(page)).toContainText("3 queries");

  await chip(page)
    .getByRole("button", { name: /Under Book\.author/ })
    .click();
  await page.getByRole("menuitemcheckbox", { name: "Only this span" }).click();
  await page.keyboard.press("Escape");

  await expect(page.getByText("No database queries under this.")).toBeVisible();

  await page.getByRole("tab", { name: /^HTTP calls/ }).click();
  await expect(chip(page)).toContainText("In Book.author ×3");
  await expect(page.getByText("No HTTP calls under this.")).toBeVisible();

  await chip(page).getByRole("button", { name: "Back to the whole chain" }).click();
  await expect(sums(page)).toContainText("4 HTTP calls");
});

test("the Issues tab has the chain's N+1 across apps, on the BFF's calls; it leads to them in the call tree", async ({
  page,
}) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=issues`);
  const issue = page.locator(".dt-issue-card").filter({ hasText: "N+1 across apps" });

  await expect(issue).toContainText("3 similar queries in shop · SELECT author · one per call from each `Book.author`");
  await expect(issue).toContainText("across apps");
  await expect(issue.locator(".dt-app-chip")).toHaveText("shop");
  await expect(issue.getByRole("link", { name: /All occurrences/ })).toHaveCount(0);

  await issue.getByRole("button", { name: "In the call tree" }).click();

  await expect(page.getByRole("tab", { name: /^Call tree/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("complementary", { name: "Details" })).toContainText("http.client");
  // The first of the calls: the one its traceparent carried to the service's first trace.
  await expect(page.getByRole("complementary", { name: "Details" })).toContainText("c000000000000001");
});

test("every tab over the chain opens on one header: the apps, then one line of what it adds up to, then its filters", async ({
  page,
}) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=sql`);

  let withApps = 0;
  for (const tab of [/^Issues/, /^DB/, /^HTTP calls/, /^Logs/, /^Profile/]) {
    await page.getByRole("tab", { name: tab }).click();
    const head = page.getByRole("tabpanel").locator(".dt-scope-head");
    const apps = head.getByRole("list", { name: "Scope" }).getByRole("button");

    await expect(head).toHaveCount(1);
    // Its one line says what the list adds up to in words: no app's chip in it.
    await expect(head.locator(".dt-scope-summary")).toHaveCount(1);
    await expect(head.locator(".dt-scope-summary .dt-app-chip")).toHaveCount(0);
    // Where the list has more than one app's: "All apps", pressed, then each app with its mark and how many.
    if ((await apps.count()) === 0) continue;
    withApps += 1;
    await expect(apps.first()).toHaveText(/^All apps\s*\d+$/);
    await expect(apps.first()).toHaveAttribute("aria-pressed", "true");
    expect(await apps.count()).toBeGreaterThan(2);
    for (const app of (await apps.all()).slice(1)) await expect(app.locator(".dt-icon")).toHaveCount(1);
  }
  expect(withApps).toBeGreaterThan(1);
});

test("an N+1 over the calls is a filter in the UI's words: its badge, what it is, how many; the whole title on hover", async ({
  page,
}) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=http`);
  const issue = page
    .getByRole("list", { name: "What the calls add up to" })
    .getByRole("button")
    .filter({ has: page.locator('[data-slot="badge"]') })
    .first();

  await expect(issue.locator('[data-slot="badge"]')).toHaveText("N+1");
  await expect(issue).toHaveAttribute("title", /^N\+1/);
  const font = await issue.locator(".dt-issue-pick-title").evaluate((title) => getComputedStyle(title).fontFamily);
  expect(font).not.toMatch(/mono/i);
});
