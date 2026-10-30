// Apollo Router, an app with no SDK, sends its trace over OTLP: under the page's call to it, the console opens the
// Router's own rows (its call to the subgraph), as it opens a trace an SDK sent. The export is the Router 2.18's of
// one query (the agent's OTLP tests' fixture).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

const EXPORT = fileURLToPath(
  new URL("../../../crates/otlp/tests/fixtures/apollo-router-spec-compliant.json", import.meta.url),
);
// The W3C ids the browser's call carried to the Router (the fixture's incoming traceparent).
const W3C_TRACE = "0af7651916cd43dd8448eb211c80319c";
const W3C_CALL = "b7ad6b7169203331";
const PAGE = "01M4R0TERPAGE0000000000000";

/** Where the agent takes OTLP: none when it serves none (its port taken), and the test has nothing to send to. */
async function otlpAddress(): Promise<string | undefined> {
  const capabilities = (await (await fetch(`${CONSOLE}api/capabilities`)).json()) as {
    otlp?: { address: string; serving: boolean };
  };
  return capabilities.otlp?.serving ? capabilities.otlp.address : undefined;
}

/** The browser's view that called the Router: one POST to it, carrying the trace on. */
async function seedPage(start: number): Promise<void> {
  const span = (id: string, parent: string | null, kind: string, name: string, attrs: Record<string, unknown>) => ({
    id,
    // biome-ignore lint/style/useNamingConvention: the trace format.
    parent_id: parent,
    kind,
    name,
    start,
    duration: 400_000,
    status: "ok",
    attrs,
  });
  const doc = {
    id: PAGE,
    kind: "browser",
    name: "/books",
    start,
    duration: 500_000,
    status: "ok",
    attrs: { "service.name": "library-web", "w3c.trace_id": W3C_TRACE },
    spans: [
      { ...span("p", null, "browser", "/books", {}), duration: 500_000 },
      span("c", "p", "http.client", "POST 127.0.0.1/", {
        "http.request.method": "POST",
        "url.full": "http://127.0.0.1:8043/",
        "server.address": "127.0.0.1",
        "w3c.span_id": W3C_CALL,
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
}

test("under a call to Apollo Router, its OTLP trace opens: its call to the subgraph", async ({ page }) => {
  const otlp = await otlpAddress();
  test.skip(otlp === undefined, "this agent serves no OTLP");
  const exported = readFileSync(EXPORT, "utf8");
  const start = Number(BigInt(/"startTimeUnixNano":\s*"?(\d+)/.exec(exported)?.[1] ?? "0") / 1000n);
  await seedPage(start);
  const sent = await fetch(`http://${otlp}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: exported,
  });
  expect(sent.ok).toBe(true);
  // The Router's trace goes out once its spans stop coming (2 s), then links to the page's call.
  await expect
    .poll(async () => JSON.stringify(await (await fetch(`${CONSOLE}api/traces/${PAGE}/related`)).json()), {
      timeout: 15_000,
    })
    .toContain("GraphQL query Books");

  await page.goto(`/#/t/${PAGE}?tab=tree`);

  // The page's call is the Router's request ("served by library-router"); the Router's call to the subgraph under it.
  await expect(page.getByRole("button", { name: /served by library-router GraphQL query Books/ })).toBeVisible();
  await expect(
    page.locator('.dt-map-row[data-kind="http.client"]').filter({ hasText: "host.docker.internal" }),
  ).toBeVisible();
});
