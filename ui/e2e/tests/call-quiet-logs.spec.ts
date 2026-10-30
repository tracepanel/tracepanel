// The call tree shows warnings and worse, the info and debug records counted on their span, in the traces of the
// calls opened under the calls as in the trace itself: the legend's Logs chip shows every record, all down the chain.
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const CALLER = "01M4CHA1NTRACECA11ER000000";
const SERVED = "01M4CHA1NTRACESERVED000000";
const W3C_TRACE = "7a3c5e1f9b2d4c6e8a0b1c2d3e4f5a6b";
const W3C_CALL = "5e6f7a8b9c0d1e2f";

function span(id: string, parent: string | null, kind: string, name: string, start: number, attrs: Doc): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start, duration: 200_000, status: "ok", attrs };
}

function log(spanId: string, time: number, level: string, message: string): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { span_id: spanId, time, level, logger: "orders", message, exception: null };
}

/** shop's GET /checkout calls orders, whose trace has an info record and a warning in its handler. */
async function seed(): Promise<void> {
  const start = Date.now() * 1000 - 9 * 3_600_000_000;
  const caller = {
    id: CALLER,
    kind: "http",
    name: "GET /checkout",
    start,
    duration: 400_000,
    status: "ok",
    attrs: { "service.name": "shop", "http.method": "GET", "http.route": "/checkout", "w3c.trace_id": W3C_TRACE },
    spans: [
      { ...span("r", null, "http", "GET /checkout", start, {}), duration: 400_000 },
      span("c", "r", "http.client", "POST orders/orders", start + 50_000, {
        "http.request.method": "POST",
        "url.full": "http://orders/orders",
        "server.address": "orders",
        "http.response.status_code": 201,
        "w3c.span_id": W3C_CALL,
      }),
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
  const served = {
    id: SERVED,
    kind: "http",
    name: "POST /orders",
    start: start + 60_000,
    duration: 180_000,
    status: "ok",
    attrs: {
      "service.name": "orders",
      "http.method": "POST",
      "http.route": "/orders",
      "w3c.trace_id": W3C_TRACE,
      "w3c.parent_span_id": W3C_CALL,
    },
    spans: [
      { ...span("s", null, "http", "POST /orders", start + 60_000, {}), duration: 180_000 },
      span("h", "s", "function", "create_order", start + 70_000, {}),
    ],
    logs: [
      log("h", start + 80_000, "info", "order received"),
      log("h", start + 90_000, "warning", "stock running low"),
    ],
    errors: [],
    links: [],
    issues: [],
  };
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([caller, served]),
  });
  expect(response.status).toBe(202);
  await expect
    .poll(async () => JSON.stringify(await (await fetch(`${CONSOLE}api/traces/${CALLER}/related`)).json()))
    .toContain(SERVED);
}

test("a call's trace opened under the call shows its warnings, its info counted until the Logs chip", async ({
  page,
}) => {
  await seed();
  await page.goto(`/#/t/${CALLER}?tab=tree`);
  const handler = page.locator('.dt-map-row[data-kind="function"]').filter({ hasText: "create_order" });

  await expect(page.getByText("stock running low")).toBeVisible();
  await expect(page.getByText("order received")).toHaveCount(0);
  await expect(handler.locator(".dt-map-logs")).toHaveText("1 log");

  await handler.locator(".dt-map-logs").click();

  await expect(page.getByText("order received")).toBeVisible();
  await expect(page.getByText("stock running low")).toBeVisible();
});
