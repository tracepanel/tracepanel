// A trace's Request tab: the request itself first, then the traces linked to it, alike ones as one row.
import { expect, test } from "../fixtures.ts";

test("a request's deliveries come after the request, the same listener's as one row", async ({ page }) => {
  await page.goto(`/#/traces?q=${encodeURIComponent("route:/api/books/announce")}`);
  await page.getByRole("main").getByRole("table").getByRole("link").first().click();
  await page.getByRole("tab", { name: /^Request/ }).click();
  const related = page.getByRole("region", { name: "Related traces" });

  await expect(related).toContainText("Delivered to (3)");
  await expect(related.getByText("BookEvents.onAnnounced")).toHaveCount(1);
  await expect(related).toContainText("×3");
  // The request's own rows first: its URL is above the related traces.
  const url = await page.getByText("/api/books/announce", { exact: true }).first().boundingBox();
  const linked = await related.boundingBox();
  expect(url && linked && url.y < linked.y).toBe(true);
});

test("a call's details name its fields in words, then list every attribute", async ({ page, request }) => {
  const query = encodeURIComponent('kind:page name:"/books › click \\"Save\\""');
  const found = (await (await request.get(`/api/traces?q=${query}&limit=1`)).json()) as { traces: { id: string }[] };
  await page.goto(`/#/t/${found.traces[0]?.id}`);
  await page.getByText("GET 127.0.0.1/api/books").first().click();
  const details = page.getByRole("complementary", { name: "Details" });

  await expect(details.getByText("URL", { exact: true })).toBeVisible();
  await expect(details).toContainText("http://127.0.0.1:8028/api/books");
  await expect(details.getByRole("region", { name: "All attributes" })).toContainText("url.full");
});

test("a message's details are in its broker's words first: a Kafka topic, a RabbitMQ queue", async ({ page }) => {
  await page.goto(`/#/traces?q=${encodeURIComponent("route:/api/books/announce")}`);
  await page.getByRole("main").getByRole("table").getByRole("link").first().click();
  const details = page.getByRole("complementary", { name: "Details" });

  await page.getByText("publish book-events").first().click();
  await expect(details).toContainText("Topic");
  await expect(details).toContainText("book-events");
  await expect(details).toContainText("Partition");
  await expect(details).toContainText("localhost:9092");
  await expect(details.getByRole("region", { name: "All attributes" })).toContainText("messaging.destination.name");

  await page.getByText("publish book-announcements").first().click();
  await expect(details).toContainText("Queue");
  await expect(details).toContainText("Routing key");
  await expect(details).toContainText("BookEvents.java:31");
});

test("a record is found by the call it was logged in, and says where that was", async ({ page }) => {
  await page.goto(`/#/logs?q=${encodeURIComponent("in:kafka")}`);
  const list = page.getByRole("region", { name: "Logs" });
  const rows = list.getByRole("rowgroup").last().getByRole("row");

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Kafka producer started");

  await rows.first().click();
  const where = list.getByRole("navigation", { name: "Logged in" });
  await expect(where.getByRole("button", { name: /publish book-events/ })).toBeVisible();
  await expect(where.getByRole("link", { name: "In the call tree" })).toBeVisible();

  await page.goto(`/#/logs?q=${encodeURIComponent("in!=kafka route:/api/books/announce")}`);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("3 books announced");
});

test("a library frame with no source is one line, nothing to open", async ({ page, request }) => {
  const found = (await (
    await request.get(`/api/traces?q=${encodeURIComponent("route:/boom service:api")}&limit=1`)
  ).json()) as {
    traces: { id: string }[];
  };
  await page.goto(`/#/t/${found.traces[0]?.id}`);
  await page.getByRole("tab", { name: /^Error/ }).click();
  await page
    .getByText(/library frames/)
    .first()
    .click();

  await expect(page.getByText("runtime.goexit")).toBeVisible();
  await expect(page.getByText("Source not available.")).toHaveCount(0);
});

test("a span whose parent never arrived still shows, under the request", async ({ page }) => {
  await page.goto(`/#/traces?q=${encodeURIComponent("route:/api/books/announce")}`);
  await page.getByRole("main").getByRole("table").getByRole("link").first().click();

  await expect(page.getByText("orphan block")).toBeVisible();
});

test("span: finds the traces with a span by that name, whatever it is", async ({ page }) => {
  await page.goto(`/#/traces?q=${encodeURIComponent("span:blog/async_post_list.html")}`);

  await expect(page.getByText("1 shown")).toBeVisible();
  await expect(page.getByRole("main").getByText("/async/")).toBeVisible();
});

test("the Request tab says what went unrecorded, and when the app's clock is off", async ({ page }) => {
  await page.goto(`/#/traces?q=${encodeURIComponent("route:/api/clock")}`);
  await page.getByRole("main").getByRole("table").getByRole("link").first().click();
  await page.getByRole("tab", { name: /^Request/ }).click();

  await expect(page.getByText("501 spans and 1503 log records: over the limit of one trace")).toBeVisible();
  await expect(page.getByText(/The app's clock is about 2\.\d h behind this machine's/)).toBeVisible();
});

test("a call another project's agent served shows under it, opening in that project's console", async ({ page }) => {
  // The agent of the other project as the related traces bring it: the call's span here, its trace and console.
  await page.route("**/api/traces/*/related", async (route) => {
    const related = await (await route.fetch()).json();
    const trace = await (await page.request.get(route.request().url().replace("/related", ""))).json();
    const call = trace.spans.find((span: { kind: string }) => span.kind === "rabbitmq");
    related.remote_calls = [
      {
        // biome-ignore lint/style/useNamingConvention: the API's wire format.
        span_id: call.id,
        trace: { ...related.delivered[0], id: "01M4R1ER9RWER0QHV07BJDSZ7Z", name: "POST /orders" },
        console: "http://127.0.0.1:9999/",
        project: "orders",
      },
    ];
    await route.fulfill({ json: related });
  });
  await page.goto(`/#/traces?q=${encodeURIComponent("route:/api/books/announce")}`);
  await page.getByRole("main").getByRole("table").getByRole("link").first().click();
  await page.getByText("POST /orders").first().click();

  await expect(page.getByText("orders", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in orders's console" })).toHaveAttribute(
    "href",
    "http://127.0.0.1:9999/#/t/01M4R1ER9RWER0QHV07BJDSZ7Z",
  );
});

test("a record in the call tree shows where it was logged, its attributes", async ({ page }) => {
  await page.goto(`/#/traces?q=${encodeURIComponent("route:/api/books/announce")}`);
  await page.getByRole("main").getByRole("table").getByRole("link").first().click();
  await page.getByText("Kafka producer started").first().click();
  const details = page.getByRole("complementary", { name: "Details" });

  await expect(details.getByRole("region", { name: "All attributes" })).toContainText("thread.name");
  await expect(details).toContainText("kafka-producer-network-thread");
});

test("a record in a trace's Logs tab opens its attributes", async ({ page }) => {
  await page.goto(`/#/traces?q=${encodeURIComponent("route:/api/books/announce")}`);
  await page.getByRole("main").getByRole("table").getByRole("link").first().click();
  await page.getByRole("tab", { name: /^Logs/ }).click();
  const record = page.getByRole("button", { name: "Kafka producer started", exact: true });

  await expect(record).toHaveAttribute("aria-expanded", "false");
  await record.click();

  await expect(record).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("kafka-producer-network-thread")).toBeVisible();
});
