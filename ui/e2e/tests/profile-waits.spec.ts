// What a function of yours waited for: the time of a call it made is the call's (the database's, as the time strip
// has it), its row and box named by the call ("SQL postgresql", "HTTP GET analytics.example.com"), in its colour; a
// wait with no call running is waiting's, named by the frame that waited ("waiting · sleep"); a row opens its call in
// the call tree; All frames keeps the frames that waited, the call under them. A Python-shaped
// profile (a FastAPI handler on Postgres) and a JVM-shaped one (a virtual thread parked on Postgres), timed.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const PYTHON = "01M4WA1TS00000000000000001";
const JVM = "01M4WA1TS00000000000000002";

function span(id: string, parent: string | null, kind: string, name: string, at: [number, number], attrs: Doc): Doc {
  return { id, ["parent_id"]: parent, kind, name, start: at[0], duration: at[1], status: "ok", attrs };
}

function frame(fn: string, module: string, file: string, line: number, yours: boolean, waiting = false): Doc {
  return { function: fn, module, file, line, ["in_app"]: yours, ...(waiting ? { waiting: true } : {}) };
}

/** A stack seen in buckets `from` to `to` (10 ms each), one sample each. */
function seen(frames: number[], from: number, to: number): Doc {
  return { frames, count: to - from, at: Array.from({ length: to - from }, (_, index) => [from + index, 1]) };
}

function trace(id: string, name: string, service: string, spans: Doc[], profile: Doc, duration: number): Doc {
  const start = Date.now() * 1000 - 7 * 3_600_000_000;
  const shifted = spans.map((each) => ({ ...each, start: start + (each["start"] as number) }));
  return {
    id,
    kind: "http",
    name,
    start,
    duration,
    status: "ok",
    attrs: { "service.name": service, "http.method": "GET", "http.status_code": 200 },
    spans: shifted,
    logs: [],
    errors: [],
    links: [],
    issues: [],
    profile,
  };
}

/**
 * A FastAPI handler: get_campaigns queries Postgres (100–160 ms), then _get_analytics calls an analytics API
 * (160–310 ms), then sleeps 40 ms with nothing in flight. Its waits are its socket reads and the sleep.
 */
function python(): Doc {
  return trace(
    PYTHON,
    "GET /campaigns",
    "shop",
    [
      span("r", null, "http", "GET /campaigns", [0, 350_000], {}),
      span("q", "r", "sql", "SELECT campaign", [100_000, 60_000], {
        "db.system": "postgresql",
        "code.origin": "app/api.py:20 in get_campaigns",
      }),
      span("h", "r", "http.client", "GET analytics.example.com/v1", [160_000, 150_000], {
        "http.request.method": "GET",
        "url.full": "https://analytics.example.com/v1/stats",
        "code.origin": "app/api.py:40 in _get_analytics",
      }),
    ],
    {
      ["interval_us"]: 10_000,
      samples: 25,
      ["bucket_us"]: 10_000,
      frames: [
        frame("run", "uvicorn.server", "uvicorn/server.py", 60, false),
        frame("get_campaigns", "app.api", "app/api.py", 18, true),
        frame("_get_analytics", "app.api", "app/api.py", 38, true),
        frame("recv_into", "socket", "socket.py", 700, false, true),
        frame("sleep", "asyncio.tasks", "asyncio/tasks.py", 640, false, true),
      ],
      stacks: [seen([0, 1, 3], 10, 16), seen([0, 1, 2, 3], 16, 31), seen([0, 1, 4], 31, 35)],
    },
    350_000,
  );
}

/** A Spring controller on a virtual thread: its JDBC query to Postgres (200–260 ms) parks the thread. */
function jvm(): Doc {
  return trace(
    JVM,
    "GET /campaigns",
    "shop",
    [
      span("r", null, "http", "GET /campaigns", [0, 360_000], {}),
      span("q", "r", "sql", "SELECT campaign", [200_000, 60_000], {
        "db.system": "postgresql",
        "code.origin": "com/acme/CampaignController.java:30 in list",
      }),
    ],
    {
      ["interval_us"]: 10_000,
      samples: 16,
      ["bucket_us"]: 10_000,
      frames: [
        frame("Thread.run", "java.lang", "java/lang/Thread.java", 1, false),
        frame("CampaignController.list", "com.acme", "com/acme/CampaignController.java", 25, true),
        frame("VirtualThread.park", "java.lang", "java/lang/VirtualThread.java", 1, false, true),
        frame("CampaignController.render", "com.acme", "com/acme/CampaignController.java", 40, true),
      ],
      stacks: [seen([0, 1, 2], 20, 26), seen([0, 1, 3], 26, 36)],
    },
    360_000,
  );
}

async function store(doc: Doc): Promise<void> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${doc["id"]}`)).status).toBe(200);
}

test.beforeEach(async () => {
  await store(python());
  await store(jvm());
});

const summaries = (page: Page) =>
  page.getByRole("region", { name: "Functions" }).getByRole("list", { name: "Not a function" }).getByRole("listitem");
const boxes = (page: Page) =>
  page
    .getByRole("region", { name: "Flame graph" })
    .getByRole("button")
    .evaluateAll((buttons) =>
      // Their names, their places left off.
      buttons.map((button) => (button.getAttribute("aria-label") ?? "").replace(/ \S+:\d+$/, "").trim()),
    );

test("a Python handler's waits say what was in flight: its query, its HTTP call, a sleep", async ({ page }) => {
  await page.goto(`/#/t/${PYTHON}?tab=profile`);

  // Its first 100 ms, before the profile's first sample, its code's not profiled, as the strip says it.
  await expect(summaries(page)).toHaveText([
    /^HTTP GET analytics\.example\.com\s*150 ms/,
    /^Not profiled\s*100 ms/,
    /^SQL postgresql\s*60 ms/,
    /^waiting · sleep\s*40 ms/,
  ]);
  // In the database's colour, as the strip draws the query, under the function that made it.
  await expect.poll(() => boxes(page)).toContain("SQL postgresql");
  await expect(
    page.getByRole("region", { name: "Flame graph" }).getByRole("button", { name: /^SQL postgresql/ }),
  ).toHaveClass(/tp-k-sql/);

  // A row opens its call in the call tree.
  await summaries(page).getByRole("button", { name: "SQL postgresql" }).click();
  await expect(page.getByRole("tab", { name: /^Call tree/ })).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator(
      '.tp-map-row[data-kind="sql"][aria-selected="true"], .tp-map-row[data-kind="sql"][aria-current="true"]',
    ),
  ).toHaveCount(1);

  // All frames keeps the frames that waited.
  await page.getByRole("tab", { name: /^Profile/ }).click();
  await page.getByRole("tab", { name: "All frames" }).click();
  await expect.poll(() => boxes(page)).toContain("recv_into");
  await expect.poll(() => boxes(page)).not.toContain("waiting · SQL postgresql");
});

test("a JVM thread parked on Postgres says so, as a Python one does", async ({ page }) => {
  await page.goto(`/#/t/${JVM}?tab=profile`);

  await expect(summaries(page)).toHaveText([/^Not profiled\s*200 ms/, /^SQL postgresql\s*60 ms/]);
  // Under the function that waited, named by its query (beside its first 200 ms, not profiled).
  await expect
    .poll(async () => (await boxes(page)).filter((box) => box !== "Not profiled").join(" | "))
    .toMatch(/^CampaignController\.list \| CampaignController\.render \| SQL postgresql$/);
});

const W3C = "7d2c3b8e0a1f5e4b9c6d8e0f2a3b4c5d";
const VIEW = "01M4WA1TS00000000000000003";

/** A browser's view that asked the Python handler twice: its two traces, the same app's, under its two calls. */
function chainOfTwo(): Doc[] {
  const served = [4, 5].map((n, at) => {
    const doc = python();
    doc["id"] = `01M4WA1TS0000000000000000${n}`;
    doc["attrs"] = { ...(doc["attrs"] as Doc), "w3c.trace_id": W3C, "w3c.parent_span_id": `b00000000000000${at + 1}` };
    return doc;
  });
  const start = (served[0]?.["start"] as number) - 10_000;
  const call = (n: number) =>
    span(`c${n}`, "p0", "http.client", "GET 127.0.0.1:8000/campaigns", [start + n * 1_000, 400_000], {
      "http.request.method": "GET",
      "url.full": "http://127.0.0.1:8000/campaigns",
      "http.response.status_code": 200,
      "w3c.span_id": `b00000000000000${n}`,
    });
  const view: Doc = {
    id: VIEW,
    kind: "page",
    name: "/campaigns",
    start,
    duration: 800_000,
    status: "ok",
    attrs: { "service.name": "shop-web", "service.role": "browser", "w3c.trace_id": W3C },
    spans: [span("p0", null, "page", "/campaigns", [start, 800_000], {}), call(1), call(2)],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
  return [view, ...served];
}

test("a chain's merged profile of an app names its waits as each trace's own does", async ({ page }) => {
  for (const doc of chainOfTwo()) await store(doc);
  await expect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${VIEW}/chain`)).json()) as Doc)["traces"])
    .toHaveLength(3);
  await page.goto(`/#/t/${VIEW}?tab=profile`);
  const shop = page.getByRole("region", { name: "Profile of shop", exact: true });

  await expect(shop).toContainText("Profile of 2 traces");
  await expect(
    shop.getByRole("region", { name: "Functions" }).getByRole("list", { name: "Not a function" }).getByRole("listitem"),
  ).toHaveText([
    /^HTTP GET analytics\.example\.com\s*300 ms/,
    /^Not profiled\s*200 ms/,
    /^SQL postgresql\s*120 ms/,
    /^waiting · sleep\s*80 ms/,
  ]);
});
