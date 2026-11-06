// Slower than: one menu on every page with times. Its first pick is where the agent calls the page's rows slow (a
// query from 100 ms, a request from 1 s), then 5 s and a time of one's own; a grouped row says how many of
// its own are that slow, and opening it finds those alone. The rows checked are the test's own (GET /slow-probe):
// other tests store slow requests while these run, so any other row's numbers may change under them.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const PROBE = "01SL0WERTHANPR0BE000000000";
// Two more requests of the probe's endpoint, slow ones (1.2 s and 1.5 s): 2 of its 3 are over 1 s.
const SLOW = ["01SL0WERTHANPR0BE000000001", "01SL0WERTHANPR0BE000000002"];
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

/** A request of the probe's endpoint with no query, `duration` µs long. */
function slowRequest(id: string, start: number, duration: number): Doc {
  return {
    id,
    kind: "http",
    name: "GET /slow-probe",
    start,
    duration,
    status: "ok",
    attrs: { "service.name": "shop", "http.method": "GET", "http.route": "/slow-probe" },
    spans: [span("r", null, "http", "GET /slow-probe", [start, duration], {})],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
}

/** The endpoint's requests as the agent lists them: how many it has stored. */
async function probeRequests(): Promise<number> {
  const answer = await fetch(`${CONSOLE}api/traces?q=${encodeURIComponent("route:/slow-probe")}&limit=10`);
  return ((await answer.json()) as { traces: Doc[] }).traces.length;
}

/**
 * A request whose one statement ran three times: 30 ms, 40 ms and 160 ms; and two more of its endpoint, 1.2 s and
 * 1.5 s long. Stored again before each test, the same ids: the agent keeps one of each.
 */
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
    body: JSON.stringify([
      trace,
      slowRequest(SLOW[0] ?? "", start + 1_000, 1_200_000),
      slowRequest(SLOW[1] ?? "", start + 2_000, 1_500_000),
    ]),
  });
  expect(response.status).toBe(202);
  await expect
    .poll(async () => {
      const answer = await fetch(`${CONSOLE}api/calls?system=sql&q=${encodeURIComponent("slow_probe")}`);
      return ((await answer.json()) as { calls: Doc[] }).calls.length;
    })
    .toBe(1);
  await expect.poll(probeRequests).toBe(3);
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

/** The probe's endpoint's row: its numbers are the test's own. */
const probeRow = (page: Page) => page.getByRole("main").locator("tbody tr").filter({ hasText: "/slow-probe" });

const SAID = "2 of 3 requests over 1 s";

test("HTTP's Slower than starts from a slow request, and each endpoint says how many of its requests are", async ({
  page,
}) => {
  await page.goto("/#/endpoints?view=overview");
  await expect(probeRow(page)).toBeVisible();
  await expect(probeRow(page)).not.toContainText(" of ");
  await chip(page).click();

  await expect(page.getByRole("option")).toHaveText(["Slow (over 1 s)", "5 s"]);

  await page.getByRole("option", { name: "Slow (over 1 s)" }).click();

  await expect(page.getByRole("button", { name: "Edit duration>1s" })).toBeVisible();
  await expect(probeRow(page)).toContainText(SAID);
  // Every endpoint listed has a slow request, and says how many of its own: read at one moment, as drawn.
  const rows = await page.getByRole("main").locator("tbody tr").allInnerTexts();
  for (const row of rows) expect(row).toMatch(/\d+ of \d+ requests? over 1 s/);
});

test("an endpoint opened with Slower than on is a page of its slow requests, N of M as its row said", async ({
  page,
}) => {
  await page.goto(`/#/endpoints?view=overview&q=${encodeURIComponent("duration>1s")}`);
  const row = probeRow(page);
  await expect(row).toContainText(SAID);

  await row.click();

  await expect(page).toHaveURL(/#\/group\/endpoints\/.+q=duration%3E1s/);
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(page.getByText(SAID, { exact: true })).toBeVisible();
  await expect(summary).toContainText("Calls2");

  // Its calls in the list are the slow ones too.
  await page.getByRole("button", { name: "View all 2 calls" }).click();
  await expect(page.getByRole("button", { name: "Edit duration>1s" })).toBeVisible();
  await page.goBack();

  await page.getByRole("link", { name: "All calls" }).click();

  await expect(page).not.toHaveURL(/duration/);
  await expect(summary).toContainText("Calls3");
  await expect(page.getByText(SAID, { exact: true })).toHaveCount(0);
});

test("a list's time is amber where the request is slow for what it is: a request from 1 s", async ({ page }) => {
  await page.goto(`/#/endpoints?view=calls&q=${encodeURIComponent("slow-probe")}`);
  const rows = page.getByRole("main").getByRole("link").filter({ hasText: "/slow-probe" });
  await expect(rows).toHaveCount(3);

  const times = await rows.evaluateAll((links) =>
    links
      .map((link) => link.querySelectorAll("td")[2]?.querySelector("span"))
      .map((time) => ({ time: time?.textContent, amber: time?.classList.contains("text-warn") ?? false }))
      .sort((a, b) => String(a.time).localeCompare(String(b.time))),
  );

  expect(times).toEqual([
    { time: "1.2 s", amber: true },
    { time: "1.5 s", amber: true },
    { time: expect.stringMatching(/ms$/), amber: false },
  ]);
});
