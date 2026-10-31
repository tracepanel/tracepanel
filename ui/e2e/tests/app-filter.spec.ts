// Every page's App filter: the app a row came from, `service:` as the sidebar's app scope says it, offered when
// more than one app has rows on the page, one menu on every page.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const appChip = (page: Page) => page.getByRole("button", { name: /^App\b/ });

function span(id: string, parent: string | null, kind: string, name: string, start: number, attrs: Doc): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start, duration: 20_000, status: "ok", attrs };
}

/** A second app, `ledger`: a request that queried its database and logged one line. */
async function ledger(): Promise<void> {
  const start = Date.now() * 1000 - 60_000_000;
  const trace = {
    id: "01L3DGERAPPF1LTER000000000",
    kind: "http",
    name: "POST /entries",
    start,
    duration: 100_000,
    status: "ok",
    attrs: { "service.name": "ledger", "http.method": "POST", "http.route": "/entries" },
    spans: [
      { ...span("r", null, "http", "POST /entries", start, {}), duration: 100_000 },
      span("q", "r", "sql", "INSERT ledger_entry", start + 10_000, {
        "db.statement": 'INSERT INTO "ledger_entry" ("amount") VALUES (%s)',
        "db.vendor": "postgresql",
        "db.alias": "ledger",
      }),
    ],
    logs: [
      // biome-ignore lint/style/useNamingConvention: the trace format.
      { span_id: "r", time: start + 50_000, level: "info", logger: "ledger", message: "entry booked", exception: null },
    ],
    errors: [],
    links: [],
    issues: [],
  };
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([trace]),
  });
  expect(response.status).toBe(202);
  await expect
    .poll(async () => {
      const known = (await (await fetch(`${CONSOLE}api/values`)).json()) as { apps: Record<string, string[]> };
      return known.apps["calls/sql"] ?? [];
    })
    .toContain("ledger");
}

async function pick(page: Page, app: string): Promise<void> {
  await appChip(page).click();
  await page.getByRole("option", { name: app, exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: `Edit service:${app}` })).toBeVisible();
  await expect(appChip(page)).toHaveText(new RegExp(app));
}

test.beforeEach(async () => {
  await ledger();
});

test("the Logs page offers the apps that logged, and finds one app's records", async ({ page }) => {
  await page.goto("/#/logs");
  await pick(page, "ledger");

  const records = page.getByRole("region", { name: "Logs" }).locator("tr[data-record]");
  await expect(records).toHaveCount(1);
  await expect(records).toContainText("entry booked");
});

test("the HTTP page offers its apps, and lists one app's endpoints", async ({ page }) => {
  await page.goto("/#/endpoints");
  await pick(page, "ledger");

  await expect(page.getByRole("main").getByText("/entries").first()).toBeVisible();
  await expect(page.getByRole("main").getByText("/api/orders/")).toHaveCount(0);
});

test("a database's page offers the apps that queried, and lists one app's queries", async ({ page }) => {
  await page.goto("/#/calls/sql");
  await pick(page, "ledger");

  const rows = page.getByRole("main").locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("INSERT ledger_entry");
});

test("a page whose rows come from one app offers no App filter", async ({ page }) => {
  // The agent's answer as a store with one app's records gives it.
  await page.route(
    (url) => url.pathname.endsWith("/api/values"),
    async (route) => {
      const response = await route.fetch();
      const known = (await response.json()) as { apps: Record<string, string[]> };
      await route.fulfill({ response, json: { ...known, apps: { ...known.apps, logs: ["shop"] } } });
    },
  );
  await page.goto("/#/logs");

  await expect(page.getByRole("button", { name: /^Logger\b/ })).toBeVisible();
  await expect(appChip(page)).toHaveCount(0);
});
