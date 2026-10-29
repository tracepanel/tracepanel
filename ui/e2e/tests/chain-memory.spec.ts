// A chain's Profile tab where some of its traces measured their memory: Time or Memory, as a trace's own tab has
// it. Memory shows each app whose traces measured it (theirs added up), with what it adds up to and its sites.
import type { Page } from "@playwright/test";
import { chain } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

type Placed = { app: string; trace: { name: string; profile?: Record<string, unknown> } };

/** The chain with its BFF as an app of its own (`shop-bff`), the service's first two traces with their memory. */
async function withMemory(page: Page): Promise<string> {
  const view = await chain();
  await page.route(`**/api/traces/${view}/chain`, async (route) => {
    const answer = await route.fetch();
    const body = (await answer.json()) as { traces: Placed[] };
    for (const each of body.traces) {
      if (each.trace.name === "POST /graphql") each.app = "shop-bff";
      if (each.trace.profile && ["GET /authors/1", "GET /authors/2"].includes(each.trace.name)) {
        each.trace.profile["memory"] = {
          peak: 2_000_000,
          net: 1_000_000,
          allocated: 3_000_000,
          // biome-ignore lint/style/useNamingConvention: the trace format.
          sites_at: "peak",
          sites: [{ frames: [0], bytes: 1_500_000, count: 10 }],
        };
      }
    }
    await route.fulfill({ response: answer, json: body });
  });
  return view;
}

test("a chain's Memory view: each app whose traces measured it, added up, with where it was", async ({ page }) => {
  const view = await withMemory(page);
  await page.goto(`/#/t/${view}?tab=profile`);
  const kinds = page.getByRole("tablist", { name: "Profile of" });

  await expect(kinds.getByRole("tab")).toHaveText(["Time", "Memory"]);
  await expect(kinds.getByRole("tab", { name: "Time" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Profile of shop-bff", exact: true })).toBeVisible();

  await kinds.getByRole("tab", { name: "Memory" }).click();

  await expect(page.locator(".dt-scope-summary-text")).toHaveText("2 traces with their memory");
  const sums = page.getByRole("table", { name: "What the memory adds up to" }).locator("tbody tr");
  await expect(sums).toHaveCount(1);
  await expect(sums.locator("td")).toHaveText(["shop", "1.9 MB", "+1.9 MB", "get_author"]);
  // The BFF measured none: only its time.
  await expect(page.getByRole("region", { name: "Memory of shop-bff" })).toHaveCount(0);
  const shop = page.getByRole("region", { name: "Memory of shop", exact: true });

  await expect(shop).toContainText("Memory of 2 traces");
  await expect(shop).toContainText("peak of one of them, above where it started");
  await expect(shop).toContainText("net +1.9 MB · 5.7 MB allocated in all");
  await expect(shop.getByRole("region", { name: "Allocation sites" }).getByRole("listitem")).toHaveText([
    /get_author.*app\/main\.py:115.*2\.9 MB.*100%/,
  ]);

  await kinds.getByRole("tab", { name: "Time" }).click();

  await expect(page.getByRole("region", { name: "Profile of shop", exact: true })).toContainText("Profile of 3 traces");
});

test("a chain none of whose traces measured its memory has no Memory choice", async ({ page }) => {
  const view = await chain();
  await page.goto(`/#/t/${view}?tab=profile`);

  await expect(page.getByRole("table", { name: "What the profiles add up to" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Profile of" })).toHaveCount(0);
});
