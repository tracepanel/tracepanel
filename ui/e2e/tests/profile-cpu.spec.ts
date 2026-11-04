// biome-ignore-all lint/style/useNamingConvention: the trace format's field names.
// A Go request's profile, as tracepanel-go sends it: runtime/pprof samples the CPU only and keeps no sample's time,
// so the agent spreads its 30 samples evenly over the request's own code at ingest, the rest of that time waiting off
// the CPU (`spread`). A Node request's, as tracepanel-js sends it: V8's samples with their times, the idle event loop
// waiting. Either is read as every language's profile is (lib/timeShares): a query is the database's, the code's own
// time splits into Your code, the framework's and waiting, and the call tree's legend and the Profile tab's bar say
// the same.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

const GO = "01M4PR0F11E00000000000C0G1";
const NODE_WAITING = "01M4PR0F11E00000000000C0N2";
const GO_MACOS = "01M4PR0F11E00000000000C0G2";

/** A call out of the request (a query, a Redis command), `at` ms into it, made from `origin`, under span `parent`. */
function call(id: string, kind: string, start: number, at: number, ms: number, origin: string, parent = "r"): object {
  return {
    id,
    parent_id: parent,
    kind,
    name: id,
    start: start + at * 1000,
    duration: ms * 1000,
    status: "ok",
    attrs: { "code.origin": origin, "db.system": kind === "sql" ? "postgresql" : "redis" },
  };
}

function frame(fn: string, module: string | null, file: string, line: number, inApp: boolean) {
  return { function: fn, module, file, line, in_app: inApp };
}

/**
 * A Go request: its queries from listProducts and similar, a Redis command from count (never on the CPU when
 * sampled, so under the handler above it, listProducts), one from warm right under the request (never sampled
 * either: the request's own waiting, though its line in catalog.go comes after listProducts'), 30 ms of the 69 off
 * the CPU in none of the others.
 */
function goRequest(start: number): object {
  return {
    id: GO,
    kind: "http",
    name: "GET /api/catalog/products",
    start,
    duration: 99_000,
    status: "ok",
    attrs: {
      "service.name": "go-shop",
      "http.method": "GET",
      "http.route": "/api/catalog/products",
      "http.status_code": 200,
      "telemetry.sdk.language": "go",
    },
    spans: [
      {
        id: "r",
        parent_id: null,
        kind: "http",
        name: "GET /api/catalog/products",
        start,
        duration: 99_000,
        status: "ok",
        attrs: {},
      },
      {
        id: "v",
        parent_id: "r",
        kind: "view",
        name: "(*App).listProducts",
        start,
        duration: 79_000,
        status: "ok",
        attrs: { "code.function": "github.com/acme/shop.(*App).listProducts" },
      },
      call("products", "sql", start, 5, 20, "catalog.go:14 in (*App).listProducts", "v"),
      call("similar", "sql", start, 40, 10, "similar.go:8 in (*App).similar", "v"),
      call("count", "redis", start, 60, 9, "catalog.go:30 in (*App).count", "v"),
      call("warm", "redis", start, 80, 5, "catalog.go:50 in (*App).warm"),
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
    profile: {
      interval_us: 1000,
      samples: 30,
      dropped: 0,
      frames: [
        frame("(*App).listProducts", "github.com/acme/shop", "catalog.go", 10, true),
        frame("(*App).similar", "github.com/acme/shop", "similar.go", 5, true),
        frame("editDistance", "github.com/acme/shop", "similar.go", 40, true),
        frame("syscall.syscall", "syscall", "syscall/syscall_darwin.go", 1, false),
        frame("runtime.mallocgc", "runtime", "runtime/malloc.go", 1, false),
      ],
      stacks: [
        { frames: [0, 1, 2], count: 25 },
        { frames: [0, 3], count: 3 },
        { frames: [4], count: 2 },
      ],
    },
  };
}

/**
 * A Node request as tracepanel-js sends it, its route's handler not recorded: a query, then a function that awaits a
 * 120 ms timer; 15 ms on the CPU of its 138 ms, its idle event loop's samples waiting, each in the 10 ms of the trace
 * it was taken in. (A request, not a task: the Tasks page's lists are other tests'.)
 */
function nodeWaiting(start: number): object {
  const span = (id: string, parent: string | null, kind: string, at: number, ms: number) => ({
    id,
    parent_id: parent,
    kind,
    name: id,
    start: start + at * 1000,
    duration: ms * 1000,
    status: "ok",
    attrs: {},
  });
  return {
    id: NODE_WAITING,
    kind: "http",
    name: "GET /api/catalog/products",
    start,
    duration: 138_000,
    status: "ok",
    attrs: {
      "service.name": "next-shop",
      "http.method": "GET",
      "http.route": "/api/catalog/products",
      "http.status_code": 200,
      "telemetry.sdk.language": "nodejs",
    },
    spans: [
      span("r", null, "http", 0, 138),
      span("SELECT review", "r", "sql", 10, 3),
      span("update search index", "r", "function", 16, 120),
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
    profile: {
      interval_us: 1000,
      samples: 138,
      dropped: 0,
      bucket_us: 10_000,
      frames: [
        frame("rank", null, "lib/rank.ts", 3, true),
        { ...frame("event loop", null, "", 0, false), waiting: true },
      ],
      stacks: [
        {
          frames: [0],
          count: 15,
          at: [
            [0, 10],
            [1, 5],
          ],
        },
        {
          frames: [1],
          count: 123,
          at: [[1, 5], ...Array.from({ length: 11 }, (_, at): [number, number] => [at + 2, 10]), [13, 8]],
        },
      ],
    },
  };
}

/** The Go request as tracepanel-go sends it from macOS: its CPU time estimated from the 12 samples taken. */
function goOnMacOs(start: number): object {
  const request = goRequest(start) as { profile: object };
  return { ...request, id: GO_MACOS, profile: { ...request.profile, estimated_from: 12 } };
}

async function seed(): Promise<void> {
  const start = Date.now() * 1000 - 4 * 3_600_000_000;
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([goRequest(start), nodeWaiting(start + 200_000), goOnMacOs(start + 400_000)]),
  });
  expect(response.status).toBe(202);
  for (const id of [GO, NODE_WAITING, GO_MACOS]) {
    await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${id}`)).status).toBe(200);
  }
}

function shares(page: Page) {
  return page.getByRole("region", { name: "Time by package" }).getByRole("button");
}

/** The functions the flame graph draws, as its boxes name them (their places left off). */
async function boxes(page: Page): Promise<string[]> {
  const labels = await page
    .getByRole("region", { name: "Flame graph" })
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
  // The Show all button, zoomed in, names no function.
  return labels
    .filter(Boolean)
    .map((label) => label.replace(/ \S+:\d+$/, "").trim())
    .sort();
}

/** The Go request's 99 ms by share: its 30 ms on the CPU spread over the 55 ms of code that is no
 * call's (a bucket shared with a call shares its samples with it). */
const GO_SHARES = ["Database 30 ms", "Framework & middleware 2 ms", "Redis 14 ms", "Waiting 30 ms", "Your code 23 ms"];
const GO_ROWS = [
  /^SQL postgresql\s*30 ms\s*30 ms$/,
  /^redis\s*14 ms\s*14 ms$/,
  /^Framework & middleware\s*2 ms\s*2 ms$/,
  /^waiting · off CPU\s*30 ms\s*30 ms$/,
];
/** Its flame graph in Your code: the functions, each call's time under a frame of its share's, the off-CPU wait. */
const GO_BOXES = [
  "(*App).listProducts",
  "(*App).similar",
  "Framework & middleware",
  "SQL postgresql",
  "SQL postgresql",
  "editDistance",
  "redis",
  "redis",
  "waiting · off CPU",
];
/** The Node request's 138 ms by share: the timer's 120 ms waited, the event loop idle. */
const NODE_SHARES = ["Database 3 ms", "Waiting 121 ms", "Your code 14 ms"];

function box(page: Page, name: string) {
  return page.getByRole("region", { name: "Flame graph" }).getByRole("button", { name: new RegExp(`^${name}`) });
}

test.beforeEach(seed);

/** The trace's time by share as the call tree's legend says it: "Your code 20 ms". */
async function legend(page: Page): Promise<string[]> {
  const items = page.getByRole("list", { name: /^Where the time went/ }).locator(":scope > li[data-category]");
  return (await items.allInnerTexts())
    .map((text) =>
      text
        .replace(/\s+/g, " ")
        .replace(/ \d+%$/, "")
        .trim(),
    )
    .sort();
}

/** The same as the Profile tab's bar says it. */
async function bar(page: Page): Promise<string[]> {
  return (await shares(page).allInnerTexts())
    .map((text) =>
      text
        .replace(/\s+/g, " ")
        .replace(/ \d+%$/, "")
        .trim(),
    )
    .sort();
}

test("a Go profile is spread over its code at ingest: its queries the database's, the rest of its code's time waited", async ({
  page,
}) => {
  await page.goto(`/#/t/${GO}?tab=tree`);
  const said = await expect
    .poll(() => legend(page))
    .not.toEqual([])
    .then(() => legend(page));

  expect(said).toEqual(GO_SHARES);

  await page.getByRole("tab", { name: /^Profile/ }).click();

  await expect(page.getByText("profiled of the trace's 99 ms")).toBeVisible();
  await expect(
    page.getByText(
      "30 samples of CPU time, one every 1 ms, spread evenly over your code's time, the rest of it waiting off the CPU (not sampled)",
    ),
  ).toBeVisible();
  await expect.poll(() => bar(page)).toEqual(GO_SHARES);
  // A query's time under its own frame, the database's, never a wait named by it.
  const functions = page.getByRole("region", { name: "Functions" });
  await expect(functions.getByRole("list", { name: "Not a function" }).getByRole("listitem")).toHaveText(GO_ROWS);
  await expect.poll(() => boxes(page)).toEqual(GO_BOXES);
  await expect(box(page, "waiting · off CPU").first()).toHaveClass(/dt-hatched/);
});

test("a Node profile's idle loop is waiting: the call tree's legend and the Profile tab say the same", async ({
  page,
}) => {
  await page.goto(`/#/t/${NODE_WAITING}?tab=tree`);

  await expect.poll(() => legend(page)).toEqual(NODE_SHARES);

  await page.getByRole("tab", { name: /^Profile/ }).click();

  await expect(page.getByText("138 samples, one every 1 ms")).toBeVisible();
  await expect.poll(() => bar(page)).toEqual(NODE_SHARES);
});

test("a profile whose CPU time is an estimate (Go on macOS) says so", async ({ page }) => {
  await page.goto(`/#/t/${GO_MACOS}?tab=profile`);

  await expect(
    page.getByText(
      "CPU time estimated from 12 samples (macOS hands the profiler's samples out unevenly, so each is weighed), spread evenly over your code's time, the rest of it waiting off the CPU (not sampled)",
    ),
  ).toBeVisible();
});
