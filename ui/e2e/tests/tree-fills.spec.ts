// A request whose call another app served, that app's trace stored a moment after the request's: the call tree on
// screen gets it as soon as the agent has it ("served by" the app, under the call), not at the next refresh, and
// "More on its way" stays over the tree until it does.
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
  const note = page.locator(".dt-on-its-way");
  const servedRow = page.locator(".dt-map-row").filter({ hasText: "books" });

  await expect(note).toBeVisible();
  await expect(servedRow).toHaveCount(0);

  // What the page shows every 50 ms from here: the note, and whether the tree has the served trace.
  await page.evaluate(() => {
    const seen: { note: boolean; served: boolean }[] = [];
    (window as unknown as { seen: typeof seen }).seen = seen;
    window.setInterval(() => {
      const rows = [...document.querySelectorAll(".dt-map-row")];
      seen.push({
        note: document.querySelector(".dt-on-its-way") !== null,
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
  expect(seen.filter((each) => !(each.note || each.served))).toEqual([]);
});
