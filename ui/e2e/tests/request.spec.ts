// A request's Request tab: what it was at a glance, then what it carried, one part at a time, the browser's own
// headers out of the way, and every other attribute as a part of its own.
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

test.beforeEach(async ({ page }) => {
  await page.goto(`/#/t/${await traceId("POST /accounts/login/")}?tab=request`);
});

test("in the console, the trace's header names the request once: the tab doesn't again", async ({ page }) => {
  await expect(page.locator(".dt-trace-head")).toContainText("POST");
  await expect(page.locator(".dt-tabpanel header")).toHaveCount(0);
});

test("its parts switch one at a time; the attributes are a part, not a list under them all", async ({ page }) => {
  const parts = page.getByRole("tablist", { name: "Request details" });

  await expect(parts.getByRole("tab")).toHaveText([
    /^Headers\s*7$/,
    /^Query\s*1$/,
    /^Body$/,
    /^Cookies\s*2$/,
    /^Session\s*1$/,
    /^Response\s*2$/,
    /^Attributes\s*\d+$/,
  ]);
  await expect(page.getByText("location")).toBeHidden();

  await parts.getByRole("tab", { name: /^Response/ }).click();

  await expect(page.getByRole("tabpanel", { name: "Response" })).toContainText("/orders/");
  await expect(page.getByRole("region", { name: "http" })).toBeHidden();

  await parts.getByRole("tab", { name: /^Attributes/ }).click();

  await expect(page.getByRole("region", { name: "http" })).toContainText("status_code");
  await expect(page.getByRole("region", { name: "code" })).toContainText("accounts.views.login");
  await expect(page.getByRole("tabpanel", { name: "Attributes" })).not.toContainText("location");
});

test("the headers the app chose come first; the browser's own fold under a line that opens them", async ({ page }) => {
  const panel = page.getByRole("tabpanel", { name: "Headers" });

  await expect(panel).toContainText("content-type");
  await expect(panel).not.toContainText("user-agent");

  await panel.getByRole("button", { name: "4 more the browser sends with every request" }).click();

  await expect(panel).toContainText("user-agent");
  await expect(panel).toContainText("sec-fetch-mode");
});

test("a form's body reads as its fields, its secrets masked", async ({ page }) => {
  await page.getByRole("tab", { name: "Body" }).click();
  const panel = page.getByRole("tabpanel", { name: "Body" });

  await expect(panel.locator("dt")).toHaveText(["csrfmiddlewaretoken", "username", "password"]);
  await expect(panel.locator("dd")).toHaveText(["********", "ann", "********"]);
});
