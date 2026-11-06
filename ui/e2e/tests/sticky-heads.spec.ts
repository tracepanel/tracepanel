// A sticky head stays over all that scrolls under it: the panel's details' tabs over a chain's Profile switches (Time
// and Memory, the app: laid over the tab's head, a layer up).
import type { Page } from "@playwright/test";
import { openApp, panel, pill } from "../app.ts";
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

test("the details' tabs stay over a chain's Profile switches as they scroll under them", async ({ page }) => {
  const view = await withMemory(page);
  await page.setViewportSize({ width: 1440, height: 700 });
  await openApp(page, { one: { status: 200, trace: view, queries: 1, totalMs: 300 } });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const details = panel(page).locator(".panel-wf-details");
  await details.getByRole("tab", { name: /^Profile/ }).click();
  const switches = details.getByRole("tablist", { name: "Profile of" });
  await expect(switches).toBeVisible();

  // Scrolled a step at a time until the switches are half under the tabs' bottom edge.
  const covered = await switches.evaluate((list) => {
    const pane = list.closest(".panel-wf-details");
    const tabs = pane?.querySelector(".tp-tabs");
    if (!(pane && tabs)) return "no details";
    for (let step = 0; step < 80; step++) {
      const box = list.getBoundingClientRect();
      if (box.top < tabs.getBoundingClientRect().bottom - box.height / 2) break;
      pane.scrollTop += 4;
    }
    const [box, bottom] = [list.getBoundingClientRect(), tabs.getBoundingClientRect().bottom];
    if (box.top >= bottom) return "not under";
    const top = document.elementFromPoint(box.left + 8, bottom - 2);
    return top?.closest(".tp-tabs") ? "tabs" : (top?.className.toString() ?? "nothing");
  });

  expect(covered).toBe("tabs");
});
