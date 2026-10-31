// A call its trace went out before it ended (a browser's route change; here a request's, so the Pages list keeps
// its rows): no time of its own, so it is drawn to where it was cut, the trace's end, fading out there, on the time strip's lane and in the call tree, never a 0-width
// mark. A call answered 4xx is amber on the lane, as its row is.
import type { Locator } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const ID = "01M4C0TCA11000000000000001";

function span(id: string, parent: string | null, kind: string, name: string, at: [number, number], attrs: Doc): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start: at[0], duration: at[1], status: "ok", attrs };
}

/** A request of 300 ms: a call answered 404 at 20 ms, and one sent at 100 ms that hadn't ended when the trace went out. */
async function store(): Promise<void> {
  const start = Date.now() * 1000 - 6.5 * 3_600_000_000;
  const at = (ms: number) => start + ms * 1000;
  const trace = {
    id: ID,
    kind: "http",
    name: "GET /cut-call",
    start,
    duration: 300_000,
    status: "ok",
    attrs: { "service.name": "shop", "http.method": "GET", "http.route": "/cut-call" },
    spans: [
      span("r", null, "http", "GET /cut-call", [start, 300_000], {}),
      span("c1", "r", "http.client", "GET api.example.com/missing", [at(20), 30_000], {
        "http.request.method": "GET",
        "url.full": "https://api.example.com/missing",
        "http.response.status_code": 404,
      }),
      span("c2", "r", "http.client", "GET api.example.com/slow", [at(100), 0], {
        "http.request.method": "GET",
        "url.full": "https://api.example.com/slow",
        "http.unfinished": true,
      }),
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
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${ID}`)).status).toBe(200);
}

test.beforeEach(async () => {
  await store();
});

/** Where a mark or a bar starts and ends on its track, as shares of it. */
async function span01(item: Locator, track: Locator): Promise<[number, number]> {
  const [box, whole] = [await item.boundingBox(), await track.boundingBox()];
  if (!(box && whole)) throw new Error("not on the page");
  return [(box.x - whole.x) / whole.width, (box.x + box.width - whole.x) / whole.width];
}

test("a call cut short runs to the trace's end on the time strip and in the call tree, fading out there", async ({
  page,
}) => {
  await page.goto(`/#/t/${ID}?tab=tree`);

  const lane = page.locator(".dt-lane").filter({ hasText: "HTTP calls" });
  const cut = lane.locator(".dt-mark[data-cut]");
  await expect(cut).toHaveCount(1);
  await expect(cut).toHaveAttribute("title", /GET api\.example\.com\/slow · hadn't ended when the trace went out/);
  const [from, to] = await span01(cut, lane.locator(".dt-lane-track"));
  expect(from).toBeCloseTo(1 / 3, 1);
  expect(to).toBeCloseTo(1, 2);

  // The 404 is amber on the lane, as its row is in the tree.
  await expect(lane.locator('.dt-mark[data-tone="warn"]')).toHaveAttribute("title", /missing/);

  const row = page.locator('.dt-map-row[data-kind="http.client"]').filter({ hasText: "/slow" });
  const bar = row.locator(".dt-map-bar");
  await expect(bar).toHaveAttribute("data-past", "");
  const [start, end] = await span01(bar, row.locator(".dt-map-track"));
  expect(start).toBeCloseTo(1 / 3, 1);
  expect(end).toBeCloseTo(1, 2);
  // Its time isn't known: no 0 µs.
  await expect(row.locator(".dt-map-time")).toHaveText("—");
});
