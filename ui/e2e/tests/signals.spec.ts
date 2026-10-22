// Signals in the call tree: a send's row says its sender, its receivers and how many failed (send_robust() keeps the
// trace ok), a receiver's row its file and line or what it raised; their details; the Signals share of the time and
// its chip; repeated sends folded; the sends nobody received in the request's overview.
import type { Page } from "@playwright/test";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

async function openOrder(page: Page, tab = "calls"): Promise<void> {
  await page.goto(`/#/t/${await traceId("POST /orders/")}?tab=${tab}`);
}

function row(page: Page, kind: string, name: string | RegExp) {
  return page.locator(`.dt-map-row[data-kind="${kind}"]`).filter({ hasText: name });
}

test("a send's row: its signal, its sender, its receivers and how many failed, in a colour of its own", async ({
  page,
}) => {
  await openOrder(page);
  const saved = row(page, "signal", "post_save");

  await expect(saved.locator(".dt-map-kind")).toHaveText("signal");
  await expect(saved.locator(".dt-map-text")).toHaveText("post_save");
  await expect(saved.locator(".dt-map-sub")).toHaveText(["shop.Order", "2 receivers"]);
  await expect(saved.locator("[data-failed]")).toHaveText("1 failed");
  // The trace itself is fine: send_robust() caught the error.
  await expect(page.getByText("1 failed")).toHaveCount(1);

  const colour = (locator: typeof saved) =>
    locator.evaluate((element) => getComputedStyle(element).getPropertyValue("--dt-k").trim());
  const signal = await colour(saved);
  const view = await colour(row(page, "view", "shop.views.place_order"));

  expect(signal).not.toBe("");
  expect(signal).not.toBe(view);
  await expect(row(page, "signal", "m2m_changed").locator("[data-failed]")).toHaveCount(0);
});

test("a receiver's row: its dotted path and its file and line, or what it raised in red", async ({ page }) => {
  await openOrder(page);
  const stock = row(page, "function", "shop.receivers.update_stock");
  const warehouse = row(page, "function", "shop.receivers.notify_warehouse");

  await expect(stock.locator(".dt-map-kind")).toHaveText("receiver");
  await expect(stock.locator(".dt-map-sub")).toHaveText("shop/receivers.py:14");
  await expect(warehouse.locator(".dt-map-kind")).toHaveText("receiver");
  await expect(warehouse.locator(".dt-map-sub[data-error]")).toHaveText("ConnectionError: warehouse offline");
  await expect(warehouse.locator(".dt-map-sub[data-error]")).toHaveAttribute("title", /shop\/receivers\.py:21/);
  // A receiver's own query nests under it.
  await expect(row(page, "sql", "UPDATE shop_stock")).toBeVisible();
});

test("a send's details: the signal, its sender, robust, its receivers one a line, and where it was sent", async ({
  page,
}) => {
  await openOrder(page);
  const details = page.getByRole("complementary", { name: "Details" });

  await row(page, "signal", "post_save").click();

  await expect(details.locator(".dt-map-details-title")).toContainText("signal · started at");
  const value = (label: string) => details.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("+ dd");

  await expect(value("Signal")).toHaveText("django.db.models.signals.post_save");
  await expect(value("Sender")).toHaveText("shop.Order");
  await expect(value("Robust")).toHaveText("yes: a receiver's error is caught");
  await expect(value("Receivers")).toHaveText("shop.receivers.update_stock\nshop.receivers.notify_warehouse");
  expect(await value("Receivers").evaluate((element) => (element as HTMLElement).innerText)).toBe(
    "shop.receivers.update_stock\nshop.receivers.notify_warehouse",
  );
  await expect(value("Called from")).toHaveText("shop/views.py:28 in place_order");

  await row(page, "signal", "m2m_changed").click();

  await expect(value("Robust")).toHaveText("no");

  await row(page, "signal", "user_logged_in").click();

  await expect(value("Called from")).toHaveText("django/contrib/auth/__init__.py:152 in login (library)");
});

test("a receiver's details: the function, where it is defined, and what it raised", async ({ page }) => {
  await openOrder(page);
  const details = page.getByRole("complementary", { name: "Details" });
  const value = (label: string) => details.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("+ dd");

  await row(page, "function", "shop.receivers.notify_warehouse").click();

  await expect(details.locator(".dt-map-details-title")).toContainText("receiver · started at");
  await expect(value("Function")).toHaveText("shop.receivers.notify_warehouse");
  await expect(value("Defined at")).toHaveText("shop/receivers.py:21");
  await expect(details.locator(".dt-error-message")).toHaveText("ConnectionError: warehouse offline");
  await expect(details.locator(".dt-error-message .text-error")).toHaveText("ConnectionError");

  await row(page, "function", "shop.receivers.update_stock").click();

  await expect(value("Defined at")).toHaveText("shop/receivers.py:14");
  await expect(details.locator(".dt-error-message")).toHaveCount(0);
});

test("Signals is a share of the time; its chip shows the sends with what their receivers did", async ({ page }) => {
  await openOrder(page);
  const legend = page.getByRole("list", { name: /^Where the time went/ });
  const chip = legend.locator('[data-category="signal"]').getByRole("button");

  await expect(chip).toContainText(/Signals.*\d+%/);
  await expect(legend.locator('[data-category="signal"] .dt-swatch')).toBeVisible();

  await chip.click();

  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "signal", "post_save")).toBeVisible();
  await expect(row(page, "function", "shop.receivers.notify_warehouse")).toBeVisible();
  await expect(row(page, "sql", "UPDATE shop_stock")).toBeVisible();
  await expect(row(page, "sql", "UPDATE shop_stock")).not.toHaveAttribute("data-dim");
  await expect(row(page, "sql", "UPDATE auth_user")).toBeVisible();
  await expect(row(page, "sql", "INSERT shop_order")).toHaveCount(0);
  await expect(row(page, "view", "shop.views.place_order")).toHaveAttribute("data-dim", "");
});

test("a send repeated in a loop folds into one row, ×3; opened, each send is a row", async ({ page }) => {
  await openOrder(page);
  const group = row(page, "signal", /shop\.signals\.order_placed shop\.Order\s*×3/);

  await expect(group).toHaveCount(1);
  await expect(page.locator(".dt-map-row", { hasText: "shop.receivers.email_customer" })).toHaveCount(0);

  await group.click();

  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("complementary", { name: "Details" })).toContainText("3 similar sends");
  await expect(row(page, "signal", "shop.signals.order_placed").filter({ hasNotText: "×3" })).toHaveCount(3);
  // A send that failed a receiver, or whose receivers did more, stays a row of its own.
  await expect(row(page, "signal", "post_save")).toHaveCount(1);
});

test("the request's overview lists the sends nobody received", async ({ page }) => {
  await openOrder(page, "request");
  const fact = page.getByRole("term").filter({ hasText: "Sent with no receiver" });

  await expect(fact).toBeVisible();
  await expect(fact.locator("+ dd")).toHaveText("pre_save shop.Order ×3, pre_delete auth.Group");
});
