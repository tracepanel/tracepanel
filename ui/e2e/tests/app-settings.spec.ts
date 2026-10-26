// An app's settings and versions, as its SDK said them in its hello: on its page in the console (from Services and a
// trace's facts) and on the panel's App tab, what its checks found wrong with it on top; a template's context in the
// call tree.
import { CONSOLE } from "../agent.ts";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

async function agentVersion(): Promise<string> {
  const app = (await (await fetch(`${CONSOLE}api/app?service=shop`)).json()) as { agent: string };
  return app.agent;
}

test("an app's page lists its settings, secrets masked, a filter narrowing them, and its versions", async ({
  page,
}) => {
  await page.goto("/#/services");
  await page
    .getByRole("region", { name: "Services" })
    .getByRole("table")
    .getByRole("link", { name: /^Python shop\b/ })
    .click();
  const settings = page.getByRole("tabpanel", { name: "Settings" });
  const filter = page.getByRole("searchbox", { name: "Filter settings" });

  await expect(page.getByRole("heading", { level: 1, name: "shop" })).toBeVisible();
  // Settings and Versions are one switch, as a request's parts are: Settings first.
  await expect(page.getByRole("tablist", { name: "App details" }).getByRole("tab")).toHaveText([
    "Settings6",
    "Versions5",
  ]);
  await expect(settings.locator("dt")).toHaveText([
    "ALLOWED_HOSTS",
    "DATABASES",
    "DEBUG",
    "SECRET_KEY",
    "SENTRY_DSN",
    "TIME_ZONE",
  ]);
  await expect(settings.getByRole("definition").nth(3)).toHaveText("********");
  await expect(settings.getByRole("definition").nth(4)).toHaveText("'https://********@o1.ingest.sentry.io/1'");

  await filter.fill("postgres");

  await expect(settings.locator("dt")).toHaveText(["DATABASES"]);

  await filter.fill("nothing like it");

  await expect(settings).toContainText("No setting matches “nothing like it”.");

  await page
    .getByRole("tablist", { name: "App details" })
    .getByRole("tab", { name: /^Versions/ })
    .click();
  const versions = page.getByRole("tabpanel", { name: "Versions" });

  await expect(filter).toHaveCount(0);
  await expect(versions.locator("dt")).toHaveText(["Python", "Django", "psycopg", "tracepanel", "tracepanel-agent"]);
  await expect(versions.getByRole("definition").last()).toHaveText(await agentVersion());
});

test("an app's page lists what its checks found on top, the most serious first, each with its id and hint", async ({
  page,
}) => {
  await page.goto("/#/app/shop");
  const warnings = page.getByRole("region", { name: "Warnings" });
  const rows = warnings.getByRole("listitem");

  await expect(warnings.getByRole("heading", { name: "Warnings 4" })).toBeVisible();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText(
    "erroradmin.E410'django.contrib.sessions.middleware.SessionMiddleware' must be",
  );
  await expect(rows.nth(1)).toContainText("warningmodels.W042shop.OrderAuto-created primary key used");
  await expect(rows.nth(1)).toContainText("Configure the DEFAULT_AUTO_FIELD setting");
  // The hello said 0007 and 0008: the migrate job after it applied 0007.
  await expect(rows.nth(2)).toHaveText(
    /^warningmigrationsshop1 unapplied migration: 0008_order_gift_noteRun manage\.py migrate to apply them: the app may not work until then\.As of the last migrate, /,
  );
  await expect(rows.nth(3)).toHaveText(
    "warningmigrationsshopModel changes with no migration: Add field note to orderRun manage.py makemigrations to write one.",
  );
  // Above the settings, which still show.
  await expect(page.getByRole("tabpanel", { name: "Settings" })).toContainText("SECRET_KEY");
});

test("an app whose checks found nothing has no warnings, and its App tab no count", async ({ page }) => {
  await page.route("**/api/app?*", async (route) => {
    const app = await (await route.fetch()).json();
    await route.fulfill({ json: { ...app, checks: [], migrations: { unapplied: [], changes: [] } } });
  });
  await page.goto("/#/app/shop");

  await expect(page.getByRole("tabpanel", { name: "Settings" })).toContainText("SECRET_KEY");
  await expect(page.getByRole("region", { name: "Warnings" })).toHaveCount(0);

  const trace = await traceId("POST /accounts/login/");
  await openApp(page, { login: { status: 302, trace, queries: 1, totalMs: 4 } });
  await page.getByRole("button", { name: "Load login" }).click();
  await pill(page).click();
  const tabs = panel(page).getByRole("tablist", { name: "Trace details" });

  await expect(tabs.getByRole("tab")).toHaveText([/^Request/, "Call tree", "App"]);

  await tabs.getByRole("tab", { name: "App" }).click();

  await expect(panel(page).getByRole("tabpanel", { name: "Settings" })).toContainText("SECRET_KEY");
  await expect(panel(page).getByRole("region", { name: "Warnings" })).toHaveCount(0);
});

test("a request's facts name its app, a link to the app's page", async ({ page }) => {
  await page.goto(`/#/t/${await traceId("POST /accounts/login/")}?tab=request`);
  await page.getByRole("link", { name: "shop", exact: true }).click();

  await expect(page).toHaveURL(/#\/app\/shop$/);
  await expect(page.getByRole("tabpanel", { name: "Settings" })).toContainText("SECRET_KEY");
});

test("the panel's App tab shows the settings and versions of the app that served the request", async ({ page }) => {
  const trace = await traceId("POST /accounts/login/");
  await openApp(page, { login: { status: 302, trace, queries: 1, totalMs: 4 } });
  await page.getByRole("button", { name: "Load login" }).click();
  await pill(page).click();
  const tabs = panel(page).getByRole("tablist", { name: "Trace details" });

  // App comes last: it is about the app, not this request. A request that logged nothing has no Logs tab. Its count is
  // what the app's checks found, red with an error among them.
  await expect(tabs.getByRole("tab")).toHaveText([/^Request/, "Call tree", "App4"]);
  await expect(tabs.getByRole("tab", { name: "App" }).locator(".dt-tab-count")).toHaveAttribute("data-tone", "error");

  await tabs.getByRole("tab", { name: "App" }).click();

  await expect(panel(page).getByRole("region", { name: "Warnings" }).getByRole("listitem")).toHaveCount(4);
  await expect(panel(page).getByRole("tabpanel", { name: "Settings" })).toContainText("SECRET_KEY********");

  await panel(page)
    .getByRole("tablist", { name: "App details" })
    .getByRole("tab", { name: /^Versions/ })
    .click();

  await expect(panel(page).getByRole("tabpanel", { name: "Versions" })).toContainText("Django5.2.7");
});

test("the panel has no App tab for an app whose SDK doesn't say its settings", async ({ page }) => {
  const trace = await traceId("GET /api/posts");
  await openApp(page, { posts: { status: 200, trace, queries: 14, totalMs: 5, issues: 1 } });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  const tabs = panel(page).getByRole("tablist", { name: "Trace details" });

  await expect(tabs.getByRole("tab", { name: "Call tree" })).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "App" })).toHaveCount(0);
});

test("a template's context shows in the call tree, long values folded; a template without one says why", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId("GET /books/")}?tab=tree`);
  await page.getByText("books/list.html").first().click();
  const context = page.getByRole("region", { name: "Template context" });

  await expect(context.locator("dt")).toHaveText(["books", "csrf_token", "request", "genres", "title"]);
  await expect(context.getByRole("definition").nth(0)).toHaveText("<QuerySet of Book, not evaluated>");
  await expect(context.getByRole("definition").nth(1)).toHaveText("********");
  await expect(context).toContainText("2 more names not recorded: over the limit of one template.");
  await expect(page.getByRole("region", { name: "All attributes" })).not.toContainText("template.context");

  await context.getByRole("button", { name: "Show all 42 lines" }).click();

  await expect(context.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");

  await page.getByText("includes/footer.html").first().click();

  await expect(page.getByRole("region", { name: "Template context" })).toContainText(
    "Not recorded: the app's SDK doesn't record a template's context, or capture_template_context is off.",
  );
});
