// biome-ignore-all lint/style/useNamingConvention: the trace format's field names.
// A task a request enqueued a moment ago waits for a worker in the call tree only until its run arrives: the row turns
// into the run as the agent stores it, within a second or two, not at the page's next refresh (15 s), in the panel
// and on the console's page.
import type { FrameLocator, Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { openApp, panel, pill } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A trace id from this moment, `tail` making it this test's. */
function idNow(tail: string): string {
  let time = Date.now();
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  return `${head}${tail.padStart(16, "0")}`;
}

async function ingest(doc: object): Promise<void> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);
}

/** A request that enqueued `similar` a moment ago (as Go's asynq or BullMQ records it), and the run a worker made. */
function traces(tail: string): { request: object; run: object; id: string } {
  const id = idNow(`R${tail}`);
  const start = Date.now() * 1000 - 200_000;
  const common = { status: "ok", logs: [], errors: [], issues: [] };
  const request = {
    ...common,
    id,
    kind: "http",
    name: "GET /products",
    start,
    duration: 80_000,
    attrs: { "service.name": "go-shop", "http.method": "GET", "http.route": "/products", "http.status_code": 200 },
    spans: [
      {
        id: "r",
        parent_id: null,
        kind: "http",
        name: "GET /products",
        start,
        duration: 80_000,
        status: "ok",
        attrs: {},
      },
      {
        id: "e",
        parent_id: "r",
        kind: "task.enqueue",
        name: "enqueue similar",
        start: start + 75_000,
        duration: 1_000,
        status: "ok",
        attrs: { "task.id": `t-${tail}`, "task.name": "similar" },
      },
    ],
    links: [],
  };
  const runStart = start + 77_000;
  const run = {
    ...common,
    id: idNow(`T${tail}`),
    kind: "task",
    name: "similar",
    start: runStart,
    duration: 2_000,
    attrs: {
      "service.name": "go-shop-worker",
      "task.id": `t-${tail}`,
      "task.name": "similar",
      "task.state": "SUCCESS",
    },
    spans: [
      {
        id: "t",
        parent_id: null,
        kind: "task",
        name: "similar",
        start: runStart,
        duration: 2_000,
        status: "ok",
        attrs: {},
      },
    ],
    links: [{ kind: "enqueued_by", trace_id: id, span_id: "e" }],
  };
  return { request, run, id };
}

async function expectArrives(scope: Page | FrameLocator, run: object): Promise<void> {
  const tree = scope.locator(".tp-map-timed");

  await expect(tree.getByText("waiting for a worker…")).toBeVisible();

  await ingest(run);

  // Before the page's next refresh (every 15 s): the links are asked again while the task waits.
  await expect(tree.getByText("waiting for a worker…")).toBeHidden({ timeout: 4_000 });
  await expect(tree.getByRole("button", { name: /^task\s.*similar/ })).toBeVisible();
}

test("in the panel, a task's run replaces its waiting row as it arrives", async ({ page }) => {
  const { request, run, id } = traces("P1");
  await ingest(request);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${id}`)).status).toBe(200);
  await openApp(page, { products: { status: 200, trace: id, queries: 0, totalMs: 80 } });
  await page.getByRole("button", { name: "Load products" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();

  await expectArrives(frame, run);
});

test("on the console's page, a task's run replaces its waiting row as it arrives", async ({ page }) => {
  const { request, run, id } = traces("C1");
  await ingest(request);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${id}`)).status).toBe(200);
  await page.goto(`/#/t/${id}?tab=tree`);

  await expectArrives(page, run);
});
