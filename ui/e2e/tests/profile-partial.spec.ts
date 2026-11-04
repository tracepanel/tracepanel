// A Node BFF's profiles as the Profile tab reads them: one that covers only the trace's last 5 ms says what it
// profiled of the trace's time and its shares of the trace's, as the strip does; over a chain of two apps, a code
// row's stretches open the BFF's profile of them, Your code first, and the sums name where most of its time went as
// Your code's list does.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const PARTIAL = "01M4WA1TS0000000000000PT01";
const BFF = "01M4WA1TS0000000000000PT02";
const API = "01M4WA1TS0000000000000PT03";
const W3C = "5b1d0c9e8f7a6b5c4d3e2f1a0b9c8d7e";

const CASES: { trace: Doc }[] = JSON.parse(
  readFileSync(new URL("../../../schema/waits.json", import.meta.url), "utf8"),
);

const HOURS_AGO = Date.now() * 1000 - 7 * 3_600_000_000;

/** A shared case's trace as a stored trace of `app`, moved to a few hours ago. */
function stored(id: string, app: string, trace: Doc, attrs: Doc = {}): Doc {
  const shift = HOURS_AGO - (trace["start"] as number);
  const spans = (trace["spans"] as Doc[]).map((span): Doc => ({ ...span, start: (span["start"] as number) + shift }));
  const root = spans.find((span) => span["parent_id"] === null) as Doc;
  return {
    ...trace,
    id,
    kind: "http",
    name: root["name"],
    start: HOURS_AGO,
    status: "ok",
    attrs: {
      ...(trace["attrs"] as Doc),
      "service.name": app,
      "http.method": "POST",
      "http.status_code": 200,
      ...attrs,
    },
    spans,
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
}

function span(id: string, parent: string | null, kind: string, name: string, at: [number, number], attrs: Doc): Doc {
  return { id, ["parent_id"]: parent, kind, name, start: at[0], duration: at[1], status: "ok", attrs };
}

/** A stack seen in buckets `from` to `to` (10 ms each), `each` samples a bucket. */
function seen(frames: number[], from: number, to: number, each = 1): Doc {
  return { frames, count: (to - from) * each, at: Array.from({ length: to - from }, (_, at) => [from + at, each]) };
}

/**
 * A GraphQL BFF's request (100 ms) that calls the API (20–80 ms) and waits on its event loop; a stack of the
 * runtime's own (Error.prepareStackTrace) and a millisecond of its resolver's. The API's trace answers the call.
 */
function bff(): Doc {
  const trace = {
    start: 0,
    duration: 100_000,
    attrs: { "telemetry.sdk.language": "nodejs", "w3c.trace_id": W3C },
    spans: [
      span("r", null, "http", "GraphQL query Authors", [0, 100_000], {}),
      span("h", "r", "http.client", "GET 127.0.0.1/authors", [20_000, 60_000], {
        "http.request.method": "GET",
        "url.full": "http://127.0.0.1:8052/authors",
        "server.address": "127.0.0.1",
        "server.port": 8052,
        "http.response.status_code": 200,
        "w3c.span_id": "c000000000000001",
      }),
    ],
    profile: {
      ["interval_us"]: 1_000,
      samples: 84,
      ["bucket_us"]: 10_000,
      frames: [
        { function: "event loop", module: null, file: "", line: 0, ["in_app"]: false, waiting: true },
        {
          function: "processTicksAndRejections",
          module: null,
          file: "node:internal/process",
          line: 72,
          ["in_app"]: false,
        },
        {
          function: "defaultPrepareStackTrace",
          module: null,
          file: "node:internal/errors",
          line: 96,
          ["in_app"]: false,
        },
        { function: "resolveAuthors", module: null, file: "server.ts", line: 9, ["in_app"]: true },
      ],
      stacks: [
        seen([0], 0, 10, 8),
        {
          frames: [1, 2],
          count: 3,
          at: [
            [0, 1],
            [1, 1],
            [9, 1],
          ],
        },
        seen([1, 3], 9, 10),
      ],
    },
  };
  return stored(BFF, "library-bff", trace);
}

/** The API's trace of the BFF's call: its own profile, so the chain has two apps profiled. */
function api(): Doc {
  const trace = {
    start: 20_000,
    duration: 58_000,
    attrs: { "telemetry.sdk.language": "python" },
    spans: [span("a", null, "http", "GET /authors", [20_000, 58_000], {})],
    profile: {
      ["interval_us"]: 10_000,
      samples: 5,
      ["bucket_us"]: 10_000,
      frames: [{ function: "list_authors", module: "app.api", file: "app/api.py", line: 3, ["in_app"]: true }],
      stacks: [seen([0], 0, 5)],
    },
  };
  return stored(API, "library-api", trace, {
    "http.method": "GET",
    "w3c.trace_id": W3C,
    "w3c.parent_span_id": "c000000000000001",
  });
}

async function store(docs: Doc[]): Promise<void> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(docs),
  });
  expect(response.status).toBe(202);
  for (const doc of docs) {
    await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${doc["id"]}`)).status).toBe(200);
  }
}

const legend = (page: Page) => page.locator(".dt-breakdown-legend").filter({ visible: true }).first().locator("li");

test.beforeAll(async () => {
  const partial = CASES.find((each) => String((each as Doc)["name"]).includes("last 5 ms"));
  if (!partial) throw new Error("no partial case in schema/waits.json");
  await store([stored(PARTIAL, "library-bff", partial.trace), bff(), api()]);
  await expect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${BFF}/chain`)).json()) as Doc)["traces"])
    .toHaveLength(2);
});

test("a profile of the trace's last 5 ms says so, its shares of the trace's time as the strip says them", async ({
  page,
}) => {
  await page.goto(`/#/t/${PARTIAL}?tab=profile`);
  await page.getByRole("tab", { name: "Your code" }).click();

  await expect(page.getByText("profiled of the trace's 35 ms")).toBeVisible();
  await expect(legend(page)).toHaveText([/^Framework & middleware\s*3 ms\s*9%$/, /^External calls\s*2 ms\s*6%$/]);
});

test("over a chain, a code row's stretches open the BFF's profile of them, not the whole trace's", async ({ page }) => {
  // The request's own time around its call, as its code row's link has it.
  await page.goto(`/#/t/${BFF}?tab=profile&at=0-20000%2C80000-100000`);

  await expect(page.getByText("profiled of these stretches' 40 ms")).toBeVisible();
  await expect(page.getByRole("region", { name: "Profile of library-api", exact: true })).toHaveCount(0);
});
