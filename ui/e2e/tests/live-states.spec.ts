// One model of where a request, a view or a call is (lib/live), said the same way in the pill, its card, the panel's
// list and the call tree: in flight (a ring, its time ticking), done, failed, and no answer yet (a call cut short,
// its time never red). Slow answers are held here until the test lets them through.
import type { Locator, Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { type Call, laidOut, openApp, panel, pill, traceId } from "../app.ts";
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
async function announce(page: Page, id: string, path: string, open: boolean, start = Date.now() * 1000): Promise<void> {
  await page.evaluate((detail) => dispatchEvent(new CustomEvent("tracepanel:page", { detail })), {
    id,
    name: path,
    start,
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

test("the hover card open as a request answers fills in once its trace is stored, no hover needed", async ({
  page,
}) => {
  const call = await posts();
  await openApp(page, { slow: call });
  const release = await holdSlow(page, call);
  // The app writes its trace a moment after its answer: until then the agent hasn't got it.
  let stored = false;
  await page.route(`**/api/traces/${call.trace}`, (route) =>
    stored ? route.continue() : route.fulfill({ status: 404 }),
  );

  await page.getByRole("button", { name: "Load slow" }).click();
  await expect(pill(page).locator('.seg[data-state="running"]')).toHaveCount(1);
  await pill(page).hover();
  const card = page.getByRole("dialog", { name: "This request at a glance" });
  await expect(card).toContainText("Waiting for its answer");
  release();

  // Answered, not stored: its head, and where its time went still loading.
  await expect(card.locator(".status")).toHaveText("200");
  await expect(card.locator(".card-skeleton")).toHaveCount(2);
  await expect(card).not.toContainText("Fix first");

  stored = true;

  // Open all along: where its time went and what to fix first, as a card opened after it was stored shows them.
  await expect(card.locator(".card-bar")).toBeVisible();
  await expect(card).toContainText("Fix first");
  await expect(card.locator(".card-skeleton")).toHaveCount(0);
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

test("a click on the pill opens the panel though the pill draws again under the press: no click is lost", async ({
  page,
}) => {
  await openApp(page, {}, { recording: true });
  await announce(page, "01M4E2ELIVE000000000000003", "/app/pressed", false);
  await expect(pill(page)).toContainText("VIEW /app/pressed");

  // Pressed on the view's name, which something coming in draws again before the press ends (the browser fires no
  // click on a pressed element that went away).
  const name = pill(page).locator(".name").first();
  const box = await name.boundingBox();
  if (!box) throw new Error("the pill's name isn't shown");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await announce(page, "01M4E2ELIVE000000000000003", "/app/pressed", false);
  await page.mouse.up();

  await expect(pill(page)).toHaveAttribute("aria-expanded", "true");
  await expect(list(page)).toBeVisible();
});

test("a view on its first frame reads … where its time will tick, never 0 µs: in the pill, its card and the list", async ({
  page,
}) => {
  await openApp(page, { posts: await posts() }, { recording: true });
  await expect(pill(page)).toHaveAccessibleName(/^tracepanel: view of \/app\//);

  // Its start a moment ahead of this clock (the recording's clock rounds), as its first frame reads it, held there.
  await announce(page, "01M4E2ELIVE000000000000003", "/app/ahead", true, Date.now() * 1000 + 600_000_000);

  const running = pill(page).locator('.seg[data-state="running"]');
  await expect(running).toHaveText("…");
  await expect(pill(page)).toHaveAccessibleName(/^tracepanel: view of \/app\/ahead, running(\.|$)/);
  await pill(page).hover();
  const card = page.getByRole("dialog", { name: "This request at a glance" });
  await expect(card.locator(".card-running")).toHaveText("…");
  await pill(page).click();
  const row = list(page).locator('.dt-request-row[data-state="running"]');
  await expect(row.locator(".dt-running-time")).toHaveText("…");
  await expect(row).not.toContainText("µs");
});

test("an open view whose calls have all answered stops its time at the last answer while it waits for its end", async ({
  page,
}) => {
  await docked(page, "bottom");
  await openApp(page, { posts: await posts() }, { recording: true });
  const id = "01M4E2ELIVE000000000000004";
  const start = Date.now() * 1000 - 1_000_000;
  await announce(page, id, "/app/quiet", true, start);
  const row = list(page).locator(".dt-request-row", { hasText: "/app/quiet" });
  const time = row.locator(".dt-running-time");
  // Before its call: its time runs.
  const first = await time.innerText();
  await expect(time).not.toHaveText(first);

  // The view's call, marked as the recording marks the calls of the view that made them.
  await page.evaluate((view) => {
    const send = window.fetch;
    window.fetch = async (...args) => {
      const response = await send(...args);
      Object.defineProperty(response, Symbol.for("tracepanel.page"), { value: view });
      return response;
    };
  }, id);
  await page.getByRole("button", { name: "Load posts" }).click();
  await expect(list(page).locator(".dt-request-row", { hasText: "/api/posts" })).toHaveCount(1);

  // Answered, the view still open (it waits a moment for more): its time stays at the answer, ring and all.
  await expect(row).toHaveAttribute("data-state", "running");
  const stopped = await time.innerText();
  await page.waitForTimeout(700);
  await expect(time).toHaveText(stopped);

  // Its end (2.0 s, as announced): its final time.
  await announce(page, id, "/app/quiet", false, start);
  await expect(row).not.toHaveAttribute("data-state", "running");
  await expect(row).toContainText("2.0 s");
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
  return { id, ["parent_id"]: parent, kind, name, start: at[0], duration: at[1], status: "ok", attrs };
}

async function storeCutView(): Promise<void> {
  // Cut a moment ago: its call is still waited for.
  const start = Date.now() * 1000 - 20_000_000;
  const trace = {
    id: CUT_VIEW,
    kind: "page",
    name: "/cut/view",
    start,
    duration: 15_000_000,
    status: "ok",
    attrs: { "service.name": "library-web", "page.trigger": "navigation" },
    spans: [
      span("r", null, "page", "/cut/view", [start, 15_000_000], {}),
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

/**
 * A "no answer" mark's words as they show: all of them on its line, none (wrapped onto the line not shown, the
 * hourglass alone), or cut by the mark's or its row name's edge.
 */
function shownWords(mark: Locator): Promise<"all" | "none" | "cut"> {
  return mark.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const words = element.querySelector(".dt-no-answer-text")?.getBoundingClientRect();
    const name = element.parentElement?.getBoundingClientRect();
    if (!(words && name)) return "cut";
    if (words.top >= box.bottom) return "none";
    return words.right <= Math.min(box.right, name.right) + 0.5 ? "all" : "cut";
  });
}

/** Whether the mark's hourglass shows whole, inside its row's name. */
function hourglassShown(mark: Locator): Promise<boolean> {
  return mark.evaluate((element) => {
    const icon = element.querySelector("svg")?.getBoundingClientRect();
    const name = element.parentElement?.getBoundingClientRect();
    return Boolean(icon && name && icon.width > 0 && icon.right <= name.right + 0.5 && icon.left >= name.left);
  });
}

test("a call with no answer yet says so in the call tree, its time neutral, and the tree says it is partial", async ({
  page,
}) => {
  await storeCutView();
  await page.goto(`/#/t/${CUT_VIEW}?tab=tree`);

  const row = page.locator('.dt-map-row[data-kind="http.client"]').filter({ hasText: "/graphql" });
  await expect(row.locator('[data-state="cut"]')).toHaveText("no answer yet");
  // Room enough: its words all shown.
  await laidOut(page);
  expect(await shownWords(row.locator('[data-state="cut"]'))).toBe("all");
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

// A request beside the cut view, its route as long as the narrow list holds whole: cut short if the time column took
// the room of "no answer" too.
const ROUTE = "/api/book/{id}/posts";
const REQUEST = "01M4C0TA0N6000000000000002";

async function storeRequest(): Promise<void> {
  const start = Date.now() * 1000 - 10_000_000;
  const attrs = { "service.name": "library-api", "http.method": "GET", "http.route": ROUTE };
  const trace = {
    id: REQUEST,
    kind: "http",
    name: `GET ${ROUTE}`,
    start,
    duration: 5_000,
    status: "ok",
    attrs: { ...attrs, "http.status_code": 200 },
    spans: [span("r", null, "http", `GET ${ROUTE}`, [start, 5_000], attrs)],
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
  await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${REQUEST}`)).status).toBe(200);
}

for (const dock of ["right", "bottom"] as const) {
  test(`docked ${dock}, a cut row says "no answer" by its name: the time column stays a time's width, no name cut by it`, async ({
    page,
  }) => {
    await storeCutView();
    await storeRequest();
    // At the right, as narrow as the panel goes; at the bottom, the list beside the trace is narrow already.
    await page.addInitScript((side) => {
      sessionStorage.setItem("tracepanel:panel", JSON.stringify({ open: true, dock: side, width: 360 }));
    }, dock);
    await openApp(
      page,
      { posts: { status: 200, trace: REQUEST, queries: 3, totalMs: 5, issues: 0 } },
      { recording: true, view: CUT_VIEW },
    );
    // A click on the cut view's page: its request listed with it, so the dock lists the page's rows.
    await page.getByRole("button", { name: "Do posts" }).click();
    const rows = panel(page).locator(".page-requests");
    const cut = rows.locator('.dt-request-row[data-kind="page"]').filter({ hasText: "/cut/view" });
    const request = rows.locator(".dt-request-row").filter({ hasText: "/posts" });
    const time = (row: typeof cut) => row.locator(".dt-request-meta > :nth-child(2)");

    await expect(cut.locator('.dt-request-main > [data-state="cut"]')).toHaveText("no answer");
    await expect(time(cut)).toHaveText("15.0 s");
    await expect(time(request)).toHaveText("5 ms");

    // The time column as wide as "15.0 s", not as the mark: the names keep the rest, whole.
    await laidOut(page);
    // The list's columns: name, status, time, queries, findings.
    const column = await rows
      .locator(".dt-requests")
      .evaluate((grid) => Number.parseFloat(getComputedStyle(grid).gridTemplateColumns.split(" ")[2] ?? ""));
    const text = await time(cut).evaluate((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return range.getBoundingClientRect().width;
    });
    expect(column).toBeLessThanOrEqual(text + 1);
    // Its words whole or not at all, never cut mid-way.
    expect(await shownWords(cut.locator('[data-state="cut"]'))).not.toBe("cut");
    for (const row of [cut, request]) {
      const clipped = await row
        .locator(".dt-request-path")
        .evaluate((name) => [name, ...name.querySelectorAll("*")].some((part) => part.scrollWidth > part.clientWidth));
      expect(clipped).toBe(false);
    }
  });
}

test('docked at the right, as narrow as it goes, the call tree\'s "no answer yet" gives way to the hourglass, its words never cut', async ({
  page,
}) => {
  await storeCutView();
  await page.addInitScript(() => {
    sessionStorage.setItem("tracepanel:panel", JSON.stringify({ open: true, dock: "right", width: 360 }));
  });
  await openApp(page, {}, { recording: true, view: CUT_VIEW });
  const frame = panel(page);
  // The view opens on its call tree.
  await expect(frame.getByRole("tab", { name: /^Call tree/ })).toHaveAttribute("aria-selected", "true");
  const row = frame.locator('.dt-map-row[data-kind="http.client"]').filter({ hasText: "/graphql" });
  const mark = row.locator('[data-state="cut"]');
  await expect(mark).toHaveText("no answer yet");
  await expect(mark).toHaveAttribute("title", /.+/);

  // No room for the words beside the call's name: they go, all of them, and the hourglass stays whole.
  await laidOut(page);
  expect(await shownWords(mark)).toBe("none");
  expect(await hourglassShown(mark)).toBe(true);
  // The words' room is the call's name's: the mark as wide as the hourglass.
  expect(await mark.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(12.5);
});
