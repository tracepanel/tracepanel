// A GraphQL call shows the document it ran wherever the call shows: in the caller's call tree (the call's details) as
// in the trace that served it, whether the call recorded it (the browser recording keeps what it sent) or only the
// server did (a gateway that sends its document over OTLP, which the agent keeps on its trace).
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const ms = 1_000;
const VIEW = "01M4GQ1D0C0000000000000001";
const GATEWAY = "01M4GQ1D0C0000000000000002";
const W3C = "67716c646f630000000000000000ab01";
const SERVED = "Features { features { id name enabled } }";
const SENT = "query Notifications { notifications { id text } }";

function span(id: string, parent: string | null, kind: string, name: string, start: number, attrs: Doc = {}): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start, duration: 300 * ms, status: "ok", attrs };
}

function trace(id: string, kind: string, name: string, start: number, attrs: Doc, spans: Doc[]): Doc {
  return {
    id,
    kind,
    name,
    start,
    duration: 800 * ms,
    status: "ok",
    attrs,
    spans: [span(`${id}r`, null, kind, name, start), ...spans],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
}

/** A view's two calls to a gateway: one the gateway's trace answered (its document on it), one with its own. */
async function store(): Promise<void> {
  const start = Date.now() * ms - 3_600_000_000;
  const call = (id: string, name: string, w3c: string, extra: Doc) =>
    span(id, `${VIEW}r`, "http.client", "POST 127.0.0.1:4000/graphql", start + 10 * ms, {
      "http.request.method": "POST",
      "url.full": "http://127.0.0.1:4000/graphql",
      "http.response.status_code": 200,
      "w3c.span_id": w3c,
      "graphql.operation.type": "query",
      "graphql.operation.name": name,
      ...extra,
    });
  const view = trace(VIEW, "page", "/flags", start, { "service.name": "shop-web", "w3c.trace_id": W3C }, [
    call("c1", "Features", "a1a1a1a1a1a1a1a1", {}),
    call("c2", "Notifications", "b2b2b2b2b2b2b2b2", { "graphql.document": SENT }),
  ]);
  const gateway = trace(
    GATEWAY,
    "http",
    "GraphQL query Features",
    start + 20 * ms,
    {
      "service.name": "gateway",
      "w3c.trace_id": W3C,
      "w3c.parent_span_id": "a1a1a1a1a1a1a1a1",
      "http.method": "POST",
      "http.route": "/graphql",
      "http.status_code": 200,
      "graphql.operation.type": "query",
      "graphql.operation.name": "Features",
      "graphql.document": `query ${SERVED}`,
    },
    [],
  );
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([view, gateway]),
  });
  expect(response.status).toBe(202);
  await expect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${VIEW}/chain`)).json()) as Doc)["traces"])
    .toHaveLength(2);
}

/** The document a call's details show, formatted, in its block (the one that copies "Copy query"). */
function shownDocument(page: Page) {
  return page
    .getByRole("complementary", { name: "Details" })
    .locator("pre")
    .filter({ has: page.locator(".dt-gql-keyword") });
}

test("a GraphQL call shows its document in the caller's call tree, from the trace that served it or its own", async ({
  page,
}) => {
  await store();
  await page.goto(`/#/t/${VIEW}?tab=tree`);
  const calls = page.locator('.dt-map-row[data-kind="http.client"]');

  // Served by the gateway: its document, as the gateway's trace has it.
  await calls.filter({ hasText: "GraphQL query Features" }).click();
  await expect(shownDocument(page)).toContainText("features");
  await expect(shownDocument(page)).toContainText("enabled");

  // Its own, as the browser recording sent it: no trace answered it.
  await calls.filter({ hasText: "GraphQL query Notifications" }).click();
  await expect(shownDocument(page)).toContainText("notifications");

  // The gateway's trace says the same on its Request tab.
  await page.goto(`/#/t/${GATEWAY}?tab=request`);
  await expect(page.getByRole("button", { name: "Copy query" })).toBeVisible();
  await expect(page.locator(".dt-gql-keyword").first()).toHaveText("query");
});
