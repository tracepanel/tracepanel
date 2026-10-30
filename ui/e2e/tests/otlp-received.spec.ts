// A span an OpenTelemetry instrumentation made: its details end with what the agent got over OTLP, collapsed, and
// why it became what it is: a call that links the trace of the service it called, or a step that is no call.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const ID = "01M4AT1RECE1VED0000000000A";

function span(id: string, parent: string | null, kind: string, name: string, start: number, attrs: Doc): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start, duration: 4_000, status: "ok", attrs };
}

/**
 * GET /checkout: a call to the billing service as the requests instrumentation records it, and a client span of a
 * library's own that names no HTTP method, RPC or messaging system.
 */
async function seed(): Promise<void> {
  const start = Date.now() * 1000 - 8 * 3_600_000_000;
  const doc = {
    id: ID,
    kind: "http",
    name: "GET /checkout",
    start,
    duration: 20_000,
    status: "ok",
    attrs: { "service.name": "shop", "http.method": "GET", "http.route": "/checkout" },
    spans: [
      { ...span("r", null, "http", "GET /checkout", start, {}), duration: 20_000 },
      span("c", "r", "otel", "POST", start + 1_000, {
        "otel.span_kind": "client",
        "otel.scope": "opentelemetry.instrumentation.requests",
        "http.method": "POST",
        "http.url": "http://billing.test/charge?token=abc",
        "http.status_code": 201,
        "w3c.span_id": "00f067aa0ba902b7",
      }),
      span("s", "r", "otel", "send", start + 6_000, {
        "otel.span_kind": "client",
        "otel.scope": "acme.notify",
        "peer.service": "mailer",
      }),
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${ID}`)).status).toBe(200);
}

async function received(page: Page, kind: string, name: string) {
  await page.locator(`.dt-map-row[data-kind="${kind}"]`).filter({ hasText: name }).click();
  const block = page.getByRole("complementary", { name: "Details" }).getByRole("group", {
    name: "As received over OTLP",
  });
  await expect(block).not.toHaveAttribute("open");
  await block.getByText("As received over OTLP").click();
  return block;
}

test("an OpenTelemetry call's details: what came over OTLP, and why it is a call that links a trace", async ({
  page,
}) => {
  await seed();
  await page.goto(`/#/t/${ID}?tab=tree`);

  const block = await received(page, "http.client", "billing.test/charge");

  await expect(block.locator("[data-mapped-as]")).toHaveText(
    "HTTP call: method from http.method, URL from http.url. It carries the trace on: links the trace of the " +
      "service it called",
  );
  await expect(block.locator("dt")).toHaveText([
    "name",
    "kind",
    "scope",
    "http.method",
    "http.status_code",
    "http.url",
    "w3c.span_id",
  ]);
  await expect(block.locator("dd")).toContainText([
    "POST",
    "client",
    "opentelemetry.instrumentation.requests",
    "POST",
    "201",
    "http://billing.test/charge?token=********",
    "00f067aa0ba902b7",
  ]);
});

test("a client span that is no call says why: a step, not linked to the service it called", async ({ page }) => {
  await seed();
  await page.goto(`/#/t/${ID}?tab=tree`);

  const block = await received(page, "function", "send");

  await expect(block.locator("[data-mapped-as]")).toHaveText(
    "Not a call: a client span with no HTTP method or URL, no rpc.system or messaging.system, kept as a step. It " +
      "carries no trace on: not linked to the service it called",
  );
  await expect(block.locator("dt")).toHaveText(["name", "kind", "scope", "peer.service"]);
});
