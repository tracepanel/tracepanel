// A handler's own code before its transaction and after the commit, and the code between the transaction's queries:
// two rows, each named by the samples of its own time. The profile's buckets (10 ms) hold both rows' code at their
// edges; a bucket's samples are the row's whose code takes most of it, so the handler's row isn't named after the
// transaction's loop.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const ID = "01M4C0DER0W5000000000000B1";
const PARALLEL = "01M4C0DER0W5000000000000P1";

function span(id: string, parent: string | null, kind: string, name: string, start: number, duration: number): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start, duration, status: "ok", attrs: {} };
}

function frame(fn: string, inApp: boolean): Doc {
  return {
    function: fn,
    module: inApp ? "app.main" : "starlette.routing",
    file: "app/main.py",
    line: 1,
    // biome-ignore lint/style/useNamingConvention: a frame as the SDKs send it.
    in_app: inApp,
  };
}

function trace(id: string, name: string, start: number, duration: number, spans: Doc[]): Doc {
  return {
    id,
    kind: "http",
    name,
    start,
    duration,
    status: "ok",
    attrs: { "service.name": "library-api", "http.method": "GET", "http.route": name.split(" ")[1] },
    spans,
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
}

/** GET /books: its handler opens a connection, then a transaction whose queries leave gaps; it ends after the commit. */
function books(start: number): Doc {
  const at = (ms: number) => start + ms * 1000;
  const query = (n: number, from: number, ms: number) =>
    span(`q${n}`, "t", "sql", n === 0 ? "SELECT book" : "SELECT genre", at(from), ms * 1000);
  const doc = trace(ID, "GET /books", start, 40_000, [
    span("r", null, "http", "GET /books", at(0), 40_000),
    span("h", "r", "view", "app.main.list_books", at(0.5), 39_000),
    span("c", "h", "sql.connect", "connect postgresql", at(2), 6_000),
    span("t", "h", "transaction", "transaction library", at(10), 20_000),
    query(0, 11, 4),
    query(1, 16, 1),
    query(2, 18, 1),
    query(3, 20, 1),
    query(4, 22, 1),
  ]);
  // Sampled every ms, in 10 ms buckets: get_db before the transaction, book_out in it, serialize after the commit.
  // biome-ignore-start lint/style/useNamingConvention: a profile as the SDKs send it.
  doc["profile"] = {
    interval_us: 1_000,
    samples: 13,
    bucket_us: 10_000,
    frames: [
      frame("run_endpoint", false),
      frame("list_books", true),
      frame("get_db", true),
      frame("book_out", true),
      frame("serialize", true),
    ],
    stacks: [
      { frames: [0, 1, 2], count: 3, at: [[0, 3]] },
      {
        frames: [0, 1, 3],
        count: 8,
        at: [
          [1, 4],
          [2, 4],
        ],
      },
      { frames: [0, 1, 4], count: 2, at: [[3, 2]] },
    ],
  };
  // biome-ignore-end lint/style/useNamingConvention: a profile as the SDKs send it.
  return doc;
}

/** Three calls to another service at once: 10 ms on the clock, 30 ms added up. */
function parallel(start: number): Doc {
  const call = (n: number) => ({
    ...span(`p${n}`, "r", "http.client", `GET /authors/${n}`, start + 1_000, 10_000),
    attrs: { "http.method": "GET", "url.full": `http://library.test/authors/${n}`, "server.address": "library.test" },
  });
  return trace(PARALLEL, "GET /shelf", start, 12_000, [
    span("r", null, "http", "GET /shelf", start, 12_000),
    call(1),
    call(2),
    call(3),
  ]);
}

async function seed(): Promise<void> {
  const start = Date.now() * 1000 - 7 * 3_600_000_000;
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([books(start), parallel(start + 100_000)]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${PARALLEL}`)).status).toBe(200);
}

const codeRows = (page: Page) => page.locator('.dt-map-row[data-kind="code"]');

test("the handler's code row and its transaction's are named by their own time's samples", async ({ page }) => {
  await seed();
  await page.goto(`/#/t/${ID}?tab=tree`);

  await expect(codeRows(page).locator(".dt-map-text")).toHaveText(["book_out", "get_db · serialize"]);
});

test("calls side by side: the tab, the list and the head say their time on the clock, the sum in a tooltip", async ({
  page,
}) => {
  await seed();
  await page.goto(`/#/t/${PARALLEL}?tab=http`);
  const tab = page.getByRole("tab", { name: /^HTTP calls/ });

  await expect(tab.locator(".dt-tab-detail")).toHaveText("10 ms");
  await expect(tab.locator(".dt-tab-detail")).toHaveAttribute("title", "30 ms total");
  const summary = page.locator(".dt-scope-summary-text");
  await expect(summary).toHaveText(/^3 HTTP calls · 1 unique · 10 ms on the clock · slowest \d+ ms$/);
  await expect(summary.locator('[title="30 ms total"]')).toHaveText("10 ms");
  await expect(page.locator(".dt-trace-facts")).toContainText("3 HTTP calls 10 ms");
  await expect(page.locator(".dt-trace-facts")).toHaveAttribute("title", "3 HTTP calls: 30 ms total");
});
