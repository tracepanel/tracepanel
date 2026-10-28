// A trace's Logs tab lists its whole chain of calls: a browser's view calls a GraphQL BFF, whose three Book.author
// steps each call a service. Each app's records, on the view's clock, with its app; a row of the call tree opens
// what is under it ("Under this"), the scope's chip lets it go, and what the records add up to filters them.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const W3C = "4bf92f3577b34da6a3ce929d0e0e47c1";

/** A ULID of this test's own: 26 Crockford characters. */
const NUMBERS: Record<string, number> = { view: 1, bff: 2, api1: 11, api2: 12, api3: 13 };
const id = (name: string) => `01M4C4A1N5${String(NUMBERS[name.toLowerCase()]).padStart(16, "0")}`;

function span(
  name: string,
  parent: string | null,
  kind: string,
  label: string,
  start: number,
  duration: number,
  attrs: Doc = {},
): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id: name, parent_id: parent, kind, name: label, start, duration, status: "ok", attrs };
}

function log(span: string | null, time: number, level: string, logger: string, message: string): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { span_id: span, time, level, logger, message, exception: null, attrs: {} };
}

function trace(
  name: string,
  label: string,
  app: string,
  start: number,
  duration: number,
  parent: string | null,
  spans: Doc[],
  logs: Doc[],
): Doc {
  const attrs: Doc = {
    "service.name": app,
    "w3c.trace_id": W3C,
    "http.method": label.split(" ")[0],
    "http.route": label.split(" ")[1],
  };
  if (parent) attrs["w3c.parent_span_id"] = parent;
  // The seed's apps, in their roles: the Services map keeps its boxes.
  if (app === "shop-web") attrs["service.role"] = "browser";
  return {
    id: id(name),
    kind: "http",
    name: label,
    start,
    duration,
    status: "ok",
    attrs,
    spans,
    logs,
    errors: [],
    links: [],
    issues: [],
  };
}

/** The view, the BFF (its clock 4 ms ahead) and the service's three traces, stored by the agent. */
async function chain(): Promise<string> {
  // Hours ago: the other tests list the newest records and requests first.
  const start = Date.now() * 1000 - 6 * 3_600_000_000;
  const ahead = 4_000;
  const view = trace(
    "VIEW",
    "GET /shelf",
    "shop-web",
    start,
    10_000,
    null,
    [
      span("v0", null, "http", "GET /view", start, 10_000),
      span("v1", "v0", "http.client", "POST /graphql", start + 1_000, 8_000, { "w3c.span_id": "f000000000000001" }),
    ],
    [log(null, start + 500, "info", "console", "view loading")],
  );
  const b = start + 1_200 + ahead;
  const steps = [0, 1, 2].flatMap((n) => [
    span(`s${n}`, "b0", "function", "Book.author", b + 1_000 + n * 2_000, 1_500, { "graphql.field": "Book.author" }),
    span(`c${n}`, `s${n}`, "http.client", `GET /authors/${n + 1}`, b + 1_100 + n * 2_000, 1_200, {
      "w3c.span_id": `c00000000000000${n + 1}`,
    }),
  ]);
  const bff = trace(
    "BFF",
    "POST /graphql",
    "shop",
    b,
    7_600,
    "f000000000000001",
    [span("b0", null, "http", "POST /graphql", b, 7_600), ...steps],
    [
      log("b0", b + 100, "info", "yoga", "query Books"),
      log("b0", b + 1_050, "debug", "resolvers", "author step"),
      log("s1", b + 3_050, "info", "resolvers", "author 2 asked"),
      log("b0", b + 7_000, "warning", "yoga", "slow query"),
    ],
  );
  const apis = [0, 1, 2].map((n) => {
    const at = b + 1_200 + n * 2_000 - ahead;
    return trace(
      `API${n + 1}`,
      `GET /authors/${n + 1}`,
      "shop",
      at,
      1_000,
      `c00000000000000${n + 1}`,
      [
        span(`a${n}`, null, "http", `GET /authors/${n + 1}`, at, 1_000),
        span(`q${n}`, `a${n}`, "sql", "SELECT author", at + 200, 300),
      ],
      [log(`q${n}`, at + 300, n === 1 ? "error" : "info", "app.db", n === 1 ? "no author 2" : `author ${n + 1}`)],
    );
  });
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([view, bff, ...apis]),
  });
  expect(response.status).toBe(202);
  await expect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${id("VIEW")}/chain`)).json()) as Doc)["traces"])
    .toHaveLength(5);
  return id("VIEW");
}

const logsTab = (page: Page) => page.getByRole("tab", { name: /^Logs/ });
const records = (page: Page) => page.locator("[data-record]");

test("the Logs tab lists the whole chain, each record with its app, and an app's chip narrows it", async ({ page }) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=logs`);

  await expect(logsTab(page)).toContainText("8");
  await expect(records(page)).toHaveCount(8);
  await expect(records(page).first()).toContainText("view loading");
  await expect(records(page).first()).toContainText("shop-web");
  await expect(records(page).nth(1)).toContainText("query Books");
  await expect(records(page).last()).toContainText("slow query");

  const scope = page.getByRole("list", { name: "Scope" });
  await scope.getByRole("button", { name: /^shop 7$/ }).click();

  await expect(records(page)).toHaveCount(7);
  await expect(page.getByText("7 of 8 records")).toBeVisible();
  await expect(records(page).filter({ hasText: "shop-web" })).toHaveCount(0);
});

test("Under this: a group of steps opens the records under it, its services' too; only its own on the chip's menu", async ({
  page,
}) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=calls`);
  await page
    .getByRole("button", { name: /^function Book\.author/i })
    .first()
    .click();

  const under = page.locator(".dt-under-this");
  await expect(under).toHaveText("Under this:4 logs");
  await under.getByRole("button", { name: "4 logs" }).click();

  await expect(logsTab(page)).toHaveAttribute("aria-selected", "true");
  const chip = page.locator(".dt-scope-chip");
  await expect(chip).toContainText("Under Book.author ×3");
  await expect(records(page)).toHaveCount(4);
  await expect(records(page).filter({ hasText: "author 2 asked" })).toHaveCount(1);
  await expect(records(page).filter({ hasText: "app.db" })).toHaveCount(3);
  await expect(records(page).filter({ hasText: "author 2 asked" })).toHaveCount(1);

  await chip.getByRole("button", { name: /Under Book\.author/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "Only this span" }).click();
  await page.keyboard.press("Escape");

  await expect(chip).toContainText("In Book.author ×3");
  await expect(records(page)).toHaveCount(1);
  await expect(records(page).first()).toContainText("author 2 asked");

  await chip.getByRole("button", { name: "Back to the whole chain" }).click();

  await expect(chip).toHaveCount(0);
  await expect(records(page)).toHaveCount(8);
});

test("a service's trace in the tree: under it, its own records; a record leads back to its row", async ({ page }) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=calls`);
  const step = page.getByRole("button", { name: /^function Book\.author/i }).first();
  await step.locator(".dt-map-caret[data-toggle]").click();
  await page.getByRole("button", { name: /^app GET \/authors\/2\b/ }).click();
  await page.locator(".dt-under-this").getByRole("button", { name: "1 log" }).click();

  await expect(page.locator(".dt-scope-chip")).toContainText("Under shop");
  await expect(records(page)).toHaveCount(1);
  await expect(records(page).first()).toContainText("no author 2");

  await records(page).first().getByRole("button", { name: "In the call tree" }).click();

  await expect(page.getByRole("tab", { name: /^Call tree/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("complementary", { name: "Details" })).toContainText("SELECT author");
});

test("what the records add up to: by level and logger, the first error, each a filter", async ({ page }) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=logs`);
  const sums = page.getByRole("list", { name: "What the records add up to" });

  await expect(sums.getByRole("button", { name: /^error 1$/i })).toBeVisible();
  await expect(sums.getByRole("button", { name: /^info 5$/i })).toBeVisible();
  await expect(sums.getByRole("button", { name: /^warning 1$/i })).toBeVisible();
  await expect(sums.getByRole("button", { name: /^debug 1$/i })).toBeVisible();
  await expect(sums.getByRole("img", { name: "Records over the time, by level" })).toBeVisible();

  await sums.getByRole("button", { name: /^error 1$/i }).click();
  await expect(records(page)).toHaveCount(1);
  await sums.getByRole("button", { name: /^error 1$/i }).click();
  await sums.getByRole("button", { name: /^yoga 2$/ }).click();
  await expect(records(page)).toHaveCount(2);
  await sums.getByRole("button", { name: /^yoga 2$/ }).click();

  await sums.getByRole("button", { name: /First error/ }).click();
  await expect(records(page)).toHaveCount(8);
  await expect(page.locator('[data-record][aria-expanded="true"]')).toContainText("no author 2");
});
