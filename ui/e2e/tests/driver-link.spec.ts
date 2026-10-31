// A datastore client's own HTTP request (a driver's transport) leaves the call tree, its time in the call it served,
// but one that reached a service which records traces too still links the two: the called trace hangs under that
// call in the caller's tree, and is called by the caller's trace.
import { CONSOLE, RUN_STARTED } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const W3C = "5d7c3e1a9b2f4c6d8e0a1b2c3d4e5f60";
const CALLER = "01M5DR1VERPATH000000000001";
const CALLEE = "01M5DR1VERPATH000000000002";

function span(
  id: string,
  parent: string | null,
  kind: string,
  name: string,
  start: number,
  duration: number,
  attrs: Doc = {},
): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start, duration, status: "ok", attrs };
}

function trace(id: string, app: string, name: string, start: number, duration: number, attrs: Doc, spans: Doc[]): Doc {
  return {
    id,
    kind: "http",
    name,
    start,
    duration,
    status: "ok",
    attrs: { "service.name": app, "w3c.trace_id": W3C, "http.method": name.split(" ")[0], ...attrs },
    spans: [span(`${id}-r`, null, "http", name, start, duration), ...spans],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
}

/** The report's search, whose client posted it over HTTP to a search API that records traces of its own. */
async function seed(): Promise<void> {
  const start = Number(process.env[RUN_STARTED] ?? Date.now()) * 1000 - 2 * 3_600_000_000;
  const report = trace(CALLER, "reports", "GET /report", start, 100_000, { "http.route": "/report" }, [
    span(`${CALLER}-q`, `${CALLER}-r`, "elasticsearch", "search books", start + 10_000, 60_000, {
      "db.system": "elasticsearch",
      "db.operation.name": "search",
      "server.address": "search",
      "server.port": 9200,
    }),
    span(`${CALLER}-h`, `${CALLER}-q`, "http.client", "POST search/books/_search", start + 12_000, 50_000, {
      "http.request.method": "POST",
      "url.full": "http://search:9200/books/_search",
      "http.response.status_code": 200,
      "w3c.span_id": "00f067aa0ba902d1",
    }),
  ]);
  const search = trace(
    CALLEE,
    "search-api",
    "POST /books/_search",
    start + 15_000,
    40_000,
    { "http.route": "/books/_search", "w3c.parent_span_id": "00f067aa0ba902d1" },
    [],
  );
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([report, search]),
  });
  expect(response.status).toBe(202);
  await expect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${CALLEE}/related`)).json()) as Doc)["called_by"])
    .toMatchObject({ id: CALLER });
}

test("a trace a driver's folded request reached hangs under its search and is called by the caller", async ({
  page,
}) => {
  await seed();
  await page.goto(`/#/t/${CALLER}?tab=tree`);
  const tree = page.getByRole("main");
  const search = tree.getByRole("button", { name: /search books/ });
  const called = tree.getByRole("button", { name: /^app POST \/books\/_search search-api/ });

  // The client's request is gone; the search API's trace is under the search, right below it and a level deeper.
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await expect(called).toBeVisible();
  await expect(tree.getByText("POST search/books/_search")).toHaveCount(0);
  const [above, below] = [
    await search.locator(".dt-map-kind").boundingBox(),
    await called.locator(".dt-map-kind").boundingBox(),
  ];
  expect(above && below && above.y < below.y && above.x < below.x).toBe(true);
  await page.screenshot({ path: process.env["DRIVER_LINK_SHOT"] ?? "test-results/driver-link.png" });

  await page.goto(`/#/t/${CALLEE}?tab=request`);
  const related = page.getByRole("region", { name: "Related traces" });
  await expect(related).toContainText("Called by");
  await expect(related).toContainText("GET /report");
});
