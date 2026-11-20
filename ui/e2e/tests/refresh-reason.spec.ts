// A load that fails says why as the answer gives it: an SDK's proxy with no console behind it answers a 503 whose
// `error` names the reason and the fix, and the refresh button's title shows that, not "HTTP 503".
// Playwright's own test, not ../fixtures.ts: the 503s are the point here, not a problem to fail on.
import { expect, test } from "@playwright/test";

test("a load the console's proxy refuses says the proxy's reason on the refresh button", async ({ page }) => {
  const reason = "The project's agent runs without its console (it was started without --serve).";
  await page.route(/\/api\//, (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: reason }) }),
  );
  await page.goto("/#/pages");
  const refresh = page.getByRole("button", { name: "Refresh now" });

  await expect(refresh).toHaveAttribute("title", `Couldn't refresh: ${reason} · click to retry`);
});
