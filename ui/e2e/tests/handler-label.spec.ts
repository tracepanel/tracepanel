// What answered a request is named in its app's words: a view in a Python app (Django's word), a handler in a Java
// or JavaScript one. The data keeps code.view and a span of kind view either way; only the words shown differ.
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";
import { trace } from "../seed.ts";

type Doc = Record<string, unknown>;

// One worker for the file: seed.ts's ids count up per process, and two workers would make the same one.
test.describe.configure({ mode: "serial" });

/** A request whose handler took most of its time, as each SDK records it: the handler's span under the request's. */
function request(language: string, handler: string, fn: string | null): Doc {
  const path = `/books/${language}-${Date.now()}`;
  const doc = trace("http", `GET ${path}`, {
    "service.name": "shop",
    "telemetry.sdk.language": language,
    "http.method": "GET",
    "http.path": path,
    "http.route": "/books/{id}",
    "http.status_code": 200,
    "code.view": handler,
  });
  // Hours ago, older than the seed's traces: no list opens on these.
  doc["start"] = Date.now() * 1000 - 3 * 3_600_000_000;
  (doc["spans"] as Doc[]).push({
    id: `${doc["id"]}V`,
    // biome-ignore lint/style/useNamingConvention: a span as the SDKs send it.
    parent_id: `${doc["id"]}R`,
    kind: "view",
    name: handler,
    start: 1_000,
    duration: 40_000,
    status: "ok",
    attrs: fn ? { "code.function": fn } : {},
  });
  return doc;
}

async function store(doc: Doc): Promise<string> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);
  const id = String(doc["id"]);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${id}`)).status).toBe(200);
  return id;
}

const APPS = [
  {
    app: "Spring",
    language: "java",
    handler: "BookController#list",
    fn: "com.shop.BookController.list",
    word: "Handler",
  },
  { app: "Ktor", language: "kotlin", handler: "GET /books/{id}", fn: null, word: "Handler" },
  { app: "NestJS", language: "nodejs", handler: "BookController.list", fn: null, word: "Handler" },
  { app: "Django", language: "python", handler: "shop.views.book_list", fn: null, word: "View" },
];

for (const { app, language, handler, fn, word } of APPS) {
  test(`a ${app} request's ${word.toLowerCase()} is named so in its facts, its call tree and its time`, async ({
    page,
  }) => {
    const id = await store(request(language, handler, fn));
    await page.goto(`/#/t/${id}?tab=request`);
    // The request's own facts, first; its raw attributes (code.view among them) come in parts after.
    const facts = page.locator("dl").first();
    const term = (text: string) => facts.locator("dt").filter({ hasText: new RegExp(`^${text}$`) });
    const other = word === "View" ? "Handler" : "View";

    await expect(term(word)).toHaveCount(1);
    await expect(term(other)).toHaveCount(0);
    await expect(facts.getByRole("button", { name: `Copy ${word.toLowerCase()}` })).toHaveCount(1);
    await expect(facts.locator("dd").getByText(handler, { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Call tree" }).click();
    const row = page.locator('.dt-map-row[data-kind="view"]');

    await expect(row.locator(".dt-map-kind")).toHaveText(word.toLowerCase());
    // Its time is the code's own, said one way in every app and kind of trace.
    await expect(page.getByRole("list", { name: /^Where the time went/ })).toContainText("Your code");
  });
}

test("Spring's handler shows as BookController#list, its full name on hover", async ({ page }) => {
  const id = await store(request("java", "BookController#list", "com.shop.BookController.list"));
  await page.goto(`/#/t/${id}?tab=request`);

  await expect(page.locator("dl").first().getByText("BookController#list", { exact: true })).toHaveAttribute(
    "title",
    "com.shop.BookController.list",
  );
});
