// A request reads once in a list: its method in the badge, then its path. An SDK that sends no path (an
// OpenTelemetry server span with only `http.url`) still gets a line that doesn't say the method twice.
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";
import { trace } from "../seed.ts";

test("a request with no path reads its method once, in the badge", async ({ page }) => {
  const name = `/hooks/stripe-${Date.now()}`;
  const doc = trace("http", `POST ${name}`, {
    "service.name": "shop-node",
    "http.method": "POST",
    "http.status_code": 200,
  });
  // Hours ago, older than the seed's traces: no list opens on it.
  doc["start"] = Date.now() * 1000 - 3 * 3_600_000_000;
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);

  await page.goto(`/#/traces?q=${encodeURIComponent(`${name} since:6h`)}`);
  const cell = page.getByRole("main").getByRole("cell").filter({ hasText: name });

  await expect(cell).toHaveCount(1);
  await expect(cell).toHaveText(`POST${name}`);
});
