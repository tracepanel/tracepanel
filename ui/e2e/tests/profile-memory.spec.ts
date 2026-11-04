// biome-ignore-all lint/style/useNamingConvention: the trace format's field names.
// A profile with the trace's memory and the collector's pauses: the header says its peak and the pauses in one line,
// the Profile tab has a Memory view (its peak, what it kept, where the memory was by package, as a flame of bytes and
// as a list of sites, and what the numbers can't tell apart), the time strip has a GC share. A profile without them
// shows none of it.
import { CONSOLE } from "../agent.ts";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { DIGEST } from "../seed.ts";

const SALES = "GET /reports/sales";

test("the header says the memory's peak and the collector's pauses, only where the profile has them", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(SALES)}`);

  await expect(page.locator(".dt-trace-facts")).toHaveText("· ↑ 42 MB peak · GC 3× 12 ms");

  await page.goto(`/#/t/${await traceId(DIGEST)}`);

  await expect(page.locator(".dt-trace-title")).not.toContainText("peak");
  await expect(page.locator(".dt-trace-title")).not.toContainText("GC");
});

test("the Memory view: its peak, what it kept, where the memory was, and what it can't tell apart", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(SALES)}?tab=profile`);
  const kinds = page.getByRole("tablist", { name: "Profile of" });

  await expect(kinds.getByRole("tab")).toHaveText(["Time", "Memory"]);
  await expect(kinds.getByRole("tab", { name: "Time" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Time by package" })).toBeVisible();

  await kinds.getByRole("tab", { name: "Memory" }).click();

  await expect(page.getByText("Memory of the whole trace")).toBeVisible();
  await expect(page.getByText("peak, above where it started")).toBeVisible();
  await expect(page.getByText("net +1.2 MB · 90 MB allocated in all")).toBeVisible();
  // The list's bytes are a number of their own, not the peak's: said so, and its shares are of them.
  await expect(
    page.getByText(
      /^The list: [\d.]+ MB still held at the end of the trace, not at its peak, by where it was allocated. Its shares are of these$/,
    ),
  ).toBeVisible();
  await expect(page.getByText("Includes other traces that ran in the process meanwhile")).toBeVisible();

  await page.getByRole("tab", { name: "All frames" }).click();

  await expect(page.getByRole("region", { name: "Memory by package" }).getByRole("button")).toHaveText([
    /^django\.db\s*30 MB\s*71%$/,
    /^django\.template\s*8\.0 MB\s*19%$/,
    /^Your code\s*4\.0 MB\s*10%$/,
  ]);

  const sites = page.getByRole("region", { name: "Allocation sites" }).getByRole("listitem");

  await expect(sites).toHaveCount(3);
  await expect(sites.nth(0)).toContainText("SQLCompiler.execute_sql");
  await expect(sites.nth(0)).toContainText("reports/queries.py:42");
  await expect(sites.nth(0)).toContainText("30 MB");
  await expect(sites.nth(0)).toContainText("71%");
  await expect(sites.nth(2)).toContainText("sales");
  await expect(sites.nth(2)).toContainText("reports/views.py:18");

  await page.getByRole("button", { name: "totals reports/queries.py:42" }).hover();

  await expect(page.getByRole("tooltip")).toContainText("30 MB · 71% · 0 B in itself");
});

const TASK = "01M4PR0F11E0000000000MEM01";

/**
 * A Django task as tracepanel-python 0.10.0 sends it from a virtual environment: its time mostly its own code, its
 * memory mostly Redis's, and the profiler's own counter among the sites.
 */
async function seedTask(): Promise<void> {
  const start = Date.now() * 1000 - 4 * 3_600_000_000;
  const frame = (fn: string, module: string, file: string, inApp: boolean) => ({
    function: fn,
    module,
    file,
    line: 1,
    in_app: inApp,
  });
  const trace = {
    id: TASK,
    kind: "task",
    name: "shop.tasks.refresh_tracking",
    start,
    duration: 10_000,
    status: "ok",
    // No language: the services' tests count the Python apps the seed has.
    attrs: { "service.name": "memory-store" },
    spans: [
      {
        id: "r",
        parent_id: null,
        kind: "task",
        name: "shop.tasks.refresh_tracking",
        start,
        duration: 10_000,
        status: "ok",
        attrs: {},
      },
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
    profile: {
      interval_us: 1000,
      samples: 10,
      frames: [
        frame("refresh_tracking", "shop.tasks", "shop/tasks.py", true),
        frame("CaseInsensitiveDict.__setitem__", "redis.client", "redis/client.py", false),
        frame("run", "threading", "threading.py", false),
        frame("count", "tracepanel.core.profile", "tracepanel/core/profile.py", false),
      ],
      stacks: [{ frames: [0, 1], count: 10 }],
      memory: {
        peak: 55_000,
        net: 36_000,
        sites: [
          { frames: [1], bytes: 12_000, count: 40 },
          { frames: [2, 3], bytes: 4_500, count: 30 },
          { frames: [0], bytes: 900, count: 3 },
        ],
      },
    },
  };
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([trace]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${TASK}`)).status).toBe(200);
}

test("Your code or All frames is one choice for Time and Memory, its first from the time; Tracepanel's sites never show", async ({
  page,
}) => {
  await seedTask();
  await page.goto(`/#/t/${TASK}?tab=profile`);
  const kinds = page.getByRole("tablist", { name: "Profile of" });
  const frames = page.getByRole("tablist", { name: "Frames shown" });

  await expect(frames.getByRole("tab", { name: "Your code" })).toHaveAttribute("aria-selected", "true");

  await kinds.getByRole("tab", { name: "Memory" }).click();

  await expect(page.getByText("Memory of the whole trace")).toBeVisible();
  await expect(frames.getByRole("tab", { name: "Your code" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Allocation sites" }).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Allocation sites" })).not.toContainText("tracepanel");

  await frames.getByRole("tab", { name: "All frames" }).click();

  await expect(page.getByRole("region", { name: "Memory by package" }).getByRole("button")).toHaveText([
    /^redis\s*12 KB/,
    /^Your code\s*900 B/,
  ]);

  await kinds.getByRole("tab", { name: "Time" }).click();

  await expect(page.getByRole("region", { name: "Time by package" })).toBeVisible();
  await expect(frames.getByRole("tab", { name: "All frames" })).toHaveAttribute("aria-selected", "true");
});

const WORKER = "01M4PR0F11E0000000000MEM02";

/**
 * A Taskiq task's memory as tracepanel-python sends it: most of it allocated by Redis's client and pydantic with none
 * of the task's code on the stack, the rest under the task's functions, one of them awaiting a thread (its frame
 * waits).
 */
async function seedWorker(): Promise<void> {
  const start = Date.now() * 1000 - 4 * 3_600_000_000;
  const frame = (fn: string, module: string, file: string, line: number, inApp: boolean) => ({
    function: fn,
    module,
    file,
    line,
    in_app: inApp,
  });
  const trace = {
    id: WORKER,
    kind: "task",
    name: "shop.tasks.refresh_tracking",
    start,
    duration: 10_000,
    status: "ok",
    attrs: { "service.name": "memory-store" },
    spans: [
      {
        id: "r",
        parent_id: null,
        kind: "task",
        name: "shop.tasks.refresh_tracking",
        start,
        duration: 10_000,
        status: "ok",
        attrs: {},
      },
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
    profile: {
      interval_us: 1000,
      samples: 10,
      frames: [
        frame("refresh_tracking", "shop.tasks", "shop/tasks.py", 26, true),
        frame("track_parcel", "shop.tasks", "shop/tasks.py", 20, true),
        frame("CaseInsensitiveDict.__setitem__", "redis.client", "redis/client.py", 144, false),
        frame("BaseModel.__init__", "pydantic.main", "pydantic/main.py", 250, false),
        frame("Redis.execute_command.<locals>.<lambda>", "redis.asyncio.client", "redis/asyncio/client.py", 600, false),
        { ...frame("SyncToAsync.__call__", "asgiref.sync", "asgiref/sync.py", 502, false), waiting: true },
      ],
      stacks: [{ frames: [0, 1], count: 10 }],
      memory: {
        peak: 54_000,
        net: 35_000,
        sites: [
          { frames: [2], bytes: 12_000, count: 40 },
          { frames: [3], bytes: 936, count: 3 },
          { frames: [0, 1, 4], bytes: 520, count: 2 },
          { frames: [0, 5], bytes: 336, count: 1 },
        ],
      },
    },
  };
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([trace]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${WORKER}`)).status).toBe(200);
}

test("Your code's sites are its flame's: a library's bytes its caller's, none of yours the framework & runtime's", async ({
  page,
}) => {
  await seedWorker();
  await page.goto(`/#/t/${WORKER}?tab=profile`);
  await page.getByRole("tablist", { name: "Profile of" }).getByRole("tab", { name: "Memory" }).click();
  const frames = page.getByRole("tablist", { name: "Frames shown" });
  const sites = page.getByRole("region", { name: "Allocation sites" });

  await expect(frames.getByRole("tab", { name: "Your code" })).toHaveAttribute("aria-selected", "true");
  // The peak (53 KB) and the list's 13 KB are different numbers, each said for what it is.
  await expect(page.getByText("peak, above where it started")).toBeVisible();
  await expect(
    page.getByText(/^The list: 13 KB held at the peak, by where it was allocated. Its shares are of these$/),
  ).toBeVisible();
  // Memory isn't time: the bytes allocated under a frame that waits are its caller's, not waiting's.
  await expect(page.getByRole("region", { name: "Memory by package" }).getByRole("button")).toHaveText([
    /^Your code\s*856 B/,
    /^Framework & runtime\s*13 KB/,
  ]);
  await expect(sites.getByRole("listitem")).toHaveText([
    /^track_parcel\s*shop\/tasks\.py:20\s*520 B\s*4%$/,
    /^refresh_tracking\s*shop\/tasks\.py:26\s*336 B\s*2%$/,
    /^framework & runtime\s*13 KB\s*94%$/,
  ]);
  await expect(sites.getByRole("list", { name: "Not a function" }).getByRole("listitem")).toHaveCount(1);
  await expect(sites).not.toContainText("CaseInsensitiveDict");
  await expect(sites).not.toContainText("BaseModel");

  await frames.getByRole("tab", { name: "All frames" }).click();

  await expect(sites.getByRole("listitem").first()).toContainText("CaseInsensitiveDict.__setitem__");
  await expect(sites.getByRole("list", { name: "Not a function" })).toHaveCount(0);
});

test("the strip has the collector's pauses as their own share, and a click on one picks nothing", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(SALES)}?tab=tree`);
  const legend = page.getByRole("list", { name: /^Where the time went/ });
  const pauses = page.locator('.dt-time-track .dt-stretch[data-category="gc"]');

  await expect(pauses).toHaveCount(3);
  await expect(legend.locator('li[data-category="gc"]')).toHaveText(/^GC\s*12 ms\s*29%$/);
  await expect(legend.getByRole("button", { name: /^Your code/ })).toHaveText(/^Your code\s*30 ms\s*71%$/);

  await legend.locator('li[data-category="gc"] .dt-share').hover();

  await expect(page.getByRole("tooltip", { name: /^GC/ })).toContainText("12 ms · 29% · 3 collections");

  const rows = await page.locator(".dt-map-row").count();
  await pauses.last().click();

  await expect(page.locator(".dt-map-row")).toHaveCount(rows);
  await expect(legend.getByRole("button", { name: /^Your code/ })).toHaveAttribute("aria-pressed", "false");
});

test("a profile without memory has no Memory view", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=profile`);

  await expect(page.getByRole("region", { name: "Time by package" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Profile of" })).toHaveCount(0);
});

test("a profile without collections has no GC share", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=tree`);

  await expect(page.getByRole("list", { name: /^Where the time went/ })).toBeVisible();
  await expect(page.locator('[data-category="gc"]')).toHaveCount(0);
});
