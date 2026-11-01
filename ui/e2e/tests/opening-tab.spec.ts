// The tab a trace opens on when opened fresh (from a list, a search, the panel's list), one rule in the console and
// the panel (NAVIGATION.md, rule 3): the tab its link names; else Error when it failed; else the tab last picked in
// a trace, when it has it (never Profile or App); else its call tree.
import { expect, test } from "../fixtures.ts";

/** The trace's open tab: its own tabs, not a part switch inside one. */
function opened(page: import("@playwright/test").Page) {
  return page.getByRole("tablist", { name: "Trace details" }).getByRole("tab", { selected: true });
}

async function openFirst(page: import("@playwright/test").Page, hash: string) {
  await page.goto(hash);
  await page.getByRole("main").getByRole("table").getByRole("link").first().click();
  await expect(opened(page)).toBeVisible();
}

test("with no tab picked yet, a trace opened from a list opens on its call tree, from HTTP as from Traces", async ({
  page,
}) => {
  await openFirst(page, "/#/endpoints?q=status:200");

  await expect(opened(page)).toHaveText(/^Call tree/);

  await openFirst(page, "/#/traces?q=status:200");

  await expect(opened(page)).toHaveText(/^Call tree/);
});

test("the next trace opens on the tab last picked; Profile picked last doesn't count", async ({ page }) => {
  await openFirst(page, "/#/tasks?q=state:success");
  await page.getByRole("tablist", { name: "Trace details" }).getByRole("tab", { name: /^Task/ }).click();

  await openFirst(page, "/#/tasks?q=state:success");

  await expect(opened(page)).toHaveText(/^Task/);

  await openFirst(page, "/#/endpoints?q=status:200");

  // The same first tab, named for its kind.
  await expect(opened(page)).toHaveText(/^Request/);
});

test("a failed request opens on its error, whatever was picked last", async ({ page }) => {
  await openFirst(page, "/#/endpoints?q=status:200");
  await page
    .getByRole("tablist", { name: "Trace details" })
    .getByRole("tab", { name: /^Request/ })
    .click();

  await openFirst(page, "/#/endpoints?q=status:500");

  await expect(opened(page)).toHaveText(/^Error/);
});
