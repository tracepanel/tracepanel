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
    const words = element.querySelector(".tp-no-answer-text")?.getBoundingClientRect();
    const name = element.closest(".tp-map-name")?.getBoundingClientRect();
    if (!(words && name)) return "cut";
    if (words.top >= box.bottom) return "none";
    return words.right <= Math.min(box.right, name.right) + 0.5 ? "all" : "cut";
  });
}

test("a call with no answer yet says so in the call tree, its time neutral, and the tree says it is partial", async ({
  page,
}) => {
  await storeCutView();
  await page.goto(`/#/t/${CUT_VIEW}?tab=tree`);

  const row = page.locator('.tp-map-row[data-kind="http.client"]').filter({ hasText: "/graphql" });
  await expect(row.locator('[data-state="cut"]')).toHaveText("no answer yet");
  // Room enough: its words all shown.
  await laidOut(page);
  expect(await shownWords(row.locator('[data-state="cut"]'))).toBe("all");
  await expect(row.locator(".tp-map-time")).toHaveText("15.0 s");
  await expect(page.locator(".tp-on-its-way")).toHaveText(
    "1 call with no answer yet: the tree fills in if its trace arrives",
  );
});
