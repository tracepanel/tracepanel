// The Tasks page's Live: the tasks in flight as an app's task events tell the agent, sent here down the SDKs' own
// connection (a hello, then a frame that is an object), and gone from the list once they finish.
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { STORE } from "../agent.ts";
import { traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

/** A connection to the agent, as an app with Celery opens one: its hello said and answered. */
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

test("tasks queued, running and retrying, with the workers, until they finish", async ({ page }) => {
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
      kwargs: "{'to': 'ann@example.com'}",
      trace_id: request,
      span_id: "S",
    },
    {
      event: "started",
      system: "celery",
      id: `running-${run}`,
      name: "shop.tasks.rebuild_index",
      time: nowUs() - 95_000_000,
      queue: "celery",
      worker: `celery@box-${run}`,
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

  await page.goto("/#/tasks?view=live");

  await expect(page.getByRole("link", { name: "Live" })).toHaveAttribute("aria-current", "page");
  const running = page.getByRole("region", { name: "Running now" });
  const queued = page.getByRole("region", { name: "Queued" });
  const retrying = page.getByRole("region", { name: "Retrying" });
  const workers = page.getByRole("region", { name: "Workers" });
  const row = (region: typeof running, id: string) => region.getByRole("link").filter({ hasText: id });

  await expect(row(running, `running-${run}`)).toContainText("shop.tasks.rebuild_index");
  await expect(row(running, `running-${run}`)).toContainText(`celery@box-${run}`);
  await expect(row(running, `running-${run}`)).toContainText(/1m 3\ds/);
  await expect(row(running, `running-${run}`)).toContainText("('books',)");

  await expect(row(queued, `queued-${run}`)).toContainText("shop.tasks.send_receipt");
  await expect(row(queued, `queued-${run}`)).toContainText("mail");
  await expect(row(queued, `queued-${run}`)).toContainText("(42,) {'to': 'ann@example.com'}");
  await expect(row(retrying, `retrying-${run}`)).toContainText("ConnectionError('CRM down')");
  await expect(row(retrying, `retrying-${run}`)).toContainText("3");

  await expect(workers.getByRole("row").filter({ hasText: `celery@box-${run}` })).toContainText("1");

  // The trace that enqueued it opens from its row.
  await row(queued, `queued-${run}`).getByRole("link", { name: "Open trace" }).click();
  await expect(page).toHaveURL(new RegExp(`#/t/${request}`));
  await page.goBack();

  // It ends: it leaves Live, without a reload.
  send(socket, [{ event: "finished", system: "celery", id: `running-${run}`, time: nowUs(), state: "SUCCESS" }]);

  await expect(row(running, `running-${run}`)).toHaveCount(0);
  await expect(workers.getByRole("row").filter({ hasText: `celery@box-${run}` })).toContainText("0");
  socket.destroy();
});

test("with nothing in flight and no worker seen, how to start one", async ({ page }) => {
  await page.route("**/api/tasks/live*", (route) => route.fulfill({ json: { now: nowUs(), tasks: [], workers: [] } }));

  await page.goto("/#/tasks?view=live");

  await expect(page.getByText("No tasks running")).toBeVisible();
  await expect(page.getByText(/No worker has been seen yet/)).toBeVisible();
});

test("Live sits next to the task lists and leads back to them", async ({ page }) => {
  await page.goto("/#/tasks");
  const lists = page.getByRole("navigation", { name: "List" });

  await expect(lists.getByRole("link")).toHaveText(["By task", "All runs", "Live"]);

  await lists.getByRole("link", { name: "Live" }).click();

  await expect(page).toHaveURL(/#\/tasks\?view=live$/);

  await lists.getByRole("link", { name: "By task" }).click();

  await expect(page).toHaveURL(/#\/tasks$/);
});
