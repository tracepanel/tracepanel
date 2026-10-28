// A chain of calls across apps in one call tree: a browser's click calls a GraphQL BFF, whose resolvers call a
// service (one call per book's author, an N+1, and one for the books), which calls another in turn. Each trace's
// links are the agent's (`related`), here made up for traces of their own; the tree asks for each level's as it opens.
import type { Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const AUTHORS = 36;

/** A ULID of this test's own: 26 Crockford characters. */
function id(n: number): string {
  return `01M4CHAN${String(n).padStart(18, "0")}`;
}

function span(trace: string, suffix: string, kind: string, name: string, start: number, duration: number): Doc {
  return {
    id: `${trace}${suffix}`,
    // biome-ignore lint/style/useNamingConvention: the trace format.
    parent_id: `${trace}R`,
    kind,
    name,
    start,
    duration,
    status: "ok",
    attrs: kind === "http.client" ? { "http.request.method": name.split(" ")[0] } : {},
  };
}

/** A request of one of the apps: its root and the spans under it. */
function served(n: number, service: string, name: string, start: number, duration: number, spans: Doc[] = []): Doc {
  const trace = id(n);
  return {
    id: trace,
    kind: "http",
    name,
    start,
    duration,
    status: "ok",
    attrs: { "service.name": service, "http.method": name.split(" ")[0], "http.route": name.split(" ")[1] },
    spans: [
      // biome-ignore lint/style/useNamingConvention: the trace format.
      { id: `${trace}R`, parent_id: null, kind: "http", name, start, duration, status: "ok", attrs: {} },
      // biome-ignore lint/style/useNamingConvention: the trace format.
      ...spans.map((each) => ({ ...each, id: `${trace}${each["id"]}`, parent_id: `${trace}${each["parent_id"]}` })),
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
}

/** A trace as a list row of the API (`TraceSummary`). */
function summary(doc: Doc): Doc {
  const attrs = doc["attrs"] as Doc;
  // biome-ignore-start lint/style/useNamingConvention: the API's wire format.
  return {
    id: doc["id"],
    service: attrs["service.name"],
    kind: "http",
    name: doc["name"],
    start: doc["start"],
    duration: doc["duration"],
    status: "ok",
    http_status: 200,
    method: attrs["http.method"],
    path: attrs["http.route"],
    route: attrs["http.route"],
    view: null,
    user_id: null,
    queries: 0,
    db_time: 0,
    issues: 0,
    errors: 0,
    logs: 0,
    mails: 0,
    issue_kinds: [],
    db_aliases: [],
    cache_aliases: [],
    task_state: null,
    htmx: null,
    // What a test says its list row found (its queries, its issues).
    ...(doc["summary"] as Doc | undefined),
  };
  // biome-ignore-end lint/style/useNamingConvention: the API's wire format.
}

/** What the agent says of a trace whose calls these traces served, each under its call's span. */
function linking(calls: [string, Doc][]): Doc {
  // biome-ignore-start lint/style/useNamingConvention: the API's wire format.
  return {
    enqueued_by: null,
    enqueued: [],
    connection: null,
    connection_events: [],
    sent_by: null,
    delivered: [],
    called_by: null,
    calls: calls.map(([, doc]) => summary(doc)),
    remote_calls: [],
    call_traces: Object.fromEntries(calls.map(([, doc]) => [doc["id"], doc])),
    via: Object.fromEntries(calls.map(([via, doc]) => [doc["id"], via])),
  };
  // biome-ignore-end lint/style/useNamingConvention: the API's wire format.
}

/**
 * The chain under the click's call, its links answered by trace id; the click's trace id, and the traces each level
 * asked for, in order.
 */
async function links(page: Page): Promise<{ click: string; asked: string[] }> {
  const click = await (await page.request.get(`/api/traces/${await traceId('/books › click "Save"')}`)).json();
  const start = Number(click.start) + 2_000;
  // The pricing service the books' service asks: one call, so it opens by itself.
  const pricing = served(90, "pricing", "GET /prices", start + 5_000, 2_000, [
    span("", "Q", "sql", "SELECT price FROM prices", start + 5_500, 800),
  ]);
  const books = served(80, "library-api", "GET /books", start + 1_000, 9_000, [
    span("", "Q", "sql", "SELECT book.id, book.title FROM book", start + 1_500, 1_000),
    span("", "P", "http.client", "GET pricing.local/prices", start + 4_800, 2_500),
  ]);
  // Its list row's findings, in the API's wire format: an N+1, five queries.
  books["summary"] = { queries: 5, ["issue_kinds"]: ["n+1"] };
  const authors = Array.from({ length: AUTHORS }, (_, n) =>
    served(n + 1, "library-api", `GET /authors/${n + 1}`, start + 11_000 + n * 500, 400, [
      span("", "Q", "sql", "SELECT author.name FROM author WHERE author.id = $1", start + 11_100 + n * 500, 200),
    ]),
  );
  const bff = served(70, "library-bff", "POST /graphql", start, 30_000, [
    span("", "B", "http.client", "GET 127.0.0.1/books", start + 900, 9_500),
    ...authors.map((_, n) =>
      span("", `A${n}`, "http.client", `GET 127.0.0.1/authors/${n + 1}`, start + 10_900 + n * 500, 450),
    ),
  ]);
  // GraphQL Yoga's coloured logger, as it reached the trace before the agent dropped the colours.
  bff["logs"] = [
    {
      // biome-ignore lint/style/useNamingConvention: the trace format.
      span_id: null,
      time: start + 100,
      level: "WARNING",
      logger: "\u001b[2myoga\u001b[0m",
      message: "\u001b[35mGraphQL\u001b[39m \u001b[1mquery Books\u001b[22m took 30 ms",
      exception: null,
      attrs: {},
    },
  ];
  const links: Record<string, Doc> = {
    [click.id]: linking([[`${click.id}C200`, bff]]),
    [String(bff["id"])]: linking([
      [`${bff["id"]}B`, books],
      ...authors.map((doc, n): [string, Doc] => [`${bff["id"]}A${n}`, doc]),
    ]),
    [String(books["id"])]: linking([[`${books["id"]}P`, pricing]]),
  };
  const asked: string[] = [];
  await page.route("**/api/traces/*/related", async (route) => {
    const trace = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    asked.push(trace);
    await route.fulfill({ json: links[trace] ?? linking([]) });
  });
  return { click: click.id, asked };
}

/** The click's trace on the console's page, its call tree open. */
async function chain(page: Page): Promise<string[]> {
  const { click, asked } = await links(page);
  await page.goto(`/#/t/${click}?tab=calls`);
  return asked;
}

/** Each request the API's links answer with, by the trace asking. */
async function answer(page: Page, links: Record<string, Doc>): Promise<void> {
  await page.route("**/api/traces/*/related", async (route) => {
    const trace = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    await route.fulfill({ json: links[trace] ?? linking([]) });
  });
}

/** Where every Book.author resolver of the BFF runs from. */
const RESOLVER = "src/schema.ts:42 in author";

/** How far ahead of the BFF's clock the service's runs (µs): more than the way there and back takes. */
const AHEAD = 5_000;

/**
 * A GraphQL BFF whose `Book.author` resolver runs once per book, side by side, each calling the service; the
 * service's clock runs ahead of the BFF's, and its first request took longer than the call by the BFF's clock.
 */
async function resolvers(page: Page): Promise<number> {
  const click = await (await page.request.get(`/api/traces/${await traceId('/books › click "Save"')}`)).json();
  const call = (click.spans as Doc[]).find((one) => one["id"] === `${click.id}C200`) ?? {};
  // The BFF's request as long as the click's call: on one clock with it, it stays where it is.
  const start = Number(call["start"]);
  const authors = Array.from({ length: AUTHORS }, (_, n) => {
    const at = start + 1_050 + n * 20 + AHEAD;
    const doc = served(n + 101, "library-api", `GET /authors/${n + 1}`, at, n === 0 ? 4_000 : 2_000, [
      span("", "Q", "sql", "SELECT author.name FROM author WHERE author.id = $1", at + 200, 500),
    ]);
    doc["logs"] = [
      {
        // biome-ignore lint/style/useNamingConvention: the trace format.
        span_id: null,
        time: at + 1_900,
        level: "INFO",
        logger: "app",
        message: `author ${n + 1} served`,
        exception: null,
        attrs: {},
      },
    ];
    // Its list row's findings: its one query.
    doc["summary"] = { queries: 1 };
    return doc;
  });
  const bff = served(170, "library-bff", "POST /graphql", start, Number(call["duration"]), [
    ...authors.flatMap((_, n) => [
      {
        ...span("", `F${n}`, "function", "Book.author", start + 1_000 + n * 20, 3_200),
        attrs: { "graphql.field": "Book.author", "graphql.path": `books.${n}.author`, "code.origin": RESOLVER },
      },
      {
        ...span("", `A${n}`, "http.client", `GET 127.0.0.1/authors/${n + 1}`, start + 1_050 + n * 20, 3_000),
        // biome-ignore lint/style/useNamingConvention: the trace format.
        parent_id: `F${n}`,
      },
    ]),
  ]);
  // The BFF's finding: the 36 calls together are one N+1.
  bff["issues"] = [
    {
      fingerprint: "authors-n1",
      // biome-ignore lint/style/useNamingConvention: the trace format.
      fingerprint_version: 1,
      kind: "n+1",
      title: "N+1: 36 similar calls · GET 127.0.0.1/authors/{id}",
      culprit: null,
      hint: null,
      count: AUTHORS,
      // biome-ignore lint/style/useNamingConvention: the trace format.
      span_ids: authors.map((_, n) => `${bff["id"]}A${n}`),
    },
  ];
  await answer(page, {
    [click.id]: linking([[`${click.id}C200`, bff]]),
    [String(bff["id"])]: linking(authors.map((doc, n): [string, Doc] => [`${bff["id"]}A${n}`, doc])),
  });
  await page.goto(`/#/t/${click.id}?tab=calls`);
  return start - Number(click.start);
}

/** A row's bar, left and right edge on the page. */
async function bar(row: ReturnType<Page["getByRole"]>): Promise<{ left: number; right: number }> {
  const box = await row.locator(".dt-map-bar").first().boundingBox();
  if (!box) throw new Error("no bar on the row");
  return { left: box.x, right: box.x + box.width };
}

/** The row of a call merged with the trace it served, by its method and path. */
function hop(scope: Page | ReturnType<typeof panel>, call: string) {
  const text = call.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return scope.getByRole("button", { name: new RegExp(`^http\\.client ${text} served by`, "i") });
}

/** The server's part of a merged call's bar, left and right edge on the page. */
async function serverBar(row: ReturnType<Page["getByRole"]>): Promise<{ left: number; right: number }> {
  const box = await row.locator(".dt-map-bar[data-server]").boundingBox();
  if (!box) throw new Error("no server bar on the row");
  return { left: box.x, right: box.x + box.width };
}

test("a resolver run per item groups as one row; open, each runs its call, and that call's service trace", async ({
  page,
}) => {
  await resolvers(page);
  const group = page.getByRole("button", { name: /^function Book\.author/i }).first();

  await expect(group).toContainText(`×${AUTHORS}`);
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors/i })).toHaveCount(0);

  await group.locator(".dt-map-caret[data-toggle]").click();

  await expect(page.getByRole("button", { name: /^function Book\.author \d+ ms$/i })).toHaveCount(AUTHORS);
  // Each call one row with the trace it served: no row of its own for the service's trace.
  await expect(
    page.getByRole("button", { name: /^http\.client GET \/authors\/\d+ served by library-api/i }),
  ).toHaveCount(AUTHORS);
  await expect(page.locator('.dt-map-row[data-kind="task"]')).toHaveCount(0);
  const call = hop(page, "GET /authors/2");
  await expect(call).toHaveAttribute("aria-expanded", "false");

  await call.locator(".dt-map-caret[data-toggle]").click();

  await expect(page.getByRole("button", { name: /^sql SELECT author\.name/i })).toHaveCount(1);
});

test("calls side by side show the time they ran from first to last; what they took added up is on hover", async ({
  page,
}) => {
  await resolvers(page);
  const group = page.getByRole("button", { name: /^function Book\.author/i }).first();
  const time = group.locator(".dt-map-time");

  // 36 resolvers of 3.2 ms each, 20 µs apart: 3.9 ms from the first's start to the last's end, 115 ms added up.
  await expect(time).toHaveText("4 ms");
  await expect(time).toHaveAttribute("title", "36 calls · 115 ms total, 4 ms from the first's start to the last's end");

  await group.click();

  await expect(page.getByRole("complementary", { name: "Details" })).toContainText(
    "36 similar calls · took 4 ms · 115 ms total",
  );
});

test("another app's trace on its own clock is drawn inside its call, its rows too; times stay as measured", async ({
  page,
}) => {
  const bff = await resolvers(page);
  await page
    .getByRole("button", { name: /^function Book\.author/i })
    .first()
    .locator(".dt-map-caret[data-toggle]")
    .click();
  const client = hop(page, "GET /authors/2");
  await client.locator(".dt-map-caret[data-toggle]").click();
  const sql = page.getByRole("button", { name: /^sql SELECT author\.name/i });
  const record = page.locator('.dt-map-row[data-kind="log"]').filter({ hasText: "author 2 served" });

  // The service ran 2 ms of the 3 ms call: centred in it, 0.5 ms either side, though its clock read 5 ms ahead.
  const [call, served, query] = [await bar(client), await serverBar(client), await bar(sql)];
  expect(served.left).toBeGreaterThan(call.left);
  expect(served.right).toBeLessThan(call.right);
  expect(query.left).toBeGreaterThanOrEqual(served.left - 0.5);
  expect(query.right).toBeLessThanOrEqual(served.right + 0.5);
  // The row's time is the call's; the server's part and the rest on hover, with what the clocks did.
  await expect(client.locator(".dt-map-time")).toHaveText("3 ms");
  await expect(client.locator(".dt-map-time")).toHaveAttribute(
    "title",
    /^server 2 ms · network 1 ms\nIts app.s clock is 5 ms ahead of this one.s: drawn centred in the 3 ms call, the 1 ms not spent/,
  );

  // Its record, on the same clock: before its call ended (4.1 ms after the BFF's start), not 5 ms after.
  const callEnd = (bff + 1_070 + 3_000) / 1000;
  const logged = Number.parseFloat((await record.locator(".dt-map-time").innerText()).slice(1));
  expect(logged).toBeLessThanOrEqual(Math.round(callEnd));
});

test("a served request longer than its call by the caller's clock ends with the call, and says why", async ({
  page,
}) => {
  await resolvers(page);
  await page
    .getByRole("button", { name: /^function Book\.author/i })
    .first()
    .locator(".dt-map-caret[data-toggle]")
    .click();
  const client = hop(page, "GET /authors/1");

  const [call, served] = [await bar(client), await serverBar(client)];
  expect(served.left).toBeGreaterThanOrEqual(call.left - 0.5);
  expect(served.right).toBeLessThanOrEqual(call.right + 0.5);
  await expect(client.locator(".dt-map-time")).toHaveText("3 ms");
  await expect(client.locator(".dt-map-time")).toHaveAttribute(
    "title",
    /^server 4 ms by its app's clock\nServed in 4 ms by its app's clock, 1 ms more than the 3 ms call/,
  );
});

test("a click's call tree opens the whole chain: the BFF, each service call, the service's SQL, its own call", async ({
  page,
}) => {
  const asked = await chain(page);
  // The click's call and the BFF's trace it reached: one row, the BFF's name after its app (it isn't the path).
  const bff = hop(page, "GET /api/books");
  await expect(bff.locator(".dt-app-chip")).toHaveText("library-bff");
  await expect(bff.locator(".dt-map-hop-name")).toHaveText("POST /graphql");

  // The BFF's trace, open under the click's call, with its own calls in it: the 36 to one endpoint one row.
  await expect(bff).toHaveAttribute("aria-expanded", "true");
  const group = page.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors\/\{id\}/i });
  await expect(group).toContainText(`×${AUTHORS}`);
  await expect(group).toHaveAttribute("aria-expanded", "false");

  // The books' call reached the service: one of many calls, so its trace is a click away.
  const books = hop(page, "GET /books");
  await expect(books).toHaveAttribute("aria-expanded", "false");
  await expect(books.locator(".dt-app-chip")).toHaveText("library-api");
  await expect(books.locator(".dt-map-hop-name")).toHaveText("");

  await books.locator(".dt-map-caret[data-toggle]").click();

  // The service's SQL, and the call it made in turn, open with its trace: the one call there.
  await expect(books).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /^sql SELECT book\.id/i })).toBeVisible();
  const pricing = hop(page, "GET /prices");
  await expect(pricing).toHaveAttribute("aria-expanded", "true");
  await expect(pricing.locator(".dt-app-chip")).toHaveText("pricing");
  await expect(page.getByRole("button", { name: /^sql SELECT price FROM prices/i })).toBeVisible();

  // One row, one look at every level: each call with the trace it served, no row of an app's own.
  for (const row of [bff, books, pricing]) {
    await expect(row).toHaveAttribute("data-kind", "http.client");
    await expect(row).toHaveAttribute("data-hop", "");
    await expect(row.locator(".dt-map-kind")).toHaveText("http.client");
  }
  await expect(page.locator('.dt-map-row[data-kind="task"]')).toHaveCount(0);

  // Each level's links were asked for once, as it opened; the authors' traces not, still folded.
  expect(asked.filter((trace) => trace === id(70))).toHaveLength(1);
  expect(asked.filter((trace) => trace === id(80))).toHaveLength(1);
  expect(asked.filter((trace) => Number(trace.slice(8)) <= AUTHORS)).toEqual([]);
});

test("an N+1 of calls to a service opens to each call, each with the service's trace folded under it", async ({
  page,
}) => {
  await chain(page);
  const group = page.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors\/\{id\}/i });

  await group.locator(".dt-map-caret[data-toggle]").click();

  const authors = page.getByRole("button", { name: /^http\.client GET \/authors\/\d+ served by/i });
  await expect(authors).toHaveCount(AUTHORS);
  for (const row of await authors.all()) await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: /^sql SELECT author\.name/i })).toHaveCount(0);

  await authors.nth(4).locator(".dt-map-caret[data-toggle]").click();

  await expect(authors.nth(4)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /^sql SELECT author\.name/i })).toHaveCount(1);

  // A row deep down the chain opens its details from its own trace.
  await page.getByRole("button", { name: /^sql SELECT author\.name/i }).click();
  await expect(page.getByRole("complementary", { name: "Details" })).toContainText("SELECT");
});

test("a record a coloured logger wrote shows its text without the escapes, in the call tree", async ({ page }) => {
  await chain(page);
  const tree = page.locator(".dt-map-rows");
  const record = tree.locator('.dt-map-row[data-kind="log"]').filter({ hasText: "query Books" });

  await expect(record).toContainText("GraphQL query Books took 30 ms");
  await expect(tree).not.toContainText("[35m");
  expect(await tree.innerText()).not.toContain("\u001b");

  await record.click();

  const details = page.getByRole("complementary", { name: "Details" });
  await expect(details).toContainText("GraphQL query Books took 30 ms");
  await expect(details.getByText("yoga", { exact: true })).toBeVisible();
  expect(await details.innerText()).not.toContain("\u001b");
});

test("in the panel too, the click's call tree opens the chain, row for row as the page does", async ({ page }) => {
  const { click } = await links(page);
  await openApp(page, { save: { status: 200, trace: click, queries: 0, totalMs: 40 } });
  await page.getByRole("button", { name: "Load save" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  const books = hop(frame, "GET /books");

  await expect(hop(frame, "GET /api/books")).toHaveAttribute("aria-expanded", "true");
  await expect(frame.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors\/\{id\}/i })).toContainText(
    `×${AUTHORS}`,
  );

  await books.locator(".dt-map-caret[data-toggle]").click();

  await expect(hop(frame, "GET /prices")).toHaveAttribute("aria-expanded", "true");
  await expect(frame.getByRole("button", { name: /^sql SELECT price FROM prices/i })).toBeVisible();
});

test("a call and the trace it served are one row: the app and what it found, the server's time inside the call's", async ({
  page,
}) => {
  await chain(page);
  const books = hop(page, "GET /books");

  await expect(books.locator(".dt-map-op")).toHaveText("GET");
  await expect(books.locator(".dt-map-hop")).toHaveText("→");
  await expect(books.locator(".dt-app-chip")).toHaveText("library-api");
  await expect(books.locator(".dt-run-chips")).toContainText("N+1");
  await expect(books.locator(".dt-request-queries")).toHaveText("5");

  // The call took 9.5 ms, the service 9 ms of it, drawn inside it; the row's time is the call's.
  const [call, served] = [await bar(books), await serverBar(books)];
  expect(served.left).toBeGreaterThanOrEqual(call.left - 0.5);
  expect(served.right).toBeLessThanOrEqual(call.right + 0.5);
  expect(served.right - served.left).toBeLessThan(call.right - call.left);
  await expect(books.locator(".dt-map-time")).toHaveText("10 ms");
  await expect(books.locator(".dt-map-time")).toHaveAttribute("title", /^server 9 ms · network 0.5 ms$/);
});

test("a merged call opens straight on the served trace's rows, no row of its app in between", async ({ page }) => {
  await chain(page);
  const books = hop(page, "GET /books");

  await books.locator(".dt-map-caret[data-toggle]").click();

  // The service's query and its own call one level under the call, as the call's children.
  const sql = page.getByRole("button", { name: /^sql SELECT book\.id/i });
  await expect(sql).toBeVisible();
  const depth = async (row: ReturnType<Page["getByRole"]>) =>
    Number(await row.locator(".dt-map-name").evaluate((name) => getComputedStyle(name).getPropertyValue("--dt-depth")));
  expect(await depth(sql)).toBe((await depth(books)) + 1);
  expect(await depth(hop(page, "GET /prices"))).toBe((await depth(books)) + 1);

  // ← folds it back, as any row.
  await books.focus();
  await page.keyboard.press("ArrowLeft");

  await expect(books).toHaveAttribute("aria-expanded", "false");
  await expect(sql).toHaveCount(0);
});

test("a merged call's details: the call, then what served it", async ({ page }) => {
  await chain(page);

  await hop(page, "GET /books").click();

  const details = page.getByRole("complementary", { name: "Details" });
  const call = details.getByRole("region", { name: "Call" });
  const served = details.getByRole("region", { name: "Served by library-api" });
  await expect(call).toContainText("http.client · started at");
  await expect(call).toContainText("GET");
  await expect(served).toContainText("GET /books");
  await expect(served).toContainText("N+1");
  await expect(served.getByRole("link", { name: "Open the trace it served →" })).toBeVisible();
});

test("a call no trace served is a row as before: its host, no app, nothing under it", async ({ page }) => {
  await page.goto(`/#/t/${await traceId('/books › click "Delete"')}?tab=calls`);
  const call = page.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/api\/books/i });

  await expect(call).toBeVisible();
  await expect(call).not.toHaveAttribute("data-hop");
  await expect(call.locator(".dt-app-chip")).toHaveCount(0);
  await expect(call.locator(".dt-map-bar")).toHaveCount(1);
  await expect(call).not.toHaveAttribute("aria-expanded");
});

test("an N+1 of calls is said once, on its group's row: its calls don't each say it", async ({ page }) => {
  await resolvers(page);
  const group = page.getByRole("button", { name: /^function Book\.author/i }).first();

  await expect(group.locator('[data-slot="badge"]')).toHaveText("N+1");

  await group.locator(".dt-map-caret[data-toggle]").click();

  const calls = page.getByRole("button", { name: /^http\.client GET \/authors\/\d+ served by/i });
  await expect(calls).toHaveCount(AUTHORS);
  await expect(page.locator('.dt-map-rows [data-slot="badge"]')).toHaveText(["N+1"]);
});

test("a group's details say where its calls ran from when they all did from one place", async ({ page }) => {
  await resolvers(page);

  await page
    .getByRole("button", { name: /^function Book\.author/i })
    .first()
    .click();

  const details = page.getByRole("complementary", { name: "Details" });
  await expect(details.locator("[data-group-origin]")).toHaveText(`from ${RESOLVER}`);
});

test("a group's details without one place its calls ran from have no from", async ({ page }) => {
  await chain(page);

  await page.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors\/\{id\}/i }).click();

  const details = page.getByRole("complementary", { name: "Details" });
  await expect(details).toContainText(`${AUTHORS} similar HTTP calls`);
  await expect(details.locator("[data-group-origin]")).toHaveCount(0);
  await expect(details.locator("code:empty")).toHaveCount(0);
});

/**
 * Every chip of the call tree's rows that shows: whole, its text not cut (an app's name cut to a few letters at the
 * least), never an empty pill or an icon without its number. Those short of room go whole, below their row's line.
 */
async function chipsShowTheirText(page: Page | ReturnType<typeof panel>) {
  const chips = page.locator(
    '.dt-map-rows :is([data-slot="badge"], .dt-app-chip, .dt-request-queries, .dt-alias, .dt-map-times)',
  );
  expect(await chips.count()).toBeGreaterThan(0);
  const broken = await chips.evaluateAll((all) =>
    all.flatMap((chip) => {
      const text = (chip.textContent ?? "").trim() || chip.getAttribute("aria-label");
      const box = chip.getBoundingClientRect();
      const row = chip.closest(".dt-map-name")?.getBoundingClientRect();
      const line = chip.closest(".dt-map-chips")?.getBoundingClientRect() ?? row;
      if (!line || box.width === 0) return [];
      // Gone below the line: not shown.
      if (box.top >= line.bottom - 0.5) return [];
      const whole = box.left >= line.left - 0.5 && box.right <= line.right + 0.5;
      const label = chip.querySelector(".truncate, .dt-app-name") ?? chip;
      const cut = label.scrollWidth > label.clientWidth + 1;
      const readable = chip.matches(".dt-app-chip") ? label.clientWidth >= 14 : !cut;
      return text && whole && readable ? [] : [`${chip.className}: "${text}" ${Math.round(box.width)}px`];
    }),
  );
  expect(broken).toEqual([]);
}

test("no chip of the tree's rows is shown without its text, wide or narrow, in the console and the panel", async ({
  page,
}) => {
  await resolvers(page);
  const group = () => page.getByRole("button", { name: /^function Book\.author/i }).first();
  await group().locator(".dt-map-caret[data-toggle]").click();
  await hop(page, "GET /authors/1").click();

  for (const width of [1440, 1100, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await chipsShowTheirText(page);
  }

  const { click } = await links(page);
  await page.goto(`/#/t/${click}?tab=calls`);
  await hop(page, "GET /books").locator(".dt-map-caret[data-toggle]").click();
  await page
    .getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors\/\{id\}/i })
    .locator(".dt-map-caret[data-toggle]")
    .click();
  await chipsShowTheirText(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, { save: { status: 200, trace: click, queries: 0, totalMs: 40 } });
  await page.getByRole("button", { name: "Load save" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await hop(frame, "GET /books").locator(".dt-map-caret[data-toggle]").click();
  await hop(frame, "GET /books").click();

  await chipsShowTheirText(frame);
});
