// Tasks in flight: the Now line on the Tasks page, from the task events an app sends down the SDKs' own connection
// (a hello, then a frame that is an object), and Live in the header's auto-refresh, as on every page.
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { CONSOLE, STORE } from "../agent.ts";
import { autoRefresh, chooseLive, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { trace } from "../seed.ts";

/** A connection to the agent, as an app with a task queue opens one: its hello said and answered. */
async function connect(): Promise<Socket> {
  const address = readFileSync(join(STORE, "agent.addr"), "utf8").trim();
  const socket = address.startsWith("unix:")
    ? createConnection({ path: address.slice("unix:".length) })
    : createConnection({ host: "127.0.0.1", port: Number(address.split(":").at(-1)) });
  socket.write(`${JSON.stringify({ protocol: 1, service: "shop-worker", capabilities: ["live_tasks"] })}\n`);
  await new Promise((resolve) => socket.once("data", resolve));
  return socket;
}

/** Task events, as one frame: a 4-byte length, then the JSON. */
function send(socket: Socket, events: Record<string, unknown>[]): void {
  const body = Buffer.from(JSON.stringify({ tasks: events }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  socket.write(Buffer.concat([length, body]));
}

// Each test's own tasks: the agent is shared by every test, in parallel.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const nowUs = () => Date.now() * 1000;

/** The agent's answers, as a project with or without task events would give them. */
async function answer(page: Page, live: Record<string, unknown>, sends: boolean): Promise<void> {
  await page.route("**/api/tasks/live*", (route) => route.fulfill({ json: { now: nowUs(), ...live } }));
  await page.route("**/api/capabilities*", async (route) => {
    const response = await route.fetch();
    // biome-ignore lint/style/useNamingConvention: the wire format.
    await route.fulfill({ response, json: { ...(await response.json()), live_tasks: sends } });
  });
}

test("Now: the tasks running, queued and retrying, the workers, and the tasks themselves under it", async ({
  page,
}) => {
  const run = unique();
  const request = await traceId("GET /reports/sales");
  const socket = await connect();
  // biome-ignore-start lint/style/useNamingConvention: task events as the SDKs send them.
  send(socket, [
    {
      event: "enqueued",
      system: "celery",
      id: `queued-${run}`,
      name: "shop.tasks.send_receipt",
      time: nowUs() - 12_000_000,
      queue: "mail",
      retries: 0,
      args: "(42,)",
      // This run's own: the agent is shared, and tasks of earlier runs may still be queued.
      kwargs: `{'to': 'ann@example.com', 'run': '${run}'}`,
      trace_id: request,
      span_id: "S",
    },
    {
      event: "started",
      system: "rq",
      id: `running-${run}`,
      name: "shop.jobs.rebuild_index",
      time: nowUs() - 95_000_000,
      queue: "default",
      worker: `rq-${run}`,
      retries: 0,
      args: "('books',)",
      kwargs: "{}",
    },
    {
      event: "retried",
      system: "celery",
      id: `retrying-${run}`,
      name: "shop.tasks.sync_crm",
      time: nowUs() - 3_000_000,
      worker: `celery@box-${run}`,
      retries: 2,
      error: "ConnectionError('CRM down')",
    },
  ]);
  // biome-ignore-end lint/style/useNamingConvention: task events as the SDKs send them.

  await page.goto("/#/tasks");
  const now = page.getByRole("region", { name: "Now" });

  // One line above the overview, in the list's place on every entry page; Live is in the header, not a list.
  await expect(now.getByRole("button", { expanded: false })).toContainText(
    /Now\s*\d+ running\s*\d+ queued\s*\d+ retrying/,
  );
  await expect(now.getByRole("list", { name: "Workers" }).getByText(`rq-${run}`)).toBeVisible();
  await expect(now.getByRole("list", { name: "Workers" }).getByText(`celery@box-${run}`)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "List" }).getByRole("link")).toHaveText(["By task", "All runs"]);
  await expect(now.getByRole("table")).toHaveCount(0);

  await now.getByRole("button", { expanded: false }).click();
  const running = now
    .getByRole("link")
    .filter({ hasText: "shop.jobs.rebuild_index" })
    .filter({ hasText: `rq-${run}` });
  const queued = now.getByRole("link").filter({ hasText: `(42,) {'to': 'ann@example.com', 'run': '${run}'}` });
  const retrying = now.getByRole("link").filter({ hasText: `celery@box-${run}` });

  await expect(running).toContainText("running");
  await expect(running).toContainText("RQ");
  await expect(running).toContainText(/1m 3\ds/);
  await expect(queued).toContainText("queued");
  await expect(queued).toContainText("mail");
  await expect(retrying).toContainText("retrying");
  await expect(retrying).toContainText("ConnectionError('CRM down')");
  await expect(retrying).toContainText("3");

  // The table stays open: the browser keeps the choice.
  await page.reload();

  await expect(page.getByRole("region", { name: "Now" }).getByRole("table")).toBeVisible();

  // A queued task's row opens the trace that enqueued it.
  await queued.click();

  await expect(page).toHaveURL(new RegExp(`#/t/${request}`));

  // With Live on, a task that ends leaves Now without a reload.
  await page.goBack();
  await chooseLive(page);
  send(socket, [{ event: "finished", system: "rq", id: `running-${run}`, time: nowUs(), state: "SUCCESS" }]);

  await expect(running).toHaveCount(0);
  await expect(now.getByRole("list", { name: "Workers" }).getByText(`rq-${run}`)).toBeVisible();
  socket.destroy();
});

test("Now says idle with workers there, and lists them", async ({ page }) => {
  // biome-ignore lint/style/useNamingConvention: the wire format.
  const worker = { name: "celery@box", system: "celery", service: "shop", last_seen: nowUs(), in_flight: 0 };
  await answer(page, { tasks: [], workers: [worker] }, true);

  await page.goto("/#/tasks");
  const now = page.getByRole("region", { name: "Now" });

  await expect(now).toContainText("Now");
  // Idle says so in words, and so does the worker: no bare count to puzzle over.
  await expect(now).toContainText("Idle");
  // When the last run ended: a queue whose tasks take milliseconds still shows it works.
  await expect(now.getByRole("link", { name: /^· last run \S+ (just now|\d+[smh] ago)$/ })).toBeVisible();
  await expect(now.getByRole("list", { name: "Workers" })).toHaveText("celery@box idle");
  await expect(now.getByRole("button")).toHaveCount(0);
});

test("Now says how to start a worker when the app sends task events but none was seen", async ({ page }) => {
  await answer(page, { tasks: [], workers: [] }, true);

  await page.goto("/#/tasks");

  const now = page.getByRole("region", { name: "Now" });

  await expect(now).toContainText("No worker connected");
  await expect(now).toContainText("Start one: celery -A <app> worker");
});

test("a project without task events has no Now", async ({ page }) => {
  await answer(page, { tasks: [], workers: [] }, false);

  await page.goto("/#/tasks");

  await expect(page.getByRole("main").getByRole("table").getByText("shop.tasks.send_receipt")).toBeVisible();
  await expect(page.getByRole("region", { name: "Now" })).toHaveCount(0);
});

test("Tasks is in the menu with a worker running before any task ended, and says its runs come", async ({ page }) => {
  await answer(page, { tasks: [], workers: [] }, true);
  const empty = async (route: Parameters<Parameters<Page["route"]>[1]>[0], json: unknown) => route.fulfill({ json });
  await page.route("**/api/counts*", async (route) => {
    const counts = await (await route.fetch()).json();
    // biome-ignore lint/style/useNamingConvention: the wire format.
    await route.fulfill({ json: { ...counts, sections: { ...counts.sections, tasks: 0 }, live_tasks: true } });
  });
  await page.route(/\/api\/tasks(\?|$)/, (route) => empty(route, { tasks: [] }));

  await page.goto("/#/endpoints");
  await page.getByRole("complementary").getByRole("link", { name: "Tasks" }).click();

  await expect(page.getByRole("region", { name: "Now" })).toContainText("No worker connected");
  await expect(page.getByText("No runs yet")).toBeVisible();
  await expect(page.getByText("Runs show up here when tasks finish.")).toBeVisible();
});

test("without task events or stored runs, Tasks is not in the menu", async ({ page }) => {
  await page.route("**/api/counts*", async (route) => {
    const counts = await (await route.fetch()).json();
    // biome-ignore lint/style/useNamingConvention: the wire format.
    await route.fulfill({ json: { ...counts, sections: { ...counts.sections, tasks: 0 }, live_tasks: false } });
  });

  await page.goto("/#/endpoints");

  await expect(page.getByRole("complementary").getByRole("link", { name: "HTTP", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary").getByRole("link", { name: "Tasks" })).toHaveCount(0);
});

test("an old link to Tasks' Live opens Tasks with Live on", async ({ page }) => {
  await page.goto("/#/tasks?view=live");

  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(autoRefresh(page)).toHaveText(/^Live/);
  await expect(page.getByRole("navigation", { name: "List" }).getByRole("link", { name: "By task" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("with Live on, a run that just ended is highlighted in All runs", async ({ page }) => {
  await page.goto("/#/tasks?view=calls");
  await chooseLive(page);
  const name = `shop.tasks.arrived_${unique().replace(/\W/g, "_")}`;
  const start = nowUs();
  const doc = trace("task", name, { "service.name": "shop", "service.role": "worker", "task.state": "SUCCESS" });
  doc["start"] = start;
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);
  const row = page.getByRole("main").getByRole("table").getByRole("link").filter({ hasText: name });

  await expect(row).toHaveAttribute("data-new", "");
  // A moment later it is a row like the others.
  await expect(row).not.toHaveAttribute("data-new");
});
