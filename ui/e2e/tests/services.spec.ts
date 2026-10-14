// Services: the map of what calls what, its Mermaid copy and zoom, and the table's way into each app's work.
import { expect, test } from "../fixtures.ts";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("the map draws the apps, their systems, and where their work comes from", async ({ page }) => {
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });

  await expect(map.getByRole("link", { name: /^Browser browser/ })).toBeVisible();
  await expect(map.getByRole("link", { name: /^Django web/ }).first()).toBeVisible();
  await expect(map.getByText("Users")).toBeVisible();
  await expect(map.getByText("CLI · cron")).toBeVisible();
});

test("Mermaid copies the map as a flowchart, and zoom changes its scale", async ({ page }) => {
  await page.goto("/#/services");
  const map = page.getByRole("region", { name: "Architecture" });
  await map.getByRole("button", { name: /^Copy as Mermaid/ }).click();

  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^flowchart/);

  const scale = map.getByRole("button", { name: "Actual size" });
  const before = await scale.textContent();
  await map.getByRole("button", { name: "Zoom out" }).click();

  await expect(scale).not.toHaveText(before ?? "");
});

test("a browser app's row opens its pages", async ({ page }) => {
  await page.goto("/#/services");
  await page
    .getByRole("region", { name: "Services" })
    .getByRole("table")
    .getByRole("link", { name: /^Browser shop-web/ })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "Pages" })).toBeVisible();
});

test("a web app's row opens its endpoints, and the console narrows to that app", async ({ page }) => {
  await page.goto("/#/services");
  await page
    .getByRole("region", { name: "Services" })
    .getByRole("table")
    .getByRole("link", { name: /^FastAPI shop-api/ })
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "HTTP" })).toBeVisible();
  // The app switcher names the app now, with its mark.
  await expect(page.getByRole("button", { name: "FastAPI shop-api" })).toBeVisible();
});
