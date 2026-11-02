// One model of where a request, a view or a call is (lib/live), said the same way in the pill, its card, the panel's
// list and the call tree: in flight (a ring, its time ticking), done, failed, and no answer yet (a call cut short,
// its time never red). Slow answers are held here until the test lets them through.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { type Call, openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

async function posts(): Promise<Call> {
  return { status: 200, trace: await traceId("GET /api/posts"), queries: 14, totalMs: 5, issues: 1 };
}

/** The answers to /app/api/slow, held until `release` is called. */
async function holdSlow(page: Page, call: Call): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/app/api/slow", async (route) => {
    await gate;
    await route.fulfill({
      status: call.status,
      contentType: "application/json",
      body: "{}",
      headers: {
        "Tracepanel-Id": call.trace,
        "Server-Timing": `db;dur=1;desc="${call.queries} queries", total;dur=${call.totalMs}, tracepanel-issues;desc="0"`,
      },
    });
  });
  return release;
}

/** The panel docked at the right or the bottom, open, before the page loads. */
async function docked(page: Page, dock: "right" | "bottom"): Promise<void> {
  await page.addInitScript((side) => {
    sessionStorage.setItem("tracepanel:panel", JSON.stringify({ open: true, dock: side }));
  }, dock);
}

/** The recording's announcement of a view of `path` (a route change of the SPA), open or ended. */
async function announce(page: Page, id: string, path: string, open: boolean): Promise<void> {
  await page.evaluate((detail) => dispatchEvent(new CustomEvent("tracepanel:page", { detail })), {
    id,
    name: path,
    start: Date.now() * 1000,
    duration: open ? 0 : 2_000_000,
    status: "ok",
    open,
  });
}

const list = (page: Page) => panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });

test("a request in flight shows on the pill, in its card and in the list, its time ticking, until it answers", async ({
  page,
}) => {
  const call = await posts();
  await docked(page, "bottom");
  await openApp(page, { slow: call });
  const release = await holdSlow(page, call);

  await page.getByRole("button", { name: "Load slow" }).click();

  // The pill: the request by its name, a ring and its time so far, its queries pending, no status yet.
  await expect(pill(page)).toHaveAccessibleName(/^tracepanel: GET \/app\/api\/slow, running for /);
  const running = pill(page).locator('.seg[data-state="running"]');
  await expect(running.locator(".running")).toHaveCount(1);
  const before = await running.innerText();
  await expect(running).not.toHaveText(before);
  await expect(pill(page).locator(".status")).toHaveCount(0);
  await expect(pill(page).locator(".pending")).toHaveText("…");

  // The list: its row under the page, running, its time ticking as the pill's.
  const row = list(page).locator('.dt-request-row[data-state="running"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("/app/api/slow");
  await expect(row.locator(".dt-running")).toHaveCount(1);

  release();

  await expect(pill(page)).toHaveAccessibleName(/^tracepanel: GET \/app\/api\/slow → 200/);
  await expect(pill(page).locator('.seg[data-state="running"]')).toHaveCount(0);
  await expect(list(page).locator('.dt-request-row[data-state="running"]')).toHaveCount(0);
});

test("the hover card of a request in flight says it waits, and follows it as it answers", async ({ page }) => {
  const call = await posts();
  await openApp(page, { slow: call });
  const release = await holdSlow(page, call);

  await page.getByRole("button", { name: "Load slow" }).click();
  await expect(pill(page).locator('.seg[data-state="running"]')).toHaveCount(1);
  await pill(page).hover();
  const card = page.getByRole("dialog", { name: "This request at a glance" });

  await expect(card).toContainText("Waiting for its answer");
  await expect(card.locator(".running")).toHaveCount(1);

  release();

  // Open all along: drawn again with the answer, no hover needed.
  await expect(card).not.toContainText("Waiting for its answer");
  await expect(card.locator(".status")).toHaveText("200");
});

test("an SPA's route change is a new page: the pill shows its view running, not the last view's requests", async ({
  page,
}) => {
  await openApp(page, { posts: await posts() }, { recording: true });
  await page.getByRole("button", { name: "Load posts" }).click();
  await expect(pill(page)).toContainText("/app/api/posts");

  await announce(page, "01M4E2ELIVE000000000000001", "/app/next", true);

  await expect(pill(page)).toContainText("VIEW /app/next");
  await expect(pill(page)).not.toContainText("/app/api/posts");
  await expect(pill(page).locator('.seg[data-state="running"]')).toHaveCount(1);
  await expect(pill(page)).toHaveAccessibleName(/^tracepanel: view of \/app\/next, running for /);
});

test("docked at the right, the panel follows a new view as the bottom dock does, named as the list names it", async ({
  page,
}) => {
  await docked(page, "right");
  await openApp(page, { posts: await posts() }, { recording: true });
  await page.getByRole("button", { name: "Load posts" }).click();
  const main = panel(page).getByRole("main");
  // The view its request came from, as Follow new keeps it: never the request, then the view again.
  await expect(panel(page).locator(".switcher-button")).toContainText(/VIEW\s*\/app\//);

  await announce(page, "01M4E2ELIVE000000000000002", "/app/authors", true);

  // The view, not the request before it: its name as the list says it, its pane running.
  await expect(panel(page).locator(".switcher-button")).toContainText(/VIEW\s*\/app\/authors/);
  await expect(main.getByText("View still open")).toBeVisible();
  await expect(main.locator('[data-state="running"]')).toHaveCount(1);
});

// A view cut at 15 s, its call to the BFF never answered: as the browser recording sends it.
const CUT_VIEW = "01M4C0TCA11000000000000002";

function span(id: string, parent: string | null, kind: string, name: string, at: [number, number], attrs: Doc): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start: at[0], duration: at[1], status: "ok", attrs };
}

async function storeCutView(): Promise<void> {
  // Cut a moment ago: its call is still waited for.
  const start = Date.now() * 1000 - 20_000_000;
  const trace = {
    id: CUT_VIEW,
    kind: "page",
    name: "/books/1",
    start,
    duration: 15_000_000,
    status: "ok",
    attrs: { "service.name": "library-web", "page.trigger": "navigation" },
    spans: [
      span("r", null, "page", "/books/1", [start, 15_000_000], {}),
      span("c", "r", "http.client", "POST 127.0.0.1:8051/graphql", [start + 10_000, 14_990_000], {
        "http.request.method": "POST",
        "url.full": "http://127.0.0.1:8051/graphql",
        "w3c.span_id": "9d39dea96533e5ec",
        "http.unfinished": true,
      }),
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([trace]),
  });
  expect(response.status).toBe(202);
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${CUT_VIEW}`)).status).toBe(200);
}

test("a call with no answer yet says so in the call tree, its time neutral, and the tree says it is partial", async ({
  page,
}) => {
  await storeCutView();
  await page.goto(`/#/t/${CUT_VIEW}?tab=tree`);

  const row = page.locator('.dt-map-row[data-kind="http.client"]').filter({ hasText: "/graphql" });
  await expect(row.locator('[data-state="cut"]')).toHaveText("no answer yet");
  await expect(row.locator(".dt-map-time")).toHaveText("15.0 s");
  // Not slow: it hadn't ended.
  await expect(row.locator(".dt-map-time")).not.toHaveAttribute("data-slow", /.+/);
  await expect(page.locator(".dt-on-its-way")).toHaveText(
    "1 call with no answer yet: the tree fills in if its trace arrives",
  );
});

test("a view cut with a call unanswered says no answer, in its row and on the pill, as the call tree does", async ({
  page,
}) => {
  await storeCutView();
  await docked(page, "bottom");
  await openApp(page, {}, { recording: true, view: CUT_VIEW });

  await expect(pill(page).locator('[data-state="cut"]')).toHaveText("no answer yet");
  // Its time is where it was cut, never a slow time's red.
  await expect(pill(page).locator(".seg[data-speed]")).toHaveCount(0);

  const row = list(page).locator('.dt-request-row[data-kind="page"]').first();
  await expect(row).toHaveAttribute("data-state", "cut");
  await expect(row.locator('[data-state="cut"]')).toHaveText("no answer");
  // Its call, still waiting: said so under it, and kept while it is.
  await expect(list(page).locator('.dt-request-row[data-chain="waiting"]')).toContainText("no answer yet");
  await page.waitForTimeout(5_500);
  await expect(list(page).locator('.dt-request-row[data-chain="waiting"]')).toContainText("no answer yet");
});
