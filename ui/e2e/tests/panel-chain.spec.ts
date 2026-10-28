// Under a row of the panel's list whose trace called other apps: an app's row (open), then its traces in the order
// they started, as the call tree's chain has them, three or more of one route in a row in a run (open while the app
// has at most 50). A trace's row opens it; the app's row opens the row's trace under that app.
import type { Locator, Page } from "@playwright/test";
import { openApp, panel, pill } from "../app.ts";
import { chain, chainTrace, type FanoutCall, fanout } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

test("a row that called another app has that app's traces under it, open, in order; each opens", async ({ page }) => {
  await chain();
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, { graphql: { status: 200, trace: chainTrace("bff"), queries: 0, totalMs: 8 } });
  await page.getByRole("button", { name: "Load graphql" }).click();
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  const app = list.locator('.dt-request-row[data-chain="app"]');
  const run = list.locator('.dt-request-row[data-chain="run"]');
  const traces = list.locator('.dt-request-row[data-chain="trace"]');

  await expect(app).toHaveCount(1);
  // The app's chip with its mark; how many, as a run counts its traces.
  await expect(app.locator(".dt-app-chip")).toHaveText("shop");
  await expect(app.locator(".dt-app-chip .dt-icon")).toBeVisible();
  await expect(app.locator(".dt-map-times")).toHaveText("×3");
  await expect(app).toHaveAttribute("title", /^shop: 3 traces for/);
  await expect(app.locator(".dt-request-queries")).toHaveText("3");
  await expect(app).toHaveAttribute("aria-expanded", "true");
  // Three of one route in a row: a run, open (few traces), each of them under it, by its own path.
  await expect(run).toHaveCount(1);
  await expect(run).toContainText("/authors/{id}");
  await expect(run).toContainText("×3");
  await expect(run.locator(".dt-request-queries")).toHaveText("3");
  await expect(run).toHaveAttribute("aria-expanded", "true");
  await expect(traces.locator(".dt-request-path")).toHaveText(["/authors/1", "/authors/2", "/authors/3"]);
  await expect(traces.first()).toHaveAttribute("title", "GET /authors/{id}");
  await expect(traces.first().locator(".dt-map-flame")).toBeVisible();

  await traces.nth(1).click();

  // That one, beside the list; its row is the one selected, the rows stay open.
  await expect(traces.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(panel(page).getByRole("tab", { name: /^Request/ })).toBeVisible();
  await expect(panel(page).locator("body")).toContainText("GET /authors/2");
  await expect(app).toHaveAttribute("aria-expanded", "true");

  await app.click();

  // The BFF's trace, its tabs under the app's traces.
  await expect(panel(page).locator(".dt-scope-chip")).toContainText("Under shop");
  await expect(panel(page).getByRole("tab", { name: /^DB/ })).toHaveAttribute("aria-selected", "true");
  await expect(panel(page).getByText("3 queries · 1 unique")).toBeVisible();

  // As in the call tree: ← folds it, → opens it again.
  await app.focus();
  await page.keyboard.press("ArrowLeft");

  await expect(app).toHaveAttribute("aria-expanded", "false");
  await expect(run).toHaveCount(0);

  await page.keyboard.press("ArrowRight");

  await expect(run).toHaveCount(1);
});

test("an app's row the user folded stays folded when the panel reloads", async ({ page }) => {
  await chain();
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, { graphql: { status: 200, trace: chainTrace("bff"), queries: 0, totalMs: 8 } });
  await page.getByRole("button", { name: "Load graphql" }).click();
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  const app = list.locator('.dt-request-row[data-chain="app"]');
  await app.locator('[data-toggle=""]').click();

  await expect(app).toHaveAttribute("aria-expanded", "false");

  await page.reload();
  await page.getByRole("button", { name: "Load graphql" }).click();
  // The panel may open by itself again (it keeps its state for the tab): opened once either way.
  await expect(pill(page)).toBeVisible();
  if (!(await list.isVisible())) await pill(page).click();

  // The request's row again (and the new request's, the same trace): what was folded is still.
  await expect(app.first()).toBeVisible({ timeout: 15_000 });
  for (const row of await app.all()) await expect(row).toHaveAttribute("aria-expanded", "false");
});

/** The panel's list, a BFF's request in it (`bff`), its app's row (open): its rows under it. */
async function listed(page: Page, bff: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, { graphql: { status: 200, trace: bff, queries: 0, totalMs: 8 } });
  await page.getByRole("button", { name: "Load graphql" }).click();
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  const app = list.locator('.dt-request-row[data-chain="app"]');
  await expect(app).toHaveCount(1);
  await expect(app).toHaveAttribute("aria-expanded", "true");
  return {
    list,
    app,
    run: list.locator('.dt-request-row[data-chain="run"]'),
    traces: list.locator('.dt-request-row[data-chain="trace"]'),
    more: list.locator('.dt-request-row[data-chain="more"]'),
  };
}

const authors = (count: number, from: number, at: number): FanoutCall[] =>
  Array.from({ length: count }, (_, n) => ({
    route: "/authors/{author_id}",
    path: `/authors/${from + n}`,
    at: at + n * 1_000,
  }));

test("an app's 37 traces are all there, in order, the run of 36 open", async ({ page }) => {
  const { bff } = await fanout(1, [{ route: "/books", path: "/books", at: 0 }, ...authors(36, 1, 1_000)]);
  const { app, run, traces } = await listed(page, bff);

  await expect(app).toContainText("shop");
  await expect(app.locator(".dt-map-times")).toHaveText("×37");
  await expect(run).toHaveCount(1);
  await expect(run).toContainText("/authors/{author_id}");
  await expect(run).toContainText("×36");
  await expect(run).toHaveAttribute("aria-expanded", "true");
  await expect(traces).toHaveCount(37);
  await expect(traces.locator(".dt-request-path")).toHaveText([
    "/books",
    ...Array.from({ length: 36 }, (_, n) => `/authors/${n + 1}`),
  ]);

  await traces.nth(7).click();

  await expect(traces.nth(7)).toHaveAttribute("aria-current", "true");
  await expect(panel(page).getByRole("tab", { name: /^Request/ })).toBeVisible();

  // Folded, the run holds the one selected; the app's other row stays.
  await run.click();

  await expect(run).toHaveAttribute("aria-expanded", "false");
  await expect(run).toHaveAttribute("aria-current", "true");
  await expect(traces).toHaveCount(1);
});

test("an app's traces go by when they started on the caller's clock, across routes; what they called under them", async ({
  page,
}) => {
  // Out of order here, sent in reverse: the list orders them by start.
  const { bff } = await fanout(2, [
    {
      route: "/reviews/{id}",
      path: "/reviews/4",
      at: 3_000,
      calls: { app: "shop", route: "/stars", path: "/stars" },
    },
    { route: "/books", path: "/books", at: 0 },
    { route: "/authors/{author_id}", path: "/authors/2", at: 2_000 },
    { route: "/authors/{author_id}", path: "/authors/1", at: 1_000 },
    ...authors(3, 3, 4_000),
    { route: "/books", path: "/books", at: 9_000 },
  ]);
  const { list, run, traces } = await listed(page, bff);

  // Two of a route in a row stay rows; three are a run.
  await expect(run).toHaveCount(1);
  await expect(traces.locator(".dt-request-path")).toHaveText([
    "/books",
    "/authors/1",
    "/authors/2",
    "/reviews/4",
    "/authors/3",
    "/authors/4",
    "/authors/5",
    "/books",
  ]);

  // The review's call: under it, folded, the app that served it (its row open, its one trace under it).
  const review = traces.nth(3);
  await expect(review).toHaveAttribute("aria-expanded", "false");
  await review.focus();
  await page.keyboard.press("ArrowRight");

  const deeper = list.locator('.dt-request-row[data-chain="app"]').nth(1);
  await expect(deeper).toContainText("shop");
  await expect(deeper).toHaveAttribute("title", /^shop: 1 trace for/);
  await expect(deeper).toHaveAttribute("aria-expanded", "true");
  await expect(traces.locator(".dt-request-path")).toHaveText([
    "/books",
    "/authors/1",
    "/authors/2",
    "/reviews/4",
    "/stars",
    "/authors/3",
    "/authors/4",
    "/authors/5",
    "/books",
  ]);
});

test("an app with more than 50 traces has its runs folded; open, the first 50, then all of them", async ({ page }) => {
  // The agent brings 50 of one trace's calls; more come from elsewhere (the cloud's): ten more, after them.
  const { bff } = await fanout(3, authors(50, 1, 0));
  await page.route(`**/api/traces/${bff}/chain`, async (route) => {
    const response = await route.fetch();
    const chain = (await response.json()) as { traces: Record<string, unknown>[] };
    const last = chain.traces.at(-1) as { id: string; trace: Record<string, unknown> };
    const more = Array.from({ length: 10 }, (_, n) => {
      const id = `${last.id.slice(0, -2)}9${n}`;
      const start = (last.trace["start"] as number) + (n + 1) * 1_000;
      const attrs = { ...(last.trace["attrs"] as object), "http.path": `/authors/${51 + n}` };
      return { ...last, id, trace: { ...last.trace, id, start, attrs } };
    });
    await route.fulfill({ response, json: { ...chain, traces: [...chain.traces, ...more] } });
  });
  const { app, run, traces, more } = await listed(page, bff);

  await expect(app.locator(".dt-map-times")).toHaveText("×60");
  await expect(run).toContainText("×60");
  await expect(run).toHaveAttribute("aria-expanded", "false");
  await expect(traces).toHaveCount(0);

  await run.click();

  await expect(traces).toHaveCount(50);
  await expect(more).toHaveText("Show all 60");

  await more.click();

  await expect(traces).toHaveCount(60);
  await expect(traces.last().locator(".dt-request-path")).toHaveText("/authors/60");
  await expect(more).toHaveCount(0);
});

test("at the list's default width a chain row's path keeps its last segment whole, cut in its middle; a run's say what tells them apart", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("tracepanel:list-width", "315"));
  const product = "/api/catalog/products/trail-runner-gtx";
  const { bff } = await fanout(4, [
    { route: "/api/catalog/products/{slug}", path: product, at: 0 },
    ...[7, 12, 345].map((id, n) => ({
      route: "/api/library/authors/{author_id}",
      path: `/api/library/authors/${id}`,
      at: 1_000 + n * 1_000,
    })),
  ]);
  const { run, traces } = await listed(page, bff);
  const paths = traces.locator(".dt-request-path");

  await expect(run).toContainText("/api/library/authors/{author_id}");
  await expect(paths).toHaveText([
    product,
    "/api/library/authors/7",
    "/api/library/authors/12",
    "/api/library/authors/345",
  ]);
  await expect(paths.locator(".dt-path-tail")).toHaveText(["/trail-runner-gtx", "/7", "/12", "/345"]);
  // Whole in the tooltip.
  expect(await paths.evaluateAll((each) => each.map((path) => path.getAttribute("title")))).toEqual([
    product,
    "/api/library/authors/7",
    "/api/library/authors/12",
    "/api/library/authors/345",
  ]);
  // The run says the method once: its traces don't.
  await expect(traces.first().locator(".dt-method")).toHaveText("GET");
  await expect(traces.locator(".dt-method")).toHaveCount(1);

  // No ellipsis inside a last segment: the head gave way (the product's cut in its middle).
  const tails = await paths
    .locator(".dt-path-tail")
    .evaluateAll((each) => each.map((tail) => tail.scrollWidth > tail.clientWidth));
  expect(tails).toEqual([false, false, false, false]);
  // The run's own row too: its route's last segment whole.
  await expect(run.locator(".dt-path-tail")).toHaveText("/{author_id}");
  expect(await run.locator(".dt-path-tail").evaluate((tail) => tail.scrollWidth > tail.clientWidth)).toBe(false);
  expect(
    await paths
      .first()
      .locator(".dt-path-head")
      .evaluate((head) => head.scrollWidth > head.clientWidth),
  ).toBe(true);
});

/** Each row's badge (method or kind) and name: where they start, how wide the badge, the gap to the name. */
function badges(list: Locator) {
  return list.locator(".dt-request-row").evaluateAll((rows) =>
    rows.flatMap((row) => {
      const badge = row.querySelector(".dt-request-main :is(.dt-method, .dt-kind:not([data-muted]))");
      const name = row.querySelector(".dt-request-main .dt-request-path");
      if (!(badge && name)) return [];
      const [b, n] = [badge.getBoundingClientRect(), name.getBoundingClientRect()];
      return [
        {
          chain: row.getAttribute("data-chain"),
          from: Math.round(b.left),
          name: Math.round(n.left),
          gap: n.left - b.right,
        },
      ];
    }),
  );
}

for (const theme of ["light", "dark"]) {
  test(`the list's badges take a compact slot, the names a small gap after and lined up (${theme})`, async ({
    page,
  }) => {
    const { bff } = await fanout(12, [{ route: "/books", path: "/books", at: 0 }, ...authors(3, 1, 1_000)]);
    await page.addInitScript((theme) => localStorage.setItem("tracepanel:theme", theme), theme);
    const { list } = await listed(page, bff);
    await expect(list.locator('.dt-request-row[data-chain="trace"]')).toHaveCount(4);

    const rows = await badges(list);
    const top = rows.filter((row) => row.chain === null);
    const traces = rows.filter((row) => row.chain === "trace" || row.chain === "run");

    expect(top.length).toBeGreaterThan(0);
    expect(traces.length).toBeGreaterThan(1);
    // A small gap: the slot fits five letters, a three-letter badge leaves two and the row's gap.
    for (const row of rows) expect(row.gap).toBeLessThanOrEqual(28);
    // At each depth, the names start at one edge.
    expect(new Set(top.map((row) => row.name - row.from)).size).toBe(1);
    expect(new Set(traces.map((row) => row.name)).size).toBe(1);
  });
}
