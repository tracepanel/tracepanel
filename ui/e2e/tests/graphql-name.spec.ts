// A GraphQL request keeps one name from running to failed: the operation its body carried ("GraphQL query Authors"),
// in the pill, the panel's list and the trace, though its server answered 503 before the operation ran and named
// its trace by the request line. The agent names the stored trace after the operation, from the body its SDK
// captured, as the widget named the request while it ran (lib/graphql).
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { openApp, panel, pill } from "../app.ts";
import { expect, test } from "../fixtures.ts";

const ID = "01M4GQ1503000000000000000A";
const BODY = JSON.stringify({ operationName: "Authors", query: "query Authors { authors { id name } }" });

/** The BFF's trace of it, as its SDK sent it: named by its request line, its body captured, answered 503. */
async function store(): Promise<void> {
  const start = Date.now() * 1000 - 2_000_000;
  const trace = {
    id: ID,
    kind: "http",
    name: "POST /graphql",
    start,
    duration: 40_000,
    status: "error",
    attrs: {
      "service.name": "library-bff",
      "http.method": "POST",
      "http.route": "/graphql",
      "http.status_code": 503,
      "http.request.body": BODY,
    },
    spans: [
      // biome-ignore lint/style/useNamingConvention: the trace format.
      { id: "r", parent_id: null, kind: "http", name: "POST /graphql", start, duration: 40_000, attrs: {} },
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([trace]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${ID}`)).status).toBe(200);
}

/** The page's POST to /app/graphql, held until `release`, then answered 503 with the trace's id and no name. */
async function hold(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/app/graphql", async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"errors":[{"message":"unavailable"}]}',
      headers: { "Tracepanel-Id": ID, "Server-Timing": 'db;dur=0;desc="0 queries", total;dur=40' },
    });
  });
  return release;
}

test("a GraphQL request that answers 503 keeps its operation's name in the pill, the list and the trace", async ({
  page,
}) => {
  await store();
  await openApp(page, {});
  const release = await hold(page);

  await page.evaluate((body) => {
    void fetch("/app/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  }, BODY);
  await expect(pill(page)).toHaveAccessibleName(/^tracepanel: GraphQL query Authors, running/);

  release();

  await expect(pill(page)).toHaveAccessibleName(/^tracepanel: GraphQL query Authors → 503/);
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  await expect(list).toContainText("query Authors");
  await expect(list).not.toContainText("POST /graphql");
  // The trace the agent stored, named the same.
  const stored = (await (await fetch(`${CONSOLE}api/traces/${ID}`)).json()) as { name: string };
  expect(stored.name).toBe("GraphQL query Authors");
});
