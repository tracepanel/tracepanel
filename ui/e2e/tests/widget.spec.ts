// The widget on an app's page: the pill's states, the panel it opens, and the tab's list.
import { readFileSync } from "node:fs";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import {
  type Call,
  chooseTheme,
  OTHER_API,
  openApp,
  panel,
  panelList,
  panelRows,
  pill,
  records,
  traceId,
} from "../app.ts";
import { expect, test } from "../fixtures.ts";

async function posts(): Promise<Call> {
  return { status: 200, trace: await traceId("GET /api/posts"), queries: 14, totalMs: 5, issues: 1 };
}

async function broken(): Promise<Call> {
  return { status: 500, trace: await traceId("GET /api/error"), queries: 0, totalMs: 11 };
}

/**
 * The app profiles on request; `memory`: what the code allocated too. `all`, `memoryAll`: its settings profile every
 * request (`profile`), and memory with every profile (`profile_memory`).
 */
async function profiles(
  page: Page,
  {
    memory,
    all = false,
    memoryAll = false,
    profile = true,
  }: { memory: boolean; all?: boolean; memoryAll?: boolean; profile?: boolean },
): Promise<void> {
  const json = {
    explain: false,
    users: false,
    profile,
    // biome-ignore lint/style/useNamingConvention: wire format.
    profile_memory: memory,
    // biome-ignore lint/style/useNamingConvention: wire format.
    profile_all: all,
    // biome-ignore lint/style/useNamingConvention: wire format.
    profile_memory_all: memoryAll,
    request: true,
  };
  await page.route("**/api/capabilities", (route) => route.fulfill({ json }));
}

/** The hint `control` opens on hover: the pointer leaves first, as a hint opens again only once it comes back. */
async function expectHint(page: Page, control: Locator, text: string): Promise<void> {
  await expect(async () => {
    await page.mouse.move(0, 0);
    await control.hover();
    await expect(panel(page).getByRole("tooltip")).toContainText(text, { timeout: 1000 });
  }).toPass();
}

async function profileCookie(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name === "tracepanel_profile")?.value;
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
  // Its mark as the console draws it: Django's monogram, its letters drawn by CSS, not text of the pill.
  await expect(pill(page).locator('[data-mark="monogram"]')).toHaveAttribute("data-letters", "Dj");
  await expect(pill(page).locator('[data-mark="monogram"]')).toHaveText("");
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

  await expect(pill(page)).toHaveAccessibleName(/GET \/app\/api\/posts → 200 · [\d.]+ ms/);
});

test("once the agent stored the request, the pill shows its time as the panel does", async ({ page }) => {
  const call = { ...(await posts()), totalMs: 0.4, issues: "pending" as const };
  await openApp(page, { posts: call });
  await page.getByRole("button", { name: "Load posts" }).click();
  // Its issues come from the agent: the request is stored by then.
  await expect(pill(page)).toHaveAccessibleName(/1 issue/);
  await pill(page).click();
  const row = records(page).filter({ hasText: "/api/posts" });
  const time = await row.locator(".tp-map-time").innerText();

  // The time the page waited for it, the same in both: never the header's 0.4 ms.
  expect(time).toMatch(/^[\d.]+ ms$/);
  expect(time).not.toBe("0.4 ms");
  await expect(pill(page)).toHaveAccessibleName(new RegExp(` · ${time.replace(".", "\\.")} · `));
});

test("a request under a millisecond says so on the pill and in its hover card, as the panel's list does", async ({
  page,
}) => {
  // The page's own load, its server's time under a millisecond (the page didn't time it: its server did).
  const quick = { ...(await posts()), totalMs: 0.3, issues: 0, runtime: "Go 1.27.1 · net/http" };
  await openApp(page, {}, { server: quick });

  await expect(pill(page)).toHaveAccessibleName(/ · 0\.3 ms · /);
  await expect(pill(page)).toContainText(/0\.3\s*ms/);

  await pill(page).hover();
  const card = page.getByRole("dialog", { name: "This request at a glance" });

  await expect(card.locator(".card-head .card-time")).toHaveText("0.3 ms");
  await expect(card).not.toContainText(/\b0 ms/);
});

test("the panel opens on the latest request's trace, from the agent", async ({ page }) => {
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();

  // Open, as its call tree: the request first, its findings marked by their number, down to the repeated query.
  await expect(records(page).first()).toHaveText(/GET\s*\/api\/posts/);
  await expect(records(page).first()).toHaveAttribute("aria-expanded", "true");
  await expect(records(page).first().locator(".tp-record-issues")).toHaveText("1");
  await expect(
    panelList(page)
      .getByRole("button", { name: /SELECT author ×13/ })
      .locator('[data-issue-kind="n+1"]'),
  ).toHaveText("1");
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
  const actions = records(page).filter({ hasText: /^(view|click)/i });

  // The view and each action a record, the newest first; one opened, its requests under it.
  await expect(actions).toHaveText([/^click\s*"boom"/i, /^click\s*"posts"/i, /^view\s*\/app\//i]);

  await actions.filter({ hasText: '"posts"' }).click();

  await expect(panelRows(page)).toHaveText([
    /^click\s*"boom"/i,
    /^click\s*"posts"/i,
    /^req\s*GET\s*\/api\/posts/i,
    /^view\s*\/app\//i,
  ]);
});

test("a server-rendered page's own request sits under the view that loaded it, one row for one load", async ({
  page,
}) => {
  const home = await traceId("GET /");
  await openApp(
    page,
    { posts: await posts() },
    {
      recording: true,
      server: { status: 200, trace: home, queries: 1, totalMs: 12, runtime: "Node.js 26 · Next.js 16" },
    },
  );
  await page.getByRole("button", { name: "Do posts" }).click();
  await pill(page).click();
  const actions = records(page).filter({ hasText: /^(view|click)/i });

  // One record for one load: the page's own request is under its view, not a record of its own.
  await expect(actions).toHaveText([/^click\s*"posts"/i, /^view\s*\/app\//i]);
  await expect(records(page).filter({ hasText: /GET\s*\/blog/ })).toHaveCount(0);

  await actions.filter({ hasText: /^view/i }).click();

  await expect(panelRows(page)).toHaveText([/^click\s*"posts"/i, /^view\s*\/app\//i, /^req\s*GET\s*\//i]);
});

test("calls to an API on another origin sit under the action that made them, with a recording started after the widget", async ({
  page,
}) => {
  await openApp(page, { posts: await posts(), boom: await broken() }, { recording: "after widget", api: OTHER_API });

  await page.getByRole("button", { name: "Do posts" }).click();
  await page.getByRole("button", { name: "Do boom" }).click();
  await pill(page).click();
  const actions = records(page).filter({ hasText: /^(view|click)/i });

  await expect(actions).toHaveText([/^click\s*"boom"/i, /^click\s*"posts"/i, /^view\s*\/app\//i]);

  await actions.filter({ hasText: '"posts"' }).click();

  // The other origin's request under the action that made it, not under the view.
  await expect(panelRows(page)).toHaveText([
    /^click\s*"boom"/i,
    /^click\s*"posts"/i,
    /^req\s*GET\s*\/api\/posts/i,
    /^view\s*\/app\//i,
  ]);
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
    // Counted as any stored trace is.
    const counts =
      answer.counts && template ? Object.fromEntries(pages.map((each) => [each.id, answer.counts[template.id]])) : {};
    await route.fulfill({
      json: { ...answer, traces: [...answer.traces, ...pages], counts: { ...answer.counts, ...counts } },
    });
  });
  await openApp(page, { posts: await posts(), boom: await broken() }, { recording: true });
  await pill(page).click();
  await expect(records(page).first()).toBeVisible();

  await page.getByRole("button", { name: "Do posts" }).click();

  // The click is the open record, not the request under it.
  await expect(records(page).first()).toHaveText(/^click\s*"posts"/i);
  await expect(records(page).first()).toHaveAttribute("aria-current", "true");
  await expect(records(page).filter({ hasText: /^req/i })).toHaveCount(0);
});

test("the rows name no app, from one app or more", async ({ page }) => {
  await openApp(page, { posts: await posts(), boom: await broken() });

  await page.getByRole("button", { name: "Load posts" }).click();
  await page.getByRole("button", { name: "Load boom" }).click();
  await pill(page).click();
  const rows = records(page);

  await expect(rows).toHaveCount(2);
  await expect(rows.locator(".tp-app-chip")).toHaveCount(0);
});

test("a form's POST that redirected heads the page it led to: the app names it in a cookie, read once", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "tracepanel_redirect", value: await traceId("POST /accounts/login/"), url: CONSOLE },
  ]);
  await openApp(
    page,
    {},
    {
      server: {
        status: 200,
        trace: await traceId("GET /"),
        queries: 154,
        totalMs: 27,
        runtime: "Python 3.11 · Django 5.2",
      },
    },
  );
  await pill(page).click();
  const rows = records(page);

  // The newest first: the page, then the POST that led to it.
  await expect(rows).toHaveText([/^req\s*GET\s*\//i, /POST\s*\/accounts\/login\/.*302/]);
  expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain("tracepanel_redirect");
});

test("docked at the bottom, the panel leaves room to scroll to the page's end, even where the root is as tall as the window", async ({
  page,
}) => {
  await openApp(page, { posts: await posts() });
  // As Django's admin: html, body and a wrapper the window's height, the content overflowing them.
  await page.evaluate(() => {
    document.documentElement.style.height = "100%";
    document.body.style.cssText = "height: 100%; margin: 0";
    const wrapper = document.createElement("div");
    wrapper.style.height = "100%";
    wrapper.innerHTML = '<div style="height: 3000px"></div><p id="end">The end</p>';
    document.body.prepend(wrapper);
  });
  await pill(page).click();
  await expect(page.locator("iframe")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const end = await page.locator("#end").boundingBox();
  const top = await page.locator("iframe").boundingBox();

  expect(end && top && end.y + end.height <= top.y).toBe(true);
});

test("Profile sits in the bar with Follow new and Clear: one button, Off and Time, when the app doesn't profile memory", async ({
  page,
  context,
}) => {
  await profiles(page, { memory: false });
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  const button = panel(page)
    .locator(".panel-top")
    .getByRole("button", { name: /^Profiling/ });

  await expect(button).toHaveCount(1);
  await expect(button).toHaveAccessibleName("Profiling off");
  expect(await profileCookie(context)).toBeUndefined();

  // A hint says the mode and what a click does.
  await expectHint(page, button, "Profiling off · click: profile time");

  await button.click();

  await expect(button).toHaveAccessibleName("Profiling time");
  await expect(button.getByTestId("profile-memory-dot")).toHaveCount(0);
  expect(await profileCookie(context)).toBe("1");

  await expectHint(page, button, "Profiling time · click: off");

  await button.click();

  await expect(button).toHaveAccessibleName("Profiling off");
  expect(await profileCookie(context)).toBeUndefined();
});

test("Profile, when the app profiles memory, cycles Off, Time, Time and memory: the cookie says each, keys too", async ({
  page,
  context,
}) => {
  await profiles(page, { memory: true });
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  const button = panel(page).getByRole("button", { name: /^Profiling/ });

  await expect(button).toHaveAccessibleName("Profiling off");

  await button.click();

  await expect(button).toHaveAccessibleName("Profiling time");
  expect(await profileCookie(context)).toBe("1");

  await expectHint(page, button, "Profiling time · click: also memory (slower)");

  await button.click();

  await expect(button).toHaveAccessibleName("Profiling time and memory");
  await expect(button.getByTestId("profile-memory-dot")).toBeVisible();
  expect(await profileCookie(context)).toBe("memory");

  await expectHint(page, button, "Profiling time and memory · click: off");

  await button.click();

  await expect(button).toHaveAccessibleName("Profiling off");
  expect(await profileCookie(context)).toBeUndefined();

  // Enter and Space cycle it as a click does, the focus stays, and the change is said aloud.
  await button.focus();
  await page.keyboard.press("Enter");

  await expect(button).toBeFocused();
  await expect(button).toHaveAccessibleName("Profiling time");
  expect(await profileCookie(context)).toBe("1");
  await expect(panel(page).locator("[aria-live=polite]").filter({ hasText: "Profiling time" })).toHaveCount(1);

  await page.keyboard.press("Space");

  await expect(button).toBeFocused();
  await expect(button).toHaveAccessibleName("Profiling time and memory");
  expect(await profileCookie(context)).toBe("memory");
});

test("Profile, when the app's settings profile every request, is lit with no cookie and offers memory on top only", async ({
  page,
  context,
}) => {
  await profiles(page, { memory: true, all: true });
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  const button = panel(page).getByRole("button", { name: /^Profiling/ });

  await expect(button).toHaveAccessibleName("Profiling time");
  await expect(button).toHaveClass(/text-orange-500/);
  await expect(button.getByTestId("profile-memory-dot")).toHaveCount(0);
  expect(await profileCookie(context)).toBeUndefined();

  await expectHint(page, button, "Profiling every request (the app's profile setting) · click: also memory (slower)");

  await button.click();

  await expect(button).toHaveAccessibleName("Profiling time and memory");
  await expect(button.getByTestId("profile-memory-dot")).toBeVisible();
  expect(await profileCookie(context)).toBe("memory");

  await expectHint(page, button, "Profiling time and memory · click: time only, as the app's setting");

  // Never off: back to what the settings profile, with no cookie.
  await button.click();

  await expect(button).toHaveAccessibleName("Profiling time");
  await expect(button).toHaveClass(/text-orange-500/);
  expect(await profileCookie(context)).toBeUndefined();
});

test("Profile, when the app's settings profile every request with memory, is lit with its dot and offers nothing", async ({
  page,
  context,
}) => {
  await profiles(page, { memory: true, all: true, memoryAll: true });
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  const button = panel(page).getByRole("button", { name: /^Profiling/ });

  await expect(button).toHaveAccessibleName("Profiling time and memory");
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).toHaveClass(/text-orange-500/);
  await expect(button.getByTestId("profile-memory-dot")).toBeVisible();

  await expectHint(
    page,
    button,
    "Profiling every request, time and memory (the app's profile and profile_memory settings)",
  );
  await expect(panel(page).getByRole("tooltip")).toContainText("To profile less, change the app's settings.");
  await expect(panel(page).getByRole("tooltip")).not.toContainText("click:");

  // Playwright waits for an aria-disabled button to be enabled: a person's click, forced.
  await button.click({ force: true });

  await expect(button).toHaveAccessibleName("Profiling time and memory");
  expect(await profileCookie(context)).toBeUndefined();
});

test("Profile, with no app here that profiles on request but the cookie set, shows what it asks and turns it off", async ({
  page,
  context,
}) => {
  // The cookie is the host's: a console on another port of it set it, and the page's calls still ask with it.
  await context.addCookies([{ name: "tracepanel_profile", value: "memory", domain: "127.0.0.1", path: "/" }]);
  await profiles(page, { memory: false, profile: false });
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  const button = panel(page).getByRole("button", { name: /^Profiling/ });

  await expect(button).toHaveAccessibleName("Profiling time and memory");
  await expect(button.getByTestId("profile-memory-dot")).toBeVisible();
  await expectHint(page, button, "Asking the apps this browser calls to profile time and memory");
  await expectHint(page, button, "· click: off");

  await button.click();

  // Off: no cookie, nothing asks; with no app here to profile, the button goes.
  expect(await profileCookie(context)).toBeUndefined();
  await expect(button).toHaveCount(0);
});

test("Profile, when the cookie asks for memory where the apps profile time only, says memory", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "tracepanel_profile", value: "memory", domain: "127.0.0.1", path: "/" }]);
  await profiles(page, { memory: false });
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  const button = panel(page).getByRole("button", { name: /^Profiling/ });

  await expect(button).toHaveAccessibleName("Profiling time and memory");

  await button.click();

  await expect(button).toHaveAccessibleName("Profiling off");
  expect(await profileCookie(context)).toBeUndefined();
});

for (const width of [640, 900, 1280]) {
  test(`docked at the bottom in a window ${width} px wide, the bar holds the user, Follow new, Profile and Clear, none over another`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route("**/api/capabilities", (route) =>
      // biome-ignore lint/style/useNamingConvention: wire format.
      route.fulfill({ json: { explain: false, users: true, profile: true, profile_memory: true, request: true } }),
    );
    await page.route("**/api/users/me", (route) =>
      route.fulfill({
        json: { user: { id: "7", username: "a-rather-long-username-for-a-toolbar", name: "", email: "" } },
      }),
    );
    await openApp(page, { posts: await posts() });
    await page.getByRole("button", { name: "Load posts" }).click();
    await pill(page).click();
    const bar = panel(page).locator(".panel-top");
    const user = bar.getByRole("button", { name: "Acting as a-rather-long-username-for-a-toolbar" });
    const controls = [
      bar.getByRole("button", { name: "Follow new" }),
      bar.getByRole("button", { name: /^Clear/ }),
      bar.getByRole("button", { name: /^Profiling/ }),
      user,
    ];

    await expect(user).toBeVisible();
    // The name is the hint's: the button stays its size.
    await expect(user).not.toContainText("a-rather-long");
    await expect(user.getByTestId("user-set-dot")).toBeVisible();

    const box = await bar.boundingBox();
    const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
    const overlap = (a: Box, b: Box) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

    expect(box && boxes.every((each) => each && each.x >= box.x && each.x + each.width <= box.x + box.width)).toBe(
      true,
    );
    expect(
      boxes.every((each, at) => boxes.every((other, to) => to === at || !each || !other || !overlap(each, other))),
    ).toBe(true);
    expect(await bar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await expectHint(page, user, "Acting as a-rather-long-username-for-a-toolbar · click to change");
  });
}

type Box = { x: number; y: number; width: number; height: number };

test("Console opens the request in the full console, and its hint says so", async ({ page }) => {
  const call = await posts();
  await openApp(page, { posts: call });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  const console = panel(page).getByRole("link", { name: /Console/ });

  await expect(console).toHaveAttribute("href", new RegExp(`#/t/${call.trace}`));
  await expect(console).toHaveAttribute("target", "_blank");

  await console.hover();

  await expect(panel(page).getByRole("tooltip")).toContainText("This request in the full console, in a new tab");
});

const STYLES = readFileSync(new URL("../../packages/ui/src/styles.css", import.meta.url), "utf8");

/** A colour token's value in styles.css, as the browser computes it: `rgb(r, g, b)`. */
function token(name: string, theme: "dark" | "light"): string {
  const block = `\n${theme === "dark" ? ":root" : ':root[data-theme="light"]'} {`;
  const start = STYLES.indexOf(block);
  const hex = new RegExp(`${name}: #([0-9a-f]{6});`).exec(STYLES.slice(start, STYLES.indexOf("}", start)))?.[1];
  if (!hex) throw new Error(`no ${name} in the ${theme} block`);
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

for (const theme of ["dark", "light"] as const) {
  test(`the pill takes its colours from the design tokens, ${theme}`, async ({ page }) => {
    await chooseTheme(page, theme);
    await openApp(page, { posts: await posts() });
    await page.getByRole("button", { name: "Load posts" }).click();
    const status = pill(page).locator(".status");

    await expect(pill(page)).toHaveCSS("background-color", token("--tp-float", theme));
    await expect(pill(page)).toHaveCSS("color", token("--tp-float-text", theme));
    await expect(status).toHaveText("200");
    await expect(status).toHaveCSS("color", token("--tp-ok", theme));
  });
}

test("with no theme chosen the pill is dark, even on a light system", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openApp(page, { posts: await posts() });

  await expect(page.locator("tracepanel-widget")).toHaveAttribute("data-theme", "dark");
  await expect(pill(page)).toHaveCSS("background-color", token("--tp-float", "dark"));
});

test("the widget's sources hold no colour of their own: its palette is the tokens'", () => {
  for (const file of ["index.ts", "card.ts"]) {
    const source = readFileSync(new URL(`../../packages/widget/src/${file}`, import.meta.url), "utf8");

    expect(source.match(/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/gi), file).toBeNull();
  }
});

test("the pill's hover card stands on the pill: its left and right edges are the pill's", async ({ page }) => {
  await openApp(page, { home: { status: 200, trace: await traceId("GET /"), queries: 151, totalMs: 28 } });
  await page.getByRole("button", { name: "Load home" }).click();
  await expect(pill(page)).toContainText("/app/api/home");
  await pill(page).hover();
  const card = page.getByRole("dialog", { name: "This request at a glance" });
  await expect(card).toBeVisible();
  const [box, under] = [await card.boundingBox(), await pill(page).boundingBox()];
  if (!(box && under)) throw new Error("no card");

  expect(Math.abs(box.x - under.x)).toBeLessThan(1.5);
  expect(Math.abs(box.x + box.width - (under.x + under.width))).toBeLessThan(1.5);
});

test("the hover card says where the time went as the strip's legend does: GC its own share, the same numbers", async ({
  page,
}) => {
  const id = await traceId("GET /reports/sales");
  await page.goto(`/#/t/${id}?tab=tree`);
  const legend = page.locator(".tp-breakdown-legend").first().locator("li").filter({ hasText: / ms/ });
  // "GC 12 ms" for "GC 12 ms 6%": each share's name and time, largest first.
  const shares = (await legend.allInnerTexts()).map((text) =>
    text
      .replace(/\s+/g, " ")
      .replace(/ \d+%$/, "")
      .trim(),
  );
  expect(shares.some((share) => share.startsWith("GC "))).toBe(true);
  const top = (await legend.first().innerText()).replace(/\s+/g, " ").trim();

  await openApp(page, { sales: { status: 200, trace: id, queries: 1, totalMs: 100 } });
  await page.getByRole("button", { name: "Load sales" }).click();
  await pill(page).hover();
  const card = page.getByRole("dialog", { name: "This request at a glance" });
  await expect(card.locator(".card-bar")).toBeVisible();
  const pieces = await card
    .locator(".card-bar span")
    .evaluateAll((spans) => spans.map((span) => (span as HTMLElement).title));

  expect([...pieces].sort()).toEqual([...shares].sort());
  // "Your code 30 ms 71%" in the legend: "Most time: Your code 30 ms" on the card, as the strip writes it, of the
  // server's time where the card's head says the browser's (100 ms, it waited longer). No percent: a time and its
  // percent are each rounded, one sentence can't say both.
  await expect(card.locator(".card-most")).toHaveText(`Most time: ${top.replace(/ \d+%$/, "")} of the server's 42 ms`);
});
