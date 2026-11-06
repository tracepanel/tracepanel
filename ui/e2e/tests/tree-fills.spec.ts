// A request whose call another app served, that app's trace stored a moment after the request's: the call tree on
// screen gets it as soon as the agent has it ("served by" the app, under the call), not at the next refresh, and
// "More on its way" stays over the tree until it does. A trace the agent has, which the tree is still loading, has
// arrived: the note doesn't count it.
import { expect as pollExpect } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const ms = 1_000;

function span(id: string, parent: string | null, kind: string, name: string, start: number, duration: number): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start, duration, status: "ok", attrs: {} as Doc };
}

function trace(id: string, app: string, w3c: string, start: number, attrs: Doc, spans: Doc[]): Doc {
  return {
    id,
    kind: "http",
    name: "POST /graphql",
    start,
    duration: 400 * ms,
    status: "ok",
    attrs: { "service.name": app, "w3c.trace_id": w3c, "http.method": "POST", "http.route": "/graphql", ...attrs },
    spans: [span("rr", null, "http", "POST /graphql", start, 400 * ms), ...spans],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
}

async function send(traces: Doc[]): Promise<void> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(traces),
  });
  expect(response.status).toBe(202);
}

test("a call's trace stored a moment later shows in the call tree at once, the note over the tree until it does", async ({
  page,
}) => {
  // Ids of each run's own (a repeat, a retry): the agent keeps what an earlier run stored.
  const { repeatEachIndex, retry } = test.info();
  const run = repeatEachIndex * 10 + retry;
  const request = `01M4F1115${String(run * 10 + 1).padStart(17, "0")}`;
  const served = `01M4F1115${String(run * 10 + 2).padStart(17, "0")}`;
  const w3c = `f1115${String(run).padStart(27, "0")}`;
  const callSpan = `f1115a${String(run).padStart(10, "0")}`;
  // The request ended a moment ago, its call to the books app before it.
  const start = Date.now() * ms - 600 * ms;
  const call = {
    ...span("c1", "rr", "http.client", "POST 127.0.0.1:4071/graphql", start + 50 * ms, 250 * ms),
    attrs: {
      "http.request.method": "POST",
      "url.full": "http://127.0.0.1:4071/graphql",
      "http.response.status_code": 200,
      "w3c.span_id": callSpan,
    },
  };
  await send([trace(request, "router", w3c, start, {}, [call])]);
  await pollExpect.poll(async () => (await fetch(`${CONSOLE}api/traces/${request}`)).status).toBe(200);

  await page.goto(`/#/t/${request}?tab=tree`);
  const note = page.locator(".tp-on-its-way");
  const servedRow = page.locator(".tp-map-row").filter({ hasText: "books" });

  await expect(note).toBeVisible();
  await expect(servedRow).toHaveCount(0);

  // What the page shows every 50 ms from here: the note, and whether the tree has the served trace.
  await page.evaluate(() => {
    const seen: { note: boolean; served: boolean }[] = [];
    (window as unknown as { seen: typeof seen }).seen = seen;
    window.setInterval(() => {
      const rows = [...document.querySelectorAll(".tp-map-row")];
      seen.push({
        note: document.querySelector(".tp-on-its-way") !== null,
        served: rows.some((row) => row.textContent?.includes("books")),
      });
    }, 50);
  });
  await page.waitForTimeout(1_500);
  // The books app's trace, as its SDK sends it a moment after the request's.
  await send([trace(served, "books", w3c, start + 60 * ms, { "w3c.parent_span_id": callSpan }, [])]);

  await expect(servedRow).toHaveCount(1, { timeout: 3_000 });
  await expect(note).toHaveCount(0);

  const seen = await page.evaluate(() => (window as unknown as { seen: { note: boolean; served: boolean }[] }).seen);
  // Once the agent has it the note goes (the panel's list shows it), the tree a moment later as its links reload:
  // never the note again, and no more than a moment with neither.
  const first = seen.findIndex((each) => each.served);
  expect(seen.slice(first).filter((each) => each.note || !each.served)).toEqual([]);
  expect(seen.filter((each) => !(each.note || each.served)).length).toBeLessThan(20);
});

test("while an opened call trace's links load, the note says nothing of traces the agent has: they have arrived", async ({
  page,
}) => {
  const { repeatEachIndex, retry } = test.info();
  const run = repeatEachIndex * 10 + retry;
  const request = `01M4F1116${String(run * 10 + 1).padStart(17, "0")}`;
  const bff = `01M4F1116${String(run * 10 + 2).padStart(17, "0")}`;
  const books = `01M4F1116${String(run * 10 + 3).padStart(17, "0")}`;
  const w3c = `f1116${String(run).padStart(27, "0")}`;
  const toBff = `f1116a${String(run).padStart(10, "0")}`;
  const toBooks = `f1116b${String(run).padStart(10, "0")}`;
  const start = Date.now() * ms - 600 * ms;
  const callTo = (id: string, port: number, w3cSpan: string, at: number): Doc => ({
    ...span(id, "rr", "http.client", `POST 127.0.0.1:${port}/graphql`, at, 250 * ms),
    attrs: {
      "http.request.method": "POST",
      "url.full": `http://127.0.0.1:${port}/graphql`,
      "http.response.status_code": 200,
      "w3c.span_id": w3cSpan,
    },
  });
  // The whole chain is stored at once: only the middle trace's links are slow to load.
  await send([
    trace(request, "router", w3c, start, {}, [callTo("c1", 4071, toBff, start + 50 * ms)]),
    trace(bff, "bff", w3c, start + 60 * ms, { "w3c.parent_span_id": toBff }, [
      callTo("c2", 4072, toBooks, start + 80 * ms),
    ]),
    trace(books, "books", w3c, start + 90 * ms, { "w3c.parent_span_id": toBooks }, []),
  ]);
  await pollExpect.poll(async () => (await fetch(`${CONSOLE}api/traces/${books}`)).status).toBe(200);
  await page.route(`**/api/traces/${bff}/related`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
  });

  await page.goto(`/#/t/${request}?tab=tree`);
  const note = page.locator(".tp-on-its-way");
  const bffRow = page.locator(".tp-map-row").filter({ hasText: "bff" });
  const booksRow = page.locator(".tp-map-row").filter({ hasText: "books" });
  const toBooksRow = page.locator('.tp-map-row[data-kind="http.client"]').filter({ hasText: "4072" });

  await expect(bffRow.first()).toBeVisible();

  // The chain loaded, the agent has every trace of it: no note saying they haven't arrived (the panel's list shows
  // them all), while the tree still loads the deepest one. The call to it says what it was answered, never "not
  // traced".
  await expect(note).toHaveCount(0, { timeout: 2_000 });
  await expect(booksRow).toHaveCount(0);
  await expect(toBooksRow.locator(".tp-status")).toHaveText("200");
  await expect(toBooksRow.locator('[data-state="untraced"]')).toHaveCount(0);

  await expect(booksRow).toHaveCount(1, { timeout: 5_000 });
  await expect(note).toHaveCount(0);
});
