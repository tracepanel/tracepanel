// File storage calls: a kind of their own in the call tree, in a colour of their own, a Storage share of the time and
// its lane, their details, a count in the trace's header, a page of their own and a node in the service map; and
// collectstatic's files and phases on its job's first tab.
import type { Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

async function openGallery(page: Page, tab = "calls"): Promise<void> {
  await page.goto(`/#/t/${await traceId("GET /gallery/")}?tab=${tab}`);
}

function row(page: Page, kind: string, name: string | RegExp) {
  return page.locator(`.dt-map-row[data-kind="${kind}"]`).filter({ hasText: name });
}

test("a storage call's row: its kind, the call and its file, the storage's alias, in a colour of its own", async ({
  page,
}) => {
  await openGallery(page);
  const save = row(page, "storage", "save uploads/2026/10/visit.json");

  await expect(save.locator(".dt-map-kind")).toHaveText("storage");
  await expect(save.locator(".dt-map-text")).toHaveText("save uploads/2026/10/visit.json");

  const colour = (locator: typeof save) =>
    locator.evaluate((element) => getComputedStyle(element).getPropertyValue("--dt-k").trim());
  const storage = await colour(save);

  expect(storage).not.toBe("");
  expect(storage).not.toBe(await colour(row(page, "view", "gallery.views.gallery")));
});

test("a loop's exists() calls fold into one row with their N+1, the same url() twice is a duplicate", async ({
  page,
}) => {
  await openGallery(page);
  const loop = row(page, "storage", "exists avatars/*");

  await expect(loop.locator(".dt-map-times")).toHaveText("×6");
  await expect(loop.locator('[data-slot="badge"]')).toContainText("N+1");

  await page.getByRole("tab", { name: /^Issues/ }).click();

  const issues = page.getByRole("tabpanel");
  await expect(issues.getByRole("heading", { name: "N+1 6 similar storage calls · exists avatars/*" })).toBeVisible();
  await expect(issues.getByRole("heading", { name: "Duplicates 2 identical · url banners/*" })).toBeVisible();
  await expect(page.getByText(/list the directory once with listdir\(\)/)).toBeVisible();
});

test("a storage call's details: the storage, its backend, the operation, the path and the bytes", async ({ page }) => {
  await openGallery(page);
  const details = page.getByRole("complementary", { name: "Details" });
  const value = (label: string) => details.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("+ dd");

  await row(page, "storage", "save uploads/2026/10/visit.json").click();

  await expect(value("Storage")).toHaveText("default");
  await expect(value("Backend")).toHaveText("s3");
  await expect(value("Operation")).toHaveText("save");
  await expect(value("Path")).toHaveText("uploads/2026/10/visit.json");
  await expect(value("Bytes")).toHaveText("2.0 KB");
  await expect(value("Called from")).toHaveText("gallery/views.py:31 in gallery");
});

test("the header counts the storage calls, the time strip has their share and the tree their chip", async ({
  page,
}) => {
  await openGallery(page);

  await expect(page.locator(".dt-trace-facts")).toHaveText(/^· 9 storage calls \d+ ms$/);
  const legend = page.getByRole("list", { name: /^Where the time went/ });
  await expect(legend.locator('[data-category="storage"]')).toContainText("Storage");

  await legend.locator('[data-category="storage"]').click();

  await expect(row(page, "storage", "save uploads/2026/10/visit.json")).toBeVisible();
  await expect(row(page, "storage", "exists avatars/*")).toBeVisible();
});

test("Storage lists its calls by storage, operation and directory, with the backend", async ({ page }) => {
  await page.goto("/#/calls/storage");
  const region = page.getByRole("region", { name: "Storage" });
  const rows = region.getByRole("rowgroup").last().getByRole("row");

  await expect(rows.filter({ hasText: "exists avatars/*" })).toContainText("s3");
  // collectstatic's on the disk, by the staticfiles storage.
  await expect(rows.filter({ hasText: "save css/*" })).toContainText("filesystem");
  // S3's API called directly (the AWS request's HeadObjects and GetObject) is listed with the storages' calls.
  await expect(rows.filter({ hasText: "HeadObject media/thumbs/*" })).toContainText("s3");
  await expect(rows).toHaveCount(9);
});

test("the service map has the storage, by its system's name", async ({ page }) => {
  await page.goto("/#/services");

  await expect(page.getByRole("link", { name: /^Amazon S3 default Storage/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Local disk staticfiles Storage/ })).toBeVisible();
});

test("collectstatic's job tab: its files' counts and each phase's time", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("manage.py collectstatic")}`);
  await page.getByRole("tab", { name: /^Job/ }).click();
  const facts = page.getByRole("tabpanel").locator("dl").first();
  const value = (label: string) =>
    facts.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");

  await expect(value("Files")).toHaveText("12 copied · 0 linked · 400 unmodified · 15 post-processed");
  await expect(value("Copy")).toHaveText("500 ms · 412 files in 380 ms · listing 120 ms");
  await expect(value("Post-process")).toHaveText("390 ms · 15 files in 350 ms · 2 other storage calls");
});
