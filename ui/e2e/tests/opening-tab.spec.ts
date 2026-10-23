// The tab a trace opens on: what it was, from an entry point's lists or a group's page; its call tree from anywhere
// else; its error first, wherever it was opened from.
import { expect, test } from "../fixtures.ts";

/** The trace's open tab: its own tabs, not a part switch inside one. */
function opened(page: import("@playwright/test").Page) {
  return page.getByRole("tablist", { name: "Trace details" }).getByRole("tab", { selected: true });
}

async function openFirst(page: import("@playwright/test").Page, hash: string, row?: RegExp) {
  await page.goto(hash);
  const rows = page.getByRole("main").getByRole("table").getByRole("link");
  await (row ? rows.filter({ hasText: row }) : rows).first().click();
  await expect(opened(page)).toBeVisible();
}

test("a request opened from HTTP opens on its Request tab", async ({ page }) => {
  await openFirst(page, "/#/endpoints?q=status:200");

  await expect(opened(page)).toHaveText(/^Request/);
});

test("a run opened from Tasks opens on its Task tab", async ({ page }) => {
  await openFirst(page, "/#/tasks?q=state:success");

  await expect(opened(page)).toHaveText(/^Task/);
});

test("a trace opened from Traces opens on its call tree", async ({ page }) => {
  await openFirst(page, "/#/traces?q=status:200");

  await expect(opened(page)).toHaveText(/^Call tree/);
});

test("a failed request opens on its error, even from HTTP", async ({ page }) => {
  await openFirst(page, "/#/endpoints?q=status:500");

  await expect(opened(page)).toHaveText(/^Error/);
});
