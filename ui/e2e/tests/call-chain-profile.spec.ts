// The profiles of a chain of calls in one call tree: a browser's click calls a BFF that was profiled (the panel's
// Profile toggle asked, and the browser and the BFF passed the ask on), whose call reached a service that wasn't.
// The BFF's row has the flame a code row has, and leads to its own profile; the code rows inside its trace name what
// ran from its profile, not the click's. The links are the agent's (`related`), here made up for traces of their own.
import type { Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

/** A ULID of this test's own: 26 Crockford characters. */
function id(n: number): string {
  return `01M4PR0F${String(n).padStart(18, "0")}`;
}

/** A request of one of the apps: its root and the spans under it (ids after the trace's). */
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
      ...spans.map((each) => ({ ...each, id: `${trace}${each["id"]}`, parent_id: `${trace}R` })),
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

/** A profile as the SDKs send one: `resolve_books` computing from 12 ms to 28 ms of the trace, 1 ms a sample. */
function profile(): Doc {
  // biome-ignore-start lint/style/useNamingConvention: a profile as the SDKs send it.
  return {
    interval_us: 1_000,
    samples: 16,
    dropped: 0,
    bucket_us: 1_000,
    frames: [
      { function: "handle", module: "server", file: "server.js", line: 10, in_app: true },
      { function: "resolve_books", module: "resolvers", file: "resolvers.js", line: 42, in_app: true },
    ],
    stacks: [{ frames: [0, 1], count: 16, at: Array.from({ length: 16 }, (_, index) => [12 + index, 1]) }],
  };
  // biome-ignore-end lint/style/useNamingConvention: a profile as the SDKs send it.
}

/**
 * The click's call reached the BFF, profiled: 30 ms, its one call to the service in the first 10 ms, the rest its
 * own code. The service's trace has no profile. Every link answered, the BFF's trace stored as the agent would.
 */
async function chain(page: Page): Promise<{ click: string; bff: string }> {
  const click = await (await page.request.get(`/api/traces/${await traceId('/books › click "Save"')}`)).json();
  const call = (click.spans as Doc[]).find((one) => one["id"] === `${click.id}C200`) ?? {};
  const start = Number(call["start"]);
  const service = served(2, "library-api", "GET /books", start + 1_500, 7_000);
  const bff = served(1, "library-bff", "POST /graphql", start, Number(call["duration"]), [
    {
      id: "B",
      kind: "http.client",
      name: "GET 127.0.0.1/books",
      start: start + 1_000,
      duration: 8_000,
      status: "ok",
      attrs: { "http.request.method": "GET" },
    },
  ]);
  bff["profile"] = profile();
  const links: Record<string, Doc> = {
    [click.id]: linking([[`${click.id}C200`, bff]]),
    [String(bff["id"])]: linking([[`${bff["id"]}B`, service]]),
  };
  await page.route("**/api/traces/*/related", async (route) => {
    const trace = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    await route.fulfill({ json: links[trace] ?? linking([]) });
  });
  await page.route(`**/api/traces/${bff["id"]}`, (route) => route.fulfill({ json: bff }));
  return { click: click.id, bff: String(bff["id"]) };
}

function codeRows(scope: Page | ReturnType<typeof panel>) {
  return scope.locator('.dt-map-row[data-kind="code"]');
}

test("a call's trace with a profile has the flame; its code rows say what ran from its own profile", async ({
  page,
}) => {
  const { click } = await chain(page);
  await page.goto(`/#/t/${click}?tab=tree`);
  const bff = page.getByRole("button", { name: /^app POST \/graphql/ });
  const service = page.getByRole("button", { name: /^app GET \/books/ });

  await expect(bff).toHaveAttribute("aria-expanded", "true");
  await expect(bff.locator(".dt-map-flame[data-on]")).toBeVisible();
  await expect(bff.locator(".dt-map-flame")).toHaveAttribute("title", "Open its profile");
  await expect(service).toBeVisible();
  await expect(service.locator(".dt-map-flame")).toHaveCount(0);

  // The BFF's own code after its call, named by the BFF's profile, with the same flame.
  const code = codeRows(page).filter({ hasText: "resolve_books" });
  await expect(code).toHaveCount(1);
  await expect(code.locator(".dt-map-kind")).toHaveText("code");
  await expect(code.locator(".dt-map-flame[data-on]")).toBeVisible();
  await expect(code.locator(".dt-map-time")).toHaveText(/^2\d ms$/);
});

test("the flame on a call's trace opens that trace at its Profile tab, the way back to the click kept", async ({
  page,
}) => {
  const { click, bff } = await chain(page);
  await page.goto(`/#/t/${click}?tab=tree`);

  await page
    .getByRole("button", { name: /^app POST \/graphql/ })
    .locator(".dt-map-flame")
    .click();

  await expect(page).toHaveURL(new RegExp(`#/t/${bff}\\?.*tab=profile`));
  await expect(page.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Profile of the whole trace")).toBeVisible();
  await expect(page.getByRole("region", { name: "Time by package" }).getByRole("button")).toHaveText([
    /^your code\s*1\d ms\s*100%$/,
  ]);
});

test("a code row of a call's trace, and its details' link, open that trace's profile", async ({ page }) => {
  const { click, bff } = await chain(page);
  await page.goto(`/#/t/${click}?tab=tree`);

  await codeRows(page).filter({ hasText: "resolve_books" }).click();

  await expect(page).toHaveURL(new RegExp(`#/t/${bff}\\?.*tab=profile`));

  await page.goto(`/#/t/${click}?tab=tree`);
  await page.getByRole("button", { name: /^app POST \/graphql/ }).click();
  const details = page.getByRole("complementary", { name: "Details" });
  await details.getByRole("button", { name: "Open its profile →" }).click();

  await expect(page).toHaveURL(new RegExp(`#/t/${bff}\\?.*tab=profile`));
});

test("in the panel, the flame opens the call's trace at its Profile tab in place, with the way back", async ({
  page,
}) => {
  const { click } = await chain(page);
  await openApp(page, { save: { status: 200, trace: click, queries: 0, totalMs: 40 } });
  await page.getByRole("button", { name: "Load save" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await expect(codeRows(frame).filter({ hasText: "resolve_books" })).toHaveCount(1);

  await frame
    .getByRole("button", { name: /^app POST \/graphql/ })
    .locator(".dt-map-flame")
    .click();

  await expect(frame.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
  await expect(frame.getByText("Profile of the whole trace")).toBeVisible();
  await expect(frame.getByRole("button", { name: "Back" })).toBeVisible();
});
