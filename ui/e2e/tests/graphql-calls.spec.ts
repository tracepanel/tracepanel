// A call to a GraphQL server is named by the operation it carries ("GraphQL query Authors"), as the agent names its
// request: one URL serves every operation, so POST library-gql.test:8051/graphql says nothing of which call it was.
// The call tree, the HTTP calls tab and the console's calls list say it alike; the agent groups the calls by it.
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

const ID = "01M4GQ1CA115000000000000V0";
const HOST = "library-gql.test";
const URL = `http://${HOST}:8051/graphql`;

/** The browser's call for an operation, as tracepanel-js records one: by its URL, the operation in its attributes. */
function call(id: string, start: number, type: string, name: string) {
  return {
    id,
    // biome-ignore lint/style/useNamingConvention: the trace format.
    parent_id: "R",
    kind: "http.client",
    name: `POST ${HOST}:8051/graphql`,
    start,
    duration: 30_000,
    status: "ok",
    attrs: {
      "http.request.method": "POST",
      "url.full": URL,
      "http.response.status_code": 200,
      "graphql.operation.type": type,
      "graphql.operation.name": name,
    },
  };
}

/** A view that asked for the authors twice and saved once. */
async function store(): Promise<void> {
  const start = Date.now() * 1000 - 5_000_000;
  const view = {
    id: ID,
    kind: "page",
    name: "/authors",
    start,
    duration: 120_000,
    status: "ok",
    attrs: { "service.name": "library-web" },
    spans: [
      // biome-ignore lint/style/useNamingConvention: the trace format.
      { id: "R", parent_id: null, kind: "page", name: "/authors", start, duration: 120_000, status: "ok", attrs: {} },
      call("A", start + 1_000, "query", "Authors"),
      call("B", start + 40_000, "query", "Authors"),
      call("C", start + 80_000, "mutation", "Save"),
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([view]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${ID}`)).status).toBe(200);
}

test("a call to a GraphQL server is named by its operation in the call tree, the HTTP calls tab and the calls list", async ({
  page,
}) => {
  await store();

  await page.goto(`/#/t/${ID}?tab=tree`);

  const calls = page.locator('.tp-map-row[data-kind="http.client"]');
  await expect(calls.locator(".tp-map-text")).toHaveText([
    "GraphQL query Authors",
    "GraphQL query Authors",
    "GraphQL mutation Save",
  ]);

  await page.getByRole("tab", { name: /^HTTP calls/ }).click();

  const groups = page
    .getByRole("main")
    .getByRole("row")
    .filter({ hasText: /GraphQL/ });
  await expect(groups).toHaveText([/GraphQL query Authors\s*×2/, /GraphQL mutation Save/]);
  await expect(page.locator(".tp-scope-summary-text")).toHaveText(/^3 HTTP calls · 2 unique/);

  await page.goto(`/#/calls/http?q=${encodeURIComponent(`target:${HOST}`)}`);

  const listed = page.getByRole("main").getByRole("row").filter({ hasText: HOST });
  await expect(listed).toHaveCount(2);
  await expect(listed.first()).toContainText("POSTGraphQL query Authors");
  await expect(listed.first().getByText(HOST)).toBeVisible();
});
