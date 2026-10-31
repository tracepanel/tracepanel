// Slower than: one menu on every page with times. Its first pick is where the agent calls the page's rows slow (a
// query from 100 ms, a request from 500 ms), then 1 s, 5 s and a time of one's own; a grouped row says how many of
// its own are that slow, and opening it finds those alone.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const PROBE = "01SL0WERTHANPR0BE000000000";
const STATEMENT = 'SELECT * FROM "slow_probe" WHERE "id" = %s';

function span(id: string, parent: string | null, kind: string, name: string, at: [number, number], attrs: Doc): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start: at[0], duration: at[1], status: "ok", attrs };
}

function query(suffix: string, start: number, duration: number): Doc {
  return span(`q${suffix}`, "r", "sql", "SELECT slow_probe", [start, duration], {
    "db.statement": STATEMENT,
    "db.vendor": "postgresql",
    "db.alias": "default",
  });
}

/** A request whose one statement ran three times: 30 ms, 40 ms and 160 ms. */
async function probe(): Promise<void> {
  const start = Date.now() * 1000 - 60_000_000;
  const trace = {
    id: PROBE,
    kind: "http",
    name: "GET /slow-probe",
    start,
    duration: 260_000,
    status: "ok",
    attrs: { "service.name": "shop", "http.method": "GET", "http.route": "/slow-probe" },
    spans: [
      span("r", null, "http", "GET /slow-probe", [start, 260_000], {}),
      query("1", start + 1_000, 30_000),
      query("2", start + 40_000, 40_000),
      query("3", start + 90_000, 160_000),
    ],
    logs: [],
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
      const answer = await fetch(`${CONSOLE}api/calls?system=sql&q=${encodeURIComponent("slow_probe")}`);
      return ((await answer.json()) as { calls: Doc[] }).calls.length;
    })
    .toBe(1);
}

const chip = (page: Page) => page.getByRole("button", { name: /^Slower than\b/ });

test.beforeEach(async () => {
  await probe();
});

test("the Database page's Slower than starts from a slow query, and a row says how many of its calls are", async ({
  page,
}) => {
  await page.goto("/#/calls/sql");
  const region = page.getByRole("region", { name: "Database" });
  const row = region.getByRole("row").filter({ hasText: "SELECT slow_probe" });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(" of ");

  await chip(page).click();

  await expect(page.getByRole("option")).toHaveText(["Slow (over 100 ms)", "1 s", "5 s"]);

  await page.getByRole("option", { name: "Slow (over 100 ms)" }).click();

  await expect(page.getByRole("button", { name: "Edit duration>100ms" })).toBeVisible();
  await expect(chip(page)).toHaveText(/Slow \(over 100 ms\)/);
  await expect(row).toContainText("1 of 3 calls over 100 ms");
  await expect(row.getByRole("cell").nth(1)).toHaveText("1");

  // Opened, the row's requests are those where this query took that long.
  await row.click();
  const requests = region.getByRole("link", { name: "Show 1 request with this query" });
  await expect(requests).toHaveAttribute("href", /call_duration%3E100ms|call_duration>100ms/);
  await requests.click();

  await expect(page.getByRole("button", { name: "Edit call_duration>100ms" })).toBeVisible();
  const traces = page.getByRole("main").locator("tbody tr");
  await expect(traces).toHaveCount(1);
  await expect(traces.first()).toContainText("/slow-probe");
});

test("a time of one's own is written as a duration, and a group with no call that slow is gone", async ({ page }) => {
  await page.goto("/#/calls/sql");
  const region = page.getByRole("region", { name: "Database" });
  const row = region.getByRole("row").filter({ hasText: "SELECT slow_probe" });
  await expect(row).toBeVisible();
  await chip(page).click();
  const own = page.getByRole("textbox", { name: "Milliseconds" });

  // Not a time: said so, and nothing to apply.
  await own.fill("soon");

  await expect(page.getByText("A number of milliseconds, up to a day.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();

  await own.fill("150");
  await own.press("Enter");

  await expect(page.getByRole("button", { name: "Edit duration>150ms" })).toBeVisible();
  await expect(chip(page)).toHaveText(/> 150 ms/);
  await expect(row).toContainText("1 of 3 calls over 150 ms");

  await chip(page).click();
  await page.getByRole("option", { name: "5 s" }).click();

  await expect(page.getByRole("button", { name: "Edit duration>5s" })).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("HTTP's Slower than starts from a slow request, and each endpoint says how many of its requests are", async ({
  page,
}) => {
  await page.goto("/#/endpoints?view=overview");
  await chip(page).click();

  await expect(page.getByRole("option")).toHaveText(["Slow (over 500 ms)", "1 s", "5 s"]);

  await page.getByRole("option", { name: "Slow (over 500 ms)" }).click();

  await expect(page.getByRole("button", { name: "Edit duration>500ms" })).toBeVisible();
  const answer = await fetch(`${CONSOLE}api/endpoints?q=${encodeURIComponent("duration>500ms")}`);
  // The endpoints as the agent counts them: the slow requests of each, and all it has.
  const { endpoints } = (await answer.json()) as { endpoints: Record<string, number>[] };
  expect(endpoints.length).toBeGreaterThan(0);
  const rows = page.getByRole("main").locator("tbody tr");
  await expect(rows).toHaveCount(endpoints.length);
  const [slow, all] = [endpoints[0]?.["calls"], endpoints[0]?.["all_calls"]];
  await expect(rows.first()).toContainText(`${slow} of ${all} ${all === 1 ? "request" : "requests"} over 500 ms`);
});
