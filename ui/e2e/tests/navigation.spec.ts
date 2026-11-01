// Navigation, as NAVIGATION.md states it: Back returns to exactly where you were (the trace, its tab, its row, its
// rows folded, its sub-views, its scroll), a linked trace opens where the click promises, a trace opened fresh opens
// on one rule in the panel and the console, and the console's address holds the view so a reload or the browser's
// Back and Forward bring it back.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { openApp, panel, pill, traceId } from "../app.ts";
import { chain, chainTrace } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

type Scope = Page | FrameLocator;
type Doc = Record<string, unknown>;

/** A trace of the ladder: a ULID of this test's own. */
const rung = (n: number) => `01M4NAV${String(n).padStart(19, "0")}`;

/** One request of the ladder: its root span, and its call to the next one, which that one's trace answers. */
function step(n: number, name: string, app: string, start: number, calls: string | null, parent: string | null): Doc {
  const id = rung(n);
  const attrs: Doc = {
    "service.name": app,
    "w3c.trace_id": "6e61766967617465000000000000ab01",
    "http.method": name.split(" ")[0],
    "http.route": name.split(" ")[1],
  };
  if (parent) attrs["w3c.parent_span_id"] = parent;
  // biome-ignore-start lint/style/useNamingConvention: the trace format.
  const root = { id: `${id}R`, parent_id: null, kind: "http", name, start, duration: 9_000, status: "ok", attrs: {} };
  const call = calls
    ? [
        {
          id: `${id}C`,
          parent_id: `${id}R`,
          kind: "http.client",
          name: calls,
          start: start + 1_000,
          duration: 7_000,
          status: "ok",
          attrs: { "w3c.span_id": `a00000000000000${n}` },
        },
      ]
    : [];
  // biome-ignore-end lint/style/useNamingConvention: the trace format.
  return {
    id,
    kind: "http",
    name,
    start,
    duration: 9_000,
    status: "ok",
    attrs,
    spans: [root, ...call],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
}

/**
 * Three requests, each calling the next: the browser's page, a BFF (profiled) and a service, stored by the agent,
 * which links each call to the trace that served it.
 */
async function ladder(): Promise<void> {
  const start = Date.now() * 1000 - 5 * 3_600_000_000;
  const bff = step(2, "POST /step", "ladder-bff", start + 1_200, "GET /leaf", "a000000000000001");
  // biome-ignore-start lint/style/useNamingConvention: the trace format.
  bff["profile"] = {
    interval_us: 1_000,
    samples: 1,
    frames: [{ function: "step", file: "s.js", line: 1, in_app: true }],
    stacks: [{ frames: [0], count: 1 }],
  };
  // biome-ignore-end lint/style/useNamingConvention: the trace format.
  const traces = [
    step(1, "GET /ladder", "ladder-web", start, "POST /step", null),
    bff,
    step(3, "GET /leaf", "ladder-api", start + 2_400, null, "a000000000000002"),
  ];
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(traces),
  });
  expect(response.status).toBe(202);
  await expect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${rung(1)}/chain`)).json()) as Doc)["traces"])
    .toHaveLength(3);
}

function tab(scope: Scope, name: RegExp): Locator {
  return scope.getByRole("tablist", { name: "Trace details" }).getByRole("tab", { name });
}

function opened(scope: Scope): Locator {
  return scope.getByRole("tablist", { name: "Trace details" }).getByRole("tab", { selected: true });
}

/** The row of a call merged with the trace it served, by its method and path. */
function hop(scope: Scope, call: string): Locator {
  const text = call.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return scope.getByRole("button", { name: new RegExp(`^http\\.client ${text} served by`, "i") });
}

/** The call tree's selected row. */
function selectedRow(scope: Scope): Locator {
  return scope.locator('.dt-map-rows [aria-current="true"]');
}

/** The browser's view, open in the panel on its call tree: its call to the BFF, which called the service. */
async function viewInPanel(page: Page): Promise<FrameLocator> {
  await chain();
  // Short: the call tree scrolls in the panel.
  await page.setViewportSize({ width: 1280, height: 640 });
  await openApp(page, { shelf: { status: 200, trace: chainTrace("view"), queries: 0, totalMs: 10 } });
  await page.getByRole("button", { name: "Load shelf" }).click();
  await pill(page).click();
  const frame = panel(page);
  await tab(frame, /^Call tree/).click();
  return frame;
}

/** The panel's trace pane, scrolled to its end; how far that is. */
async function scrollToEnd(page: Page): Promise<number> {
  const pane = page.frameLocator("iframe").locator(".panel-body");
  return pane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
}

async function scrolled(page: Page): Promise<number> {
  return page
    .frameLocator("iframe")
    .locator(".panel-body")
    .evaluate((element) => element.scrollTop);
}

test("in the panel, Back from a linked trace returns to the call tree, its row selected, scrolled as it was", async ({
  page,
}) => {
  const frame = await viewInPanel(page);
  // Every log record shown (the Logs chip), a row selected, a row folded, scrolled down.
  await frame.getByRole("button", { name: "1 log", exact: true }).click();
  await expect(frame.locator(".dt-map-rows")).toContainText("view loading");
  await hop(frame, "POST /graphql").click();
  // A row folded: Back brings the tree back as it was.
  await hop(frame, "POST /graphql").locator("[data-toggle]").click();
  const folded = await frame.locator('.dt-map-rows [aria-expanded="false"]').count();
  const scroll = await scrollToEnd(page);
  expect(scroll).toBeGreaterThan(0);
  await frame.getByRole("link", { name: "Open the trace it served →" }).click();

  // The click was on a row of the call tree: the linked trace opens on its call tree, its root row selected.
  await expect(opened(frame)).toHaveText(/^Call tree/);
  await expect(selectedRow(frame)).toContainText("POST /graphql");
  const back = frame.getByRole("button", { name: /^Back to Call tree · / });
  // Explicit: it names the tab and the trace it returns to.
  await expect(back).toHaveAccessibleName("Back to Call tree · GET /shelf");
  await expect(back).toContainText("Call tree");
  await expect(back).toContainText("/shelf");

  await back.click();

  await expect(back).toBeHidden();
  await expect(opened(frame)).toHaveText(/^Call tree/);
  await expect(hop(frame, "POST /graphql")).toHaveAttribute("aria-current", "true");
  await expect(frame.locator('.dt-map-rows [aria-expanded="false"]')).toHaveCount(folded);
  await expect(frame.locator(".dt-map-rows")).toContainText("view loading");
  await expect.poll(() => scrolled(page)).toBe(scroll);
});

test("in the panel, Back walks a chain of linked traces back one at a time, Esc the same, then closes", async ({
  page,
}) => {
  await ladder();
  await openApp(page, { ladder: { status: 200, trace: rung(1), queries: 0, totalMs: 9 } });
  await page.getByRole("button", { name: "Load ladder" }).click();
  await pill(page).click();
  const frame = panel(page);
  await tab(frame, /^Call tree/).click();
  await hop(frame, "POST /step").click();
  await frame.getByRole("link", { name: "Open the trace it served →" }).click();
  await expect(selectedRow(frame)).toContainText("POST /step");
  // On the BFF: All frames on its Profile, then its call to the service.
  await tab(frame, /^Profile/).click();
  await frame.getByRole("tablist", { name: "Frames shown" }).getByRole("tab", { name: "All frames" }).click();
  await tab(frame, /^Call tree/).click();
  await hop(frame, "GET /leaf").click();
  await frame.getByRole("link", { name: "Open the trace it served →" }).click();

  await expect(selectedRow(frame)).toContainText("GET /leaf");
  await expect(frame.getByRole("button", { name: /^Back to / })).toHaveAccessibleName("Back to Call tree · POST /step");

  await frame.getByRole("button", { name: /^Back to / }).click();

  await expect(opened(frame)).toHaveText(/^Call tree/);
  await expect(hop(frame, "GET /leaf")).toHaveAttribute("aria-current", "true");
  await expect(frame.getByRole("button", { name: /^Back to / })).toHaveAccessibleName(
    "Back to Call tree · GET /ladder",
  );
  await tab(frame, /^Profile/).click();
  // What the Profile tab showed is still what it shows.
  await expect(
    frame.getByRole("tablist", { name: "Frames shown" }).getByRole("tab", { name: "All frames" }),
  ).toHaveAttribute("aria-selected", "true");
  await tab(frame, /^Call tree/).click();

  await page.locator("iframe").focus();
  await frame.locator("body").press("Escape");

  await expect(hop(frame, "POST /step")).toHaveAttribute("aria-current", "true");
  await expect(frame.getByRole("button", { name: /^Back to / })).toBeHidden();

  await frame.locator("body").press("Escape");

  await expect(page.locator("iframe")).toBeHidden();
});

test("in the panel, the flame of a call lands on that trace's Profile, and Back on the call tree it left", async ({
  page,
}) => {
  const frame = await viewInPanel(page);
  await hop(frame, "POST /graphql").click();

  await hop(frame, "POST /graphql").locator(".dt-map-flame").click();

  await expect(opened(frame)).toHaveText(/^Profile/);
  await expect(frame.getByRole("button", { name: /^Back to / })).toHaveAccessibleName("Back to Call tree · GET /shelf");

  await frame.getByRole("button", { name: /^Back to / }).click();

  await expect(opened(frame)).toHaveText(/^Call tree/);
  await expect(hop(frame, "POST /graphql")).toHaveAttribute("aria-current", "true");
});

test("a trace picked in the panel's list opens on the tab last picked, never on Profile picked last", async ({
  page,
}) => {
  await chain();
  await openApp(page, {
    graphql: { status: 200, trace: chainTrace("bff"), queries: 0, totalMs: 8 },
    reports: { status: 202, trace: await traceId("POST /api/reports/sales"), queries: 0, totalMs: 12 },
  });
  await page.getByRole("button", { name: "Load graphql" }).click();
  await page.getByRole("button", { name: "Load reports" }).click();
  await pill(page).click();
  const frame = panel(page);
  const list = frame.getByRole("region", { name: "Pages and requests in this browser tab" });
  await list.getByRole("button", { name: /^POST \/graphql, / }).click();
  await tab(frame, /^Call tree/).click();
  await tab(frame, /^Profile/).click();

  await list.getByRole("button", { name: /^POST \/api\/reports\/sales, 202, / }).click();

  await expect(opened(frame)).toHaveText(/^Call tree/);
});

test("the lists name each row in one line: its method and whole path, its status, its time", async ({ page }) => {
  await openApp(page, {
    reports: { status: 202, trace: await traceId("POST /api/reports/sales"), queries: 0, totalMs: 12 },
  });
  await page.getByRole("button", { name: "Load reports" }).click();
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });

  await expect(list.getByRole("button", { name: /^POST \/api\/reports\/sales, 202, [\d.]+ m?s/ })).toBeVisible();

  await page.goto("/#/traces?q=status:200");
  const rows = page.getByRole("main").getByRole("table").getByRole("link");

  await expect(rows.first()).toHaveAccessibleName(/^(GET|POST|PUT|PATCH|DELETE|GraphQL) \S.*, 200, [\d.]+ m?s/);
});

test("in the console, a linked trace's way back is the trace as it was: crumbs, Esc, the browser's Back and Forward", async ({
  page,
}) => {
  await chain();
  await page.goto(`/#/traces?q=${encodeURIComponent("status:200")}`);
  await page.goto(`/#/t/${chainTrace("view")}?tab=tree`);
  await hop(page, "POST /graphql").click();

  // The row selected is in the address.
  await expect(page).toHaveURL(/[?&]span=/);

  await page.getByRole("link", { name: "Open the trace it served →" }).click();

  await expect(page).toHaveURL(new RegExp(`#/t/${chainTrace("bff")}\\?`));
  await expect(opened(page)).toHaveText(/^Call tree/);
  // The crumbs say the way it came: the view's trace, then this one.
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link", { name: "GET /shelf" })).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page).toHaveURL(new RegExp(`#/t/${chainTrace("view")}\\?`));
  await expect(hop(page, "POST /graphql")).toHaveAttribute("aria-current", "true");

  // Esc went Back as the browser does: Forward is the linked trace again.
  await page.goForward();

  await expect(page).toHaveURL(new RegExp(`#/t/${chainTrace("bff")}\\?`));

  await page.goBack();

  await expect(opened(page)).toHaveText(/^Call tree/);
  await expect(hop(page, "POST /graphql")).toHaveAttribute("aria-current", "true");
});

test("in the console, a reload opens the same view: its tab, its row, the Profile tab's frames", async ({ page }) => {
  await chain();
  await page.goto(`/#/t/${chainTrace("bff")}`);
  await tab(page, /^Profile/).click();
  await page.getByRole("tablist", { name: "Frames shown" }).getByRole("tab", { name: "All frames" }).click();

  await expect(page).toHaveURL(/[?&]tab=profile/);
  await expect(page).toHaveURL(/[?&]frames=all/);

  await page.reload();

  await expect(opened(page)).toHaveText(/^Profile/);
  await expect(
    page.getByRole("tablist", { name: "Frames shown" }).getByRole("tab", { name: "All frames" }),
  ).toHaveAttribute("aria-selected", "true");

  await tab(page, /^Call tree/).click();
  const steps = page.getByRole("button", { name: /^function Book\.author ×3/ });
  await steps.click();
  await page.reload();

  await expect(opened(page)).toHaveText(/^Call tree/);
  await expect(steps).toHaveAttribute("aria-current", "true");
});
