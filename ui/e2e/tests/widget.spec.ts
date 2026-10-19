// The widget on an app's page: the pill's states, the panel it opens, and the tab's list.
import { CONSOLE } from "../agent.ts";
import { type Call, OTHER_API, openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

async function posts(): Promise<Call> {
  return { status: 200, trace: await traceId("GET /api/posts"), queries: 14, totalMs: 5, issues: 1 };
}

async function broken(): Promise<Call> {
  return { status: 500, trace: await traceId("GET /api/error"), queries: 0, totalMs: 11 };
}

test("the pill waits for the page's first request, then shows it, its framework learned from its trace", async ({
  page,
}) => {
  await openApp(page, { posts: await posts() });

  await expect(pill(page)).toHaveAccessibleName("tracepanel: no requests yet");
  await expect(pill(page)).toContainText("Waiting for requests");

  await page.getByRole("button", { name: "Load posts" }).click();

  await expect(pill(page)).toContainText("GET /app/api/posts");
  await expect(pill(page)).toContainText("200");
  await expect(pill(page)).toContainText("1 issue");
  await expect(pill(page)).toContainText("FastAPI");
});

test("a server page's own load heads the pill, with the framework its server named", async ({ page }) => {
  const trace = await traceId("GET /");
  await openApp(
    page,
    {},
    { server: { status: 200, trace, queries: 154, totalMs: 27, issues: 3, runtime: "Python 3.11 · Django 5.2" } },
  );

  await expect(pill(page)).toContainText("GET /app/");
  await expect(pill(page)).toContainText("154");
  await expect(pill(page)).toContainText("Django");
});

test("a failed call turns the pill red; once another follows, it is counted", async ({ page }) => {
  await openApp(page, { posts: await posts(), boom: await broken() });
  await page.getByRole("button", { name: "Load boom" }).click();

  await expect(pill(page)).toContainText("500");
  await expect(pill(page)).toHaveAttribute("data-verdict", "error");

  await page.getByRole("button", { name: "Load posts" }).click();

  await expect(pill(page)).toContainText("GET /app/api/posts");
  await expect(pill(page)).toContainText("1 failed");
  await expect(pill(page)).toHaveAttribute("data-verdict", "error");
});

test("on a page that isn't UTF-8, the widget's text still reads right", async ({ page }) => {
  await openApp(page, { posts: await posts() }, { charset: "windows-1252" });
  await page.getByRole("button", { name: "Load posts" }).click();

  await expect(pill(page)).toHaveAccessibleName(/GET \/app\/api\/posts → 200 · 5 ms/);
});

test("once the agent stored the request, the pill shows its time as the panel does", async ({ page }) => {
  const call = { ...(await posts()), totalMs: 0.4, issues: "pending" as const };
  const stored = (await (await fetch(`${CONSOLE}api/traces/${call.trace}`)).json()) as { duration: number };
  await openApp(page, { posts: call });
  await page.getByRole("button", { name: "Load posts" }).click();

  await expect(pill(page)).toHaveAccessibleName(new RegExp(` · ${Math.round(stored.duration / 1000)} ms · `));
});

test("the panel opens on the latest request's trace, from the agent", async ({ page }) => {
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();

  await expect(panel(page).getByRole("region", { name: "Pages and requests in this browser tab" })).toContainText(
    /GET\s*\/api\/posts/,
  );
  await expect(panel(page).getByRole("tab", { name: "Call tree" })).toHaveAttribute("aria-selected", "true");
  // The tab's narrow list marks the request's findings by their number, their names in the title.
  const findings = panel(page).locator(".dt-chip-compact");
  await expect(findings).toHaveText("1");
  await expect(findings).toHaveAttribute("title", "N+1");
  await expect(panel(page).getByRole("button", { name: /SELECT author .*×13 N\+1/ })).toBeVisible();
});

test("Clear empties the tab's list; Esc hides the panel", async ({ page }) => {
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  await panel(page)
    .getByRole("button", { name: /^Clear/ })
    .click();
  const confirm = panel(page).getByRole("dialog", { name: "Clear requests" });

  // The list only: deleting the store too would take the other tests' traces.
  await expect(confirm.getByRole("checkbox")).not.toBeChecked();

  await confirm.getByRole("button", { name: "Clear", exact: true }).click();

  await expect(confirm).toBeHidden();
  await expect(panel(page).getByText("No requests yet")).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page.locator("iframe")).toBeHidden();
});

test("the panel docks to the right, and stays there after a reload", async ({ page }) => {
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  await panel(page).getByRole("button", { name: "Dock to right" }).click();

  await expect(panel(page).getByRole("button", { name: /Dock to bottom/ })).toBeVisible();

  await page.reload();

  await expect(page.locator("iframe")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /Dock to bottom/ })).toBeVisible();
});

test("with the browser recording, the pill shows the page's view, and the panel each action over its requests", async ({
  page,
}) => {
  await openApp(page, { posts: await posts(), boom: await broken() }, { recording: true });

  await expect(pill(page)).toContainText("VIEW /app/");

  await page.getByRole("button", { name: "Do posts" }).click();
  await page.getByRole("button", { name: "Do boom" }).click();
  await pill(page).click();
  const rows = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button");

  await expect(rows).toHaveText([
    /^VIEW\s*\/app\//,
    /^CLICK\s*"posts"/,
    /^GET\s*\/api\/posts/,
    /^CLICK\s*"boom"/,
    /^GET\s*\/api\/error/,
  ]);
});

test("calls to an API on another origin sit under the action that made them, with a recording started after the widget", async ({
  page,
}) => {
  await openApp(page, { posts: await posts(), boom: await broken() }, { recording: "after widget", api: OTHER_API });

  await page.getByRole("button", { name: "Do posts" }).click();
  await page.getByRole("button", { name: "Do boom" }).click();
  await pill(page).click();
  const rows = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button");

  await expect(rows).toHaveText([
    /^VIEW\s*\/app\//,
    /^CLICK\s*"posts"/,
    /^GET\s*\/api\/posts/,
    /^CLICK\s*"boom"/,
    /^GET\s*\/api\/error/,
  ]);
  await expect
    .poll(() => rows.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-depth"))))
    .toEqual(["0", "0", "1", "0", "1"]);
});

test("Follow new stays on the action a request belongs to, once the action is stored", async ({ page }) => {
  // The agent as it answers once the recording sent the actions: each one the widget lists is stored too.
  await page.route("**/api/traces?*", async (route) => {
    const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",") ?? [];
    const answer = await (await route.fetch()).json();
    const [template] = answer.traces;
    const known = new Set(answer.traces.map((trace: { id: string }) => trace.id));
    const pages = template
      ? ids
          .filter((id) => !known.has(id))
          .map((id) => ({ ...template, id, kind: "page", name: '/app/ › click "posts"' }))
      : [];
    await route.fulfill({ json: { ...answer, traces: [...answer.traces, ...pages] } });
  });
  await openApp(page, { posts: await posts(), boom: await broken() }, { recording: true });
  await pill(page).click();
  const rows = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button");
  await expect(rows.first()).toBeVisible();

  await page.getByRole("button", { name: "Do posts" }).click();

  // The view, the click, its request: the click stays open, not the request under it.
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(2)).not.toHaveAttribute("aria-current", "true");
});

test("with requests from more than one app, each row of the tab's list names its app", async ({ page }) => {
  const books: Call = { status: 200, trace: await traceId("GET /books"), queries: 21, totalMs: 2 };
  await openApp(page, { posts: await posts(), books });

  await page.getByRole("button", { name: "Load posts" }).click();
  await page.getByRole("button", { name: "Load books" }).click();
  await pill(page).click();
  const rows = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button");

  await expect(rows.filter({ hasText: "/api/posts" }).locator(".dt-app-chip")).toHaveText("shop-api");
  await expect(rows.filter({ hasText: /GET\s*\/books/ }).locator(".dt-app-chip")).toHaveText("api");
});

test("with requests from one app only, the rows name no app", async ({ page }) => {
  await openApp(page, { posts: await posts(), boom: await broken() });

  await page.getByRole("button", { name: "Load posts" }).click();
  await page.getByRole("button", { name: "Load boom" }).click();
  await pill(page).click();
  const rows = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button");

  await expect(rows).toHaveCount(2);
  await expect(rows.locator(".dt-app-chip")).toHaveCount(0);
});
