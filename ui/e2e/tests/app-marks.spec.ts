// An app's mark on the Services page: an owner's logo only where its policy allows one (Kotlin's), the globe for the
// browser, else a monogram of ours, named for screen readers; in both themes.
import type { Page } from "@playwright/test";
import { chooseTheme } from "../app.ts";
import { expect, test } from "../fixtures.ts";

// What the SDKs report, one app each.
const RUNTIMES: Record<string, string> = {
  books: "Python 3.14 · Django 6.0",
  search: "Python 3.14 · FastAPI 0.120",
  admin: "Python 3.14 · Flask 3.1",
  mailer: "Python 3.14",
  storefront: "Node 26 · Next.js 16.4",
  orders: "Node 26 · Express 5.3.0",
  edge: "Bun 1.3 · Hono 4.9",
  billing: "Java 21 · Spring Boot 4.1",
  ledger: "Kotlin 2.3",
  inventory: "Kotlin 2.3 · Ktor 3.4",
  gateway: "Go 1.27 · gin",
  pricing: "Go 1.27 · net/http",
};

/** The seeded apps, and one more app per runtime above, each with a web role of its own. */
async function manyRuntimes(page: Page): Promise<void> {
  await page.route("**/api/services*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const web = (body.apps as { service: string; role: string }[]).find(
      (app) => app.service === "shop" && app.role === "web",
    );
    for (const [service, runtime] of Object.entries(RUNTIMES)) body.apps.push({ ...web, service, runtime });
    await route.fulfill({ response, json: body });
  });
}

test("each app shows its framework's mark, else its language's, named for screen readers", async ({ page }) => {
  await manyRuntimes(page);
  await page.goto("/#/services");
  const table = page.getByRole("region", { name: "Services" }).getByRole("table");
  const mark = (service: string) =>
    table
      .getByRole("link")
      .filter({ has: page.getByText(service, { exact: true }) })
      .getByRole("img");

  await expect(mark("books")).toHaveAccessibleName("Django");
  await expect(mark("books")).toHaveAttribute("data-mark", "monogram");
  await expect(mark("books")).toHaveAttribute("data-letters", "Dj");
  // CSS draws the letters: the row's text is the app's name, not "Dj".
  await expect(mark("books")).toHaveText("");
  await expect(mark("mailer")).toHaveAttribute("data-letters", "Py");
  await expect(mark("storefront")).toHaveAttribute("data-letters", "Nx");
  await expect(mark("billing")).toHaveAttribute("data-letters", "SB");
  await expect(mark("inventory")).toHaveAttribute("data-letters", "Kt");
  await expect(mark("gateway")).toHaveAccessibleName("Gin");
  await expect(mark("pricing")).toHaveAccessibleName("Go");
  await expect(mark("pricing")).toHaveAttribute("data-letters", "Go");

  await expect(mark("ledger")).toHaveAccessibleName("Kotlin");
  await expect(mark("ledger")).toHaveAttribute("data-mark", "logo");
  // Its own colours, drawn whole: the path filled with its gradient.
  await expect(mark("ledger").locator("path")).toHaveAttribute("fill", /^url\(#dt-logo-/);

  await expect(mark("shop-web")).toHaveAccessibleName("Browser");
  await expect(mark("shop-web")).toHaveClass(/lucide-globe/);
});

for (const theme of ["dark", "light"] as const) {
  test(`a monogram takes the theme's icon colour, the logo keeps its own (${theme})`, async ({ page }) => {
    await chooseTheme(page, theme);
    await manyRuntimes(page);
    await page.goto("/#/services");
    const table = page.getByRole("region", { name: "Services" }).getByRole("table");
    const monogram = table.getByRole("img", { name: "Django" }).first();
    await expect(monogram).toBeVisible();

    const [mark, text] = await monogram.evaluate((svg) => [
      getComputedStyle(svg).color,
      getComputedStyle(svg.closest("a") ?? svg).color,
    ]);

    expect(mark).toBe(text);

    const shots = process.env["APP_MARKS_SHOTS"];
    if (shots) {
      await page.setViewportSize({ width: 1440, height: 1500 });
      await table.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: `${shots}/logos-${theme}.png` });
    }
  });
}
