import { laidOut } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { gatewayView } from "../gateway.ts";

test("in a narrow call tree a call's status is never cut, nested rows too: its name gives way first, then its app", async ({
  page,
}) => {
  const seeded = await gatewayView(5, ["query TextCampaignsCampaignsForTheWholeTenant", "query Features"], {
    untraced: "http://127.0.0.1:8160/openapi.json",
  });
  // As narrow as the panel docked right gets.
  for (const width of [520, 420, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/t/${seeded.view}?tab=tree`);
    const hops = page.locator('.tp-map-row[data-hop=""]');
    // The view's two calls, the gateway's to the subgraph, the subgraph's to the service.
    await expect(hops).toHaveCount(4);
    const untraced = page
      .locator('.tp-map-row[data-kind="http.client"]')
      .filter({ has: page.locator(".tp-not-traced"), hasText: "openapi.json" });
    await expect(untraced).toHaveCount(1);
    await laidOut(page);
    const clipped = await hops.evaluateAll((rows) =>
      rows.map((row) => {
        const name = row.querySelector(":scope > .tp-map-name");
        const badge = name?.querySelector(":scope > .tp-status, :scope > .tp-map-slot > .tp-status");
        const [box, edge] = [name?.getBoundingClientRect(), badge?.getBoundingClientRect()];
        const whole = badge ? badge.scrollWidth <= badge.clientWidth : false;
        return {
          status: badge?.textContent,
          whole,
          past: box && edge ? Math.max(0, Math.round(edge.right - box.right)) : -1,
        };
      }),
    );
    // Each badge whole, inside the name's box: none of it past the edge where the box cuts what overflows.
    expect({ width, clipped }).toEqual({
      width,
      clipped: Array.from({ length: 4 }, () => ({ status: "200", whole: true, past: 0 })),
    });
    // A call no trace answered keeps its status and "not traced" whole the same way; what is before them gives way,
    // cut with an ellipsis: its kind, its name.
    const kept = await untraced.evaluate((row) => {
      const name = row.querySelector(":scope > .tp-map-name");
      const box = name?.getBoundingClientRect();
      const whole = (selector: string) => {
        const part = name?.querySelector(`:scope > ${selector}, :scope > .tp-map-slot > ${selector}`);
        const edge = part?.getBoundingClientRect();
        return {
          text: part?.textContent,
          whole: part ? part.scrollWidth <= part.clientWidth : false,
          past: box && edge ? Math.max(0, Math.round(edge.right - box.right)) : -1,
        };
      };
      const cut = [...(name?.querySelectorAll(".tp-map-lead *") ?? [])]
        .filter((part) => part.children.length === 0 && part.scrollWidth > part.clientWidth)
        .map((part) => getComputedStyle(part).textOverflow);
      return { status: whole(".tp-status"), mark: whole(".tp-not-traced"), cut: [...new Set(cut)] };
    });
    expect({ width, kept }).toEqual({
      width,
      kept: {
        status: { text: "200", whole: true, past: 0 },
        mark: { text: "not traced", whole: true, past: 0 },
        cut: kept.cut.length ? ["ellipsis"] : [],
      },
    });
  }
});
