// A migrate job: its migrations and their operations on its first tab, a risky operation marked with the issue's chip
// and its reason; their own kinds in the call tree; the risks among the trace's issues; and the app's warning of
// unapplied migrations as of the job, which applied one of them.
import type { Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const INDEX = "CREATE INDEX blocks writes to the table until it is built (AddIndexConcurrently doesn't)";
const IRREVERSIBLE = "RunPython with no reverse: the migration can't be unapplied";

async function openMigrate(page: Page, tab?: string): Promise<void> {
  const id = await traceId("manage.py migrate");
  await page.goto(`/#/t/${id}${tab ? `?tab=${tab}` : ""}`);
}

function row(page: Page, kind: string, name: string | RegExp) {
  return page.locator(`.dt-map-row[data-kind="${kind}"]`).filter({ hasText: name });
}

test("the job's tab: what it did, each migration with its operations, the risky ones marked", async ({ page }) => {
  await openMigrate(page);
  await page.getByRole("tab", { name: /^Job/ }).click();
  const panel = page.getByRole("tabpanel");
  const facts = panel.locator("dl").first();
  const list = panel.getByRole("list", { name: "Migrations" });
  const migrations = list.locator(":scope > li");

  await expect(facts.locator("dt", { hasText: /^Migrations$/ }).locator("+ dd")).toHaveText(
    "1 applied · 1 faked · 2 risky operations",
  );
  await expect(migrations).toHaveCount(2);
  await expect(migrations.nth(0).locator("code").first()).toHaveText("shop.0007_order_gift");
  await expect(migrations.nth(1)).toContainText("giftcards.0001_initial");
  await expect(migrations.nth(1)).toContainText("faked");

  const operations = migrations.nth(0).getByRole("listitem");
  await expect(operations).toHaveCount(3);
  await expect(operations.nth(0)).toContainText("AddField Order.gift");
  await expect(operations.nth(0)).toContainText("atomic");
  await expect(operations.nth(0).locator('[data-kind="migration-risk"]')).toHaveCount(0);
  await expect(operations.nth(1).locator('[data-kind="migration-risk"]')).toHaveText("Migration risk");
  await expect(operations.nth(1)).toContainText(INDEX);
  await expect(operations.nth(2)).toContainText("12 rows");
  await expect(operations.nth(2)).toContainText(IRREVERSIBLE);
});

test("a risky operation's chip opens its issue", async ({ page }) => {
  await openMigrate(page);
  await page.getByRole("tab", { name: /^Job/ }).click();

  await page.getByRole("tabpanel").getByRole("link", { name: "Migration risk" }).first().click();

  await expect(page).toHaveURL(/#\/issue\/[0-9a-f]{16}/);
});

test("the call tree: migrations and operations have their kinds, colour and the risk's chip", async ({ page }) => {
  await openMigrate(page, "tree");
  const migration = row(page, "migration", "shop 0007_order_gift");
  const index = row(page, "migration.operation", "AddIndex Order.shop_order_gift_idx");

  await expect(migration.locator(".dt-map-kind")).toHaveText("migration");
  await expect(migration.locator(".dt-map-text")).toHaveText("shop 0007_order_gift");
  await expect(index.locator(".dt-map-kind")).toHaveText("operation");
  await expect(index.locator('[data-slot="badge"]')).toHaveText("Migration risk");
  await expect(row(page, "migration", "giftcards 0001_initial")).toContainText("faked");
  await expect(row(page, "migration.operation", "RunPython backfill_gift")).toContainText("12 rows");

  const colour = (locator: typeof migration) =>
    locator.evaluate((element) => getComputedStyle(element).getPropertyValue("--dt-k").trim());

  expect(await colour(migration)).not.toBe("");
  expect(await colour(index)).toBe(await colour(migration));
});

test("the risks are the trace's issues, with the migration and the operation where they are", async ({ page }) => {
  await openMigrate(page, "issues");
  const issues = page.getByRole("tabpanel");

  await expect(issues.getByRole("heading", { name: `Migration risk ${INDEX}` })).toBeVisible();
  await expect(issues.getByRole("heading", { name: `Migration risk ${IRREVERSIBLE}` })).toBeVisible();
  await expect(issues.getByText("shop.0007_order_gift · AddIndex Order.shop_order_gift_idx")).toBeVisible();
  await expect(issues.getByText(/AddIndexConcurrently \(django\.contrib\.postgres\.operations\)/)).toBeVisible();
});

test("the app's unapplied migrations are as of the last migrate, which the warning links to", async ({ page }) => {
  await page.goto("/#/app/shop");
  const warning = page
    .getByRole("region", { name: "Warnings" })
    .getByRole("listitem")
    .filter({ hasText: "unapplied migration" });

  await expect(warning).toContainText("1 unapplied migration: 0008_order_gift_note");

  await warning.getByRole("link", { name: /^As of the last migrate, / }).click();

  await expect(page).toHaveURL(new RegExp(`#/t/${await traceId("manage.py migrate")}`));
});
