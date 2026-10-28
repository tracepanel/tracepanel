// A trace's Profile tab over its chain of calls: each profiled app's own flame (the BFF's, the service's three
// traces' merged), never one flame across apps; what each adds up to; under a row, the BFF's stretch of the row's
// time and the service's traces under it.
import type { Page } from "@playwright/test";
import { chain } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

const scope = (page: Page) => page.getByRole("list", { name: "Scope" });
const sums = (page: Page) => page.getByRole("list", { name: "What the profiles add up to" });
/**
 * The chain with its BFF as an app of its own (`shop-bff`): the stored traces keep the seed's apps, so the console's
 * Services map stays as the other tests know it.
 */
async function bffApart(page: Page): Promise<string> {
  const view = await chain();
  await page.route(`**/api/traces/${view}/chain`, async (route) => {
    const answer = await route.fetch();
    const body = (await answer.json()) as { traces: { app: string; trace: { name: string } }[] };
    for (const each of body.traces) if (each.trace.name === "POST /graphql") each.app = "shop-bff";
    await route.fulfill({ response: answer, json: body });
  });
  return view;
}

const section = (page: Page, app: string) => page.getByRole("region", { name: `Profile of ${app}`, exact: true });

test("a browser's view with no profile of its own: the Profile tab has each app's of its chain", async ({ page }) => {
  const view = await bffApart(page);
  await page.goto(`/#/t/${view}?tab=profile`);

  await expect(page.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
  await expect(scope(page).getByRole("button", { name: /^All apps 2$/ })).toHaveAttribute("aria-pressed", "true");
  await expect(scope(page).getByRole("button", { name: /^shop-bff 1$/ })).toBeVisible();
  await expect(scope(page).getByRole("button", { name: /^shop 3$/ })).toBeVisible();
  await expect(sums(page).getByRole("listitem")).toHaveText([
    /shop-bff\s*8 ms profiled · 4 ms waiting · most in resolveAuthor/,
    /shop\s*3 ms profiled · most in get_author/,
  ]);
  await expect(section(page, "shop-bff")).toContainText("Profile of the whole trace");
  await expect(section(page, "shop")).toContainText("Profile of 3 traces");
  await expect(section(page, "shop")).not.toContainText("resolveAuthor");

  await scope(page)
    .getByRole("button", { name: /^shop 3$/ })
    .click();

  await expect(section(page, "shop-bff")).toHaveCount(0);
  await expect(section(page, "shop")).toContainText("get_author");
});

test("Inside this span: a step's profile is the BFF's stretch of its time and the service's trace under it", async ({
  page,
}) => {
  const view = await bffApart(page);
  await page.goto(`/#/t/${view}?tab=calls`);
  const group = page.getByRole("button", { name: /^function Book\.author/i }).first();
  await group.locator(".dt-map-caret[data-toggle]").click();
  await page
    .getByRole("button", { name: /^function Book\.author \d+(\.\d+)? ms$/i })
    .first()
    .click();
  const under = page.locator(".dt-under-this");

  await expect(under).toContainText("2 profiles");
  await under.getByRole("button", { name: "2 profiles" }).click();

  await expect(page.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".dt-scope-chip")).toContainText("Under Book.author");
  await expect(section(page, "shop-bff")).toContainText(/Profile of 1 ms – 3 ms/);
  await expect(section(page, "shop-bff")).toContainText("2 ms");
  await expect(section(page, "shop")).toContainText("Profile of the whole trace");
});
