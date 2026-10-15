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
