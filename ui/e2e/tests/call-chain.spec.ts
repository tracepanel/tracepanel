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
    return doc;
  });
  const bff = served(170, "library-bff", "POST /graphql", start, Number(call["duration"]), [
    ...authors.flatMap((_, n) => [
      {
        ...span("", `F${n}`, "function", "Book.author", start + 1_000 + n * 20, 3_200),
        attrs: { "graphql.field": "Book.author", "graphql.path": `books.${n}.author` },
      },
      {
        ...span("", `A${n}`, "http.client", `GET 127.0.0.1/authors/${n + 1}`, start + 1_050 + n * 20, 3_000),
        // biome-ignore lint/style/useNamingConvention: the trace format.
        parent_id: `F${n}`,
      },
    ]),
  ]);
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
  await expect(page.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors\/\d+/i })).toHaveCount(
    AUTHORS,
  );
  const service = page.getByRole("button", { name: /^app GET \/authors\/2\b/ });
  await expect(service).toHaveAttribute("aria-expanded", "false");

  await service.locator(".dt-map-caret[data-toggle]").click();

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
  const client = page.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors\/2 /i });
  const service = page.getByRole("button", { name: /^app GET \/authors\/2\b/ });
  await service.locator(".dt-map-caret[data-toggle]").click();
  const sql = page.getByRole("button", { name: /^sql SELECT author\.name/i });
  const record = page.locator('.dt-map-row[data-kind="log"]').filter({ hasText: "author 2 served" });

  // The service ran 2 ms of the 3 ms call: centred in it, 0.5 ms either side, though its clock read 5 ms ahead.
  const [call, served, query] = [await bar(client), await bar(service), await bar(sql)];
  expect(served.left).toBeGreaterThan(call.left);
  expect(served.right).toBeLessThan(call.right);
  expect(query.left).toBeGreaterThanOrEqual(served.left - 0.5);
  expect(query.right).toBeLessThanOrEqual(served.right + 0.5);
  await expect(service.locator(".dt-map-time")).toHaveText("2 ms");
  await expect(service.locator(".dt-map-time")).toHaveAttribute(
    "title",
    /^Its app.s clock is 5 ms ahead of this one.s: drawn centred in the 3 ms call, the 1 ms not spent/,
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
  const client = page.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors\/1 /i });
  const service = page.getByRole("button", { name: /^app GET \/authors\/1\b/ });

  const [call, served] = [await bar(client), await bar(service)];
  expect(served.left).toBeGreaterThanOrEqual(call.left - 0.5);
  expect(served.right).toBeLessThanOrEqual(call.right + 0.5);
  await expect(service.locator(".dt-map-time")).toHaveText("4 ms");
  await expect(service.locator(".dt-map-time")).toHaveAttribute(
    "title",
    /^Served in 4 ms by its app's clock, 1 ms more than the 3 ms call/,
  );
});

test("a click's call tree opens the whole chain: the BFF, each service call, the service's SQL, its own call", async ({
  page,
}) => {
  const asked = await chain(page);
  const bff = page.getByRole("button", { name: /^app POST \/graphql/ });

  // The BFF's trace, open under the click's call, with its own calls in it: the 36 to one endpoint one row.
  await expect(bff).toHaveAttribute("aria-expanded", "true");
  const group = page.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors\/\{id\}/i });
  await expect(group).toContainText(`×${AUTHORS}`);
  await expect(group).toHaveAttribute("aria-expanded", "false");

  // The books' call reached the service: one of many calls, so its trace is a click away.
  const books = page.getByRole("button", { name: /^app GET \/books/ });
  await expect(books).toHaveAttribute("aria-expanded", "false");
  await expect(books.locator(".dt-app-chip")).toHaveText("library-api");

  await books.locator(".dt-map-caret[data-toggle]").click();

  // The service's SQL, and the call it made in turn, open with its trace: the one call there.
  await expect(books).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /^sql SELECT book\.id/i })).toBeVisible();
  const pricing = page.getByRole("button", { name: /^app GET \/prices/ });
  await expect(pricing).toHaveAttribute("aria-expanded", "true");
  await expect(pricing.locator(".dt-app-chip")).toHaveText("pricing");
  await expect(page.getByRole("button", { name: /^sql SELECT price FROM prices/i })).toBeVisible();

  // One row, one look at every level: the BFF's trace and the pricing one's are the same kind of row.
  for (const row of [bff, books, pricing]) {
    await expect(row).toHaveAttribute("data-kind", "task");
    await expect(row.locator(".dt-map-kind")).toHaveText("app");
  }

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

  const authors = page.getByRole("button", { name: /^app GET \/authors\/\d+/ });
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
  const books = frame.getByRole("button", { name: /^app GET \/books/ });

  await expect(frame.getByRole("button", { name: /^app POST \/graphql/ })).toHaveAttribute("aria-expanded", "true");
  await expect(frame.getByRole("button", { name: /^http\.client GET 127\.0\.0\.1\/authors\/\{id\}/i })).toContainText(
    `×${AUTHORS}`,
  );

  await books.locator(".dt-map-caret[data-toggle]").click();

  await expect(frame.getByRole("button", { name: /^app GET \/prices/ })).toHaveAttribute("aria-expanded", "true");
  await expect(frame.getByRole("button", { name: /^sql SELECT price FROM prices/i })).toBeVisible();
});
