// A Node task that waits in a function span of its own (a leaf, no calls under it): its profile's 10 ms buckets
// mostly the idle event loop. The time strip paints that wait as its legend counts it (Waiting, hatched), says how
// long it waited, and the Profile tab opens on Your code, whose bar is the legend's.
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const TASK = "01M4WA1TS00000000000000T01";

function span(id: string, parent: string | null, kind: string, name: string, at: [number, number], attrs: Doc): Doc {
  return { id, ["parent_id"]: parent, kind, name, start: at[0], duration: at[1], status: "ok", attrs };
}

function frame(fn: string, file: string, line: number, yours: boolean, waiting = false): Doc {
  return { function: fn, module: null, file, line, ["in_app"]: yours, ...(waiting ? { waiting: true } : {}) };
}

/** A bullmq task: a query (12–15 ms), then `update search index` (16–137 ms), idle on the event loop for most of it. */
function task(): Doc {
  const start = Date.now() * 1000 - 7 * 3_600_000_000;
  const spans = [
    span("r", null, "task.run", "rank-products", [0, 137_000], {}),
    span("q", "r", "sql", "SELECT review", [12_000, 3_000], {
      "db.system": "postgresql",
      "code.origin": "worker.ts:11 in rankProducts",
    }),
    span("f", "r", "function", "update search index", [16_000, 121_000], {
      "code.origin": "worker.ts:16 in rankProducts",
    }),
  ].map((each) => ({ ...each, start: start + (each["start"] as number) }));
  const idle = [5, 6, 8, 8, 6, 3, 8, 8, 8, 8, 8, 8, 9, 4];
  return {
    id: TASK,
    kind: "task",
    name: "rank-products",
    start,
    duration: 137_000,
    status: "ok",
    attrs: {
      "service.name": "next-app",
      "service.role": "worker",
      "task.name": "rank-products",
      "task.state": "SUCCESS",
      "telemetry.sdk.language": "nodejs",
    },
    spans,
    logs: [],
    errors: [],
    links: [],
    issues: [],
    profile: {
      ["interval_us"]: 1_000,
      samples: 102,
      ["bucket_us"]: 10_000,
      frames: [
        frame("event loop", "", 0, false, true),
        frame("processJob", "bullmq/dist/cjs/classes/worker.js", 575, false),
        frame("rankProducts", "worker.ts", 10, true),
        frame("Socket.connect", "node:net", 1580, false),
      ],
      stacks: [
        { frames: [0], count: 97, at: idle.map((count, bucket) => [bucket, count]) },
        { frames: [1], count: 2, at: [[0, 2]] },
        { frames: [1, 2, 3], count: 2, at: [[0, 2]] },
        { frames: [1, 2], count: 1, at: [[1, 1]] },
      ],
    },
  };
}

test.beforeEach(async () => {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([task()]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${TASK}`)).status).toBe(200);
});

/** "Waiting 125 ms 91%" → 125: a share's time in the legend, in ms. */
function shareMs(legend: string, name: string): number {
  return Number(new RegExp(`${name}\\s+(\\d+) ms`).exec(legend)?.[1] ?? Number.NaN);
}

test("a leaf span's wait is painted as the legend counts it: hatched, said for how long", async ({ page }) => {
  await page.goto(`/#/t/${TASK}?tab=tree`);
  const legend = (await page.locator(".tp-breakdown-legend").first().innerText()).replace(/\s+/g, " ");
  const track = page.locator(".tp-lane[data-own] .tp-lane-track");
  // Each piece's share of the track, waiting's and Your code's, in ms of the trace.
  const painted = await track.evaluate((element) => {
    const width = element.getBoundingClientRect().width;
    const ms = (piece: Element) => (piece.getBoundingClientRect().width / width) * 137;
    const sum = (selector: string) => [...element.querySelectorAll(selector)].reduce((all, each) => all + ms(each), 0);
    return {
      waiting: sum(".tp-stretch[data-waiting]"),
      code: sum('.tp-stretch[data-category="code"]:not([data-waiting])'),
    };
  });

  expect(shareMs(legend, "Waiting")).toBeGreaterThan(100);
  expect(Math.abs(painted.waiting - shareMs(legend, "Waiting"))).toBeLessThan(2);
  expect(Math.abs(painted.code - shareMs(legend, "Your code"))).toBeLessThan(2);
  // Said over each span's longest wait (the task's own, its function's): how long each waited, adding up to Waiting.
  const said = (await track.locator(".tp-quiet-label").allInnerTexts()).map((text) =>
    /^waiting · (\d+) ms$/.exec(text),
  );
  expect(said).toHaveLength(2);
  const total = said.reduce((all, match) => all + Number(match?.[1] ?? Number.NaN), 0);
  expect(Math.abs(total - shareMs(legend, "Waiting"))).toBeLessThanOrEqual(1);
});

test("its Profile tab opens on Your code, its bar the strip's legend", async ({ page }) => {
  await page.goto(`/#/t/${TASK}?tab=tree`);
  const strip = (await page.locator(".tp-breakdown-legend").first().innerText()).replace(/\s+/g, " ");
  await page.getByRole("tab", { name: /^Profile/ }).click();

  await expect(page.getByRole("tab", { name: "Your code" })).toHaveAttribute("aria-selected", "true");
  const bar = page.locator(".tp-breakdown-legend").filter({ visible: true }).first();
  await expect.poll(async () => (await bar.innerText()).replace(/\s+/g, " ")).toBe(strip.replace(/ Functions 1$/, ""));
});
