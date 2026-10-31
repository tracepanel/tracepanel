// A call's repeats folded into one row (×N) say how they went, as each call's own row does: "2 failed" red for the
// ones that failed, "2 × 404" amber for the ones answered 4xx, the row's edge the worst of them.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const ID = "01M4GR0VPSTATVS00000000001";

function call(suffix: string, start: number, path: string, status: number | null): Doc {
  const attrs: Doc = { "http.request.method": "GET", "url.full": `https://api.example.com${path}` };
  if (status !== null) attrs["http.response.status_code"] = status;
  else attrs["error.type"] = "ConnectTimeout";
  return {
    id: `c${suffix}`,
    // biome-ignore lint/style/useNamingConvention: the trace format.
    parent_id: "r",
    kind: "http.client",
    name: `GET api.example.com${path}`,
    start,
    duration: 10_000,
    status: status === null || status >= 500 ? "error" : "ok",
    attrs,
  };
}

/** A request that fetched four users (one 503, one timed out, two 200) and three books (a 404, a 410, a 200). */
async function store(): Promise<void> {
  const start = Date.now() * 1000 - 6.5 * 3_600_000_000;
  const at = (ms: number) => start + ms * 1000;
  const trace = {
    id: ID,
    kind: "http",
    name: "GET /group-status",
    start,
    duration: 200_000,
    status: "ok",
    attrs: { "service.name": "shop", "http.method": "GET", "http.route": "/group-status" },
    spans: [
      {
        id: "r",
        // biome-ignore lint/style/useNamingConvention: the trace format.
        parent_id: null,
        kind: "http",
        name: "GET /group-status",
        start,
        duration: 200_000,
        status: "ok",
        attrs: {},
      },
      call("u1", at(1), "/users/1", 200),
      call("u2", at(12), "/users/2", 503),
      call("u3", at(24), "/users/3", null),
      call("u4", at(36), "/users/4", 200),
      call("b1", at(60), "/books/1", 404),
      call("b2", at(72), "/books/2", 410),
      call("b3", at(84), "/books/3", 200),
      call("a1", at(100), "/authors/1", 200),
      call("a2", at(112), "/authors/2", 404),
      call("a3", at(124), "/authors/3", 404),
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

test.beforeEach(async () => {
  await store();
});

const groupRow = (page: Page, text: string) => page.locator(".dt-map-group > .dt-map-row").filter({ hasText: text });

test("a group row in the call tree says how many of its calls failed or got a 4xx, its edge the worst", async ({
  page,
}) => {
  await page.goto(`/#/t/${ID}?tab=tree`);

  const users = groupRow(page, "/users/{id}");
  await expect(users).toContainText("×4");
  await expect(users.locator(".dt-status")).toHaveText(["2 failed"]);
  await expect(users).toHaveAttribute("data-status", "error");

  const books = groupRow(page, "/books/{id}");
  await expect(books.locator(".dt-status")).toHaveText(["2 × 4xx"]);
  await expect(books).toHaveAttribute("data-status", "warn");

  const authors = groupRow(page, "/authors/{id}");
  await expect(authors.locator(".dt-status")).toHaveText(["2 × 404"]);

  // Open, each call says its own, as before.
  await users.click();
  await expect(page.locator('.dt-map-row[data-status="error"]').filter({ hasText: "/users/2" })).toContainText("503");
});

test("the HTTP calls tab's grouped rows say the same, their edge red or amber", async ({ page }) => {
  await page.goto(`/#/t/${ID}?tab=http`);
  const rows = page.getByRole("tabpanel").locator("tbody tr");

  const users = rows.filter({ hasText: "/users/{id}" });
  await expect(users.locator(".dt-status")).toHaveText(["2 failed"]);
  await expect(users).toHaveAttribute("data-tone", "error");

  const authors = rows.filter({ hasText: "/authors/{id}" });
  await expect(authors.locator(".dt-status")).toHaveText(["2 × 404"]);
  await expect(authors).toHaveAttribute("data-tone", "warn");
});
