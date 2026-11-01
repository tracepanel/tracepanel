// biome-ignore-all lint/style/useNamingConvention: the trace format's field names.
// A Go request's profile, as tracepanel-go sends it: runtime/pprof samples the CPU only, so its 30 samples are 30 ms
// on the CPU of a 99 ms request, and the rest of its time, waiting on Postgres, is waiting, as a Python or a JVM
// profile has its waits. The header says it is CPU time. A query's or a Redis command's time is waiting under the
// function of yours that made it (its code.origin), as a Python or a JVM profile has it; a Node request's too.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

const GO = "01M4PR0F11E00000000000C0G1";
const NODE = "01M4PR0F11E00000000000C0N1";

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
    attrs: { "code.origin": origin },
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
 * A Next.js route as tracepanel-js sends it: GET calls card, whose stack after an await starts at it; card's 30
 * queries at once with GET's two, 40 ms of the request's 50 ms off the CPU.
 */
function nodeRequest(start: number): object {
  return {
    id: NODE,
    kind: "http",
    name: "GET /api/catalog/products",
    start,
    duration: 50_000,
    status: "ok",
    attrs: {
      "service.name": "next-shop",
      "http.method": "GET",
      "http.route": "/api/catalog/products",
      "http.status_code": 200,
      "telemetry.sdk.language": "nodejs",
    },
    spans: [
      {
        id: "r",
        parent_id: null,
        kind: "http",
        name: "GET /api/catalog/products",
        start,
        duration: 50_000,
        status: "ok",
        attrs: {},
      },
      call("count", "sql", start, 2, 8, "app/api/catalog/products/route.ts:42 in GET"),
      ...Array.from({ length: 30 }, (_, at) =>
        call(`card${at}`, "sql", start, 10 + at, 1, "lib/catalog.ts:33 in card"),
      ),
      call("cached", "redis", start, 40, 2, "app/api/catalog/products/route.ts:58 in GET"),
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
    profile: {
      interval_us: 1000,
      samples: 10,
      frames: [
        frame("processTicksAndRejections", null, "node:internal/process/task_queues", 1, false),
        frame("GET", null, "app/api/catalog/products/route.ts", 26, true),
        frame("card", null, "lib/catalog.ts", 31, true),
        frame("query", null, "pg-pool/index.js", 1, false),
      ],
      stacks: [
        { frames: [0, 1, 2, 3], count: 3 },
        { frames: [0, 2, 3], count: 5 },
        { frames: [0], count: 2 },
      ],
    },
  };
}

async function seed(): Promise<void> {
  const start = Date.now() * 1000 - 4 * 3_600_000_000;
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([goRequest(start), nodeRequest(start + 100_000)]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${NODE}`)).status).toBe(200);
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

function box(page: Page, name: string) {
  return page.getByRole("region", { name: "Flame graph" }).getByRole("button", { name: new RegExp(`^${name}`) });
}

test.beforeEach(seed);

test("a Go profile is its time on the CPU; the rest of the request's time waited", async ({ page }) => {
  await page.goto(`/#/t/${GO}?tab=profile`);

  await expect(page.getByText("on the CPU of the trace's 99 ms")).toBeVisible();
  await expect(page.getByText("30 samples, one every 1 ms of CPU time; waiting isn't sampled")).toBeVisible();
  await expect(shares(page)).toHaveText([
    /^your code\s*28 ms\s*28%/,
    /^framework & runtime\s*2 ms\s*2%/,
    /^waiting\s*69 ms\s*70%/,
  ]);
  // Waiting, as a Python or a JVM profile names its waits: one name, hatched, in either view. The queries' and the
  // Redis command's under the functions that made them; the 30 ms in none of them on its own.
  const waiting = box(page, "waiting");
  await expect(waiting).toHaveCount(3);
  await expect(waiting.first()).toHaveClass(/dt-hatched/);
  await expect
    .poll(() => boxes(page))
    .toEqual([
      "(*App).listProducts",
      "(*App).similar",
      "editDistance",
      "framework & runtime",
      "waiting",
      "waiting",
      "waiting",
    ]);
  // The functions, then what no function is, apart at the bottom though waiting took most. listProducts holds its
  // query's and count's waits (count through the handler), not warm's: a line in its file isn't in it.
  const functions = page.getByRole("region", { name: "Functions" });
  await expect(functions.getByRole("listitem")).toHaveText([
    /^editDistance\s*similar\.go:40/,
    /^\(\*App\)\.listProducts\s*catalog\.go:10\s*3 ms\s*67 ms$/,
    /^\(\*App\)\.similar\s*similar\.go:5/,
    /^framework & runtime\s*2 ms\s*2 ms$/,
    /^waiting\s*69 ms\s*69 ms$/,
  ]);
  await expect(functions.getByRole("list", { name: "Not a function" }).getByRole("listitem")).toHaveCount(2);

  // Zoomed into listProducts: its calls, and its own wait and similar's, not the request's.
  await box(page, "\\(\\*App\\)\\.listProducts").click();
  await expect.poll(() => boxes(page)).toEqual(["(*App).similar", "editDistance", "waiting", "waiting"]);

  await page.getByRole("tab", { name: "All frames" }).click();

  await expect(waiting.first()).toBeVisible();
  await expect(functions.getByRole("list", { name: "Not a function" })).toHaveText(/^waiting\s*69 ms\s*69 ms$/);
});

test("a Node request's queries waited in card under GET, as a Python profile has its waits", async ({ page }) => {
  await page.goto(`/#/t/${NODE}?tab=profile`);

  await expect(shares(page)).toHaveText([/^your code\s*8 ms/, /^framework & runtime\s*2 ms/, /^waiting\s*40 ms/]);
  // card is under GET, where its stack before the await had it, though most of its samples start at it.
  await box(page, "GET").click();
  await expect.poll(() => boxes(page)).toEqual(["card", "waiting", "waiting"]);
  await box(page, "card").click();
  await expect.poll(() => boxes(page)).toEqual(["waiting"]);
});
