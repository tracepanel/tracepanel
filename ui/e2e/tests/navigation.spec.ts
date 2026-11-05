// Navigation, as NAVIGATION.md states it: Back returns to exactly where you were (the trace, its tab, its row, its
// rows folded, its sub-views, its scroll), a linked trace opens where the click promises, a trace opened fresh opens
// on one rule in the panel and the console, and the console's address holds the view so a reload or the browser's
// Back and Forward bring it back.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { chain, chainTrace } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

type Scope = Page | FrameLocator;

function tab(scope: Scope, name: RegExp): Locator {
  return scope.getByRole("tablist", { name: "Trace details" }).getByRole("tab", { name });
}

function opened(scope: Scope): Locator {
  return scope.getByRole("tablist", { name: "Trace details" }).getByRole("tab", { selected: true });
}

/** The row of a call merged with the trace it served, by its method and path. */
function hop(scope: Scope, call: string): Locator {
  const text = call.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return scope.getByRole("button", { name: new RegExp(`^http\\.client ${text} served by`, "i") });
}

test("in the console, a linked trace's way back is the trace as it was: crumbs, Esc, the browser's Back and Forward", async ({
  page,
}) => {
  await chain();
  await page.goto(`/#/traces?q=${encodeURIComponent("status:200")}`);
  await page.goto(`/#/t/${chainTrace("view")}?tab=tree`);
  await hop(page, "POST /graphql").click();

  // The row selected is in the address.
  await expect(page).toHaveURL(/[?&]span=/);

  await page.getByRole("link", { name: "Open the trace it served →" }).click();

  await expect(page).toHaveURL(new RegExp(`#/t/${chainTrace("bff")}\\?`));
  await expect(opened(page)).toHaveText(/^Call tree/);
  // The crumbs say the way it came: the view's trace, then this one.
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link", { name: "GET /shelf" })).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page).toHaveURL(new RegExp(`#/t/${chainTrace("view")}\\?`));
  await expect(hop(page, "POST /graphql")).toHaveAttribute("aria-current", "true");

  // Esc went Back as the browser does: Forward is the linked trace again.
  await page.goForward();

  await expect(page).toHaveURL(new RegExp(`#/t/${chainTrace("bff")}\\?`));

  await page.goBack();

  await expect(opened(page)).toHaveText(/^Call tree/);
  await expect(hop(page, "POST /graphql")).toHaveAttribute("aria-current", "true");
});

test("in the console, a reload opens the same view: its tab, its row, the Profile tab's frames", async ({ page }) => {
  await chain();
  await page.goto(`/#/t/${chainTrace("bff")}`);
  await tab(page, /^Profile/).click();
  await page.getByRole("tablist", { name: "Frames shown" }).getByRole("tab", { name: "All frames" }).click();

  await expect(page).toHaveURL(/[?&]tab=profile/);
  await expect(page).toHaveURL(/[?&]frames=all/);

  await page.reload();

  await expect(opened(page)).toHaveText(/^Profile/);
  await expect(
    page.getByRole("tablist", { name: "Frames shown" }).getByRole("tab", { name: "All frames" }),
  ).toHaveAttribute("aria-selected", "true");

  await tab(page, /^Call tree/).click();
  const steps = page.getByRole("button", { name: /^function Book\.author ×3/ });
  await steps.click();
  await page.reload();

  await expect(opened(page)).toHaveText(/^Call tree/);
  await expect(steps).toHaveAttribute("aria-current", "true");
});
