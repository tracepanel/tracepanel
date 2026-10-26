// The widget on an app's page: the pill's states, the panel it opens, and the tab's list.
import { readFileSync } from "node:fs";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { type Call, chooseTheme, OTHER_API, openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

async function posts(): Promise<Call> {
  return { status: 200, trace: await traceId("GET /api/posts"), queries: 14, totalMs: 5, issues: 1 };
}

async function broken(): Promise<Call> {
  return { status: 500, trace: await traceId("GET /api/error"), queries: 0, totalMs: 11 };
}

/** The app profiles on request; `memory`: what the code allocated too. */
async function profiles(page: Page, { memory }: { memory: boolean }): Promise<void> {
  await page.route("**/api/capabilities", (route) =>
    // biome-ignore lint/style/useNamingConvention: wire format.
    route.fulfill({ json: { explain: false, users: false, profile: true, profile_memory: memory, request: true } }),
  );
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
  await expect(panel(page).getByTitle("N+1", { exact: true })).toHaveText("1");
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
  const rows = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button");

  await expect(rows.nth(0)).toHaveText(/^POST\s*\/accounts\/login\/.*302/);
  await expect(rows.nth(1)).toHaveText(/^GET\s*\//);
  expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain("tracepanel_redirect");
});

test("in the panel, the Request tab heads with the request at a glance", async ({ page }) => {
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  await panel(page)
    .getByRole("tab", { name: /^Request/ })
    .click();

  await expect(panel(page).locator(".dt-tabpanel header")).toContainText(/GET\s*\/api\/posts\s*200/);
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

test("Profile sits with Follow new and Clear: one button, Off and Time, when the app doesn't profile memory", async ({
  page,
  context,
}) => {
  await profiles(page, { memory: false });
  await openApp(page, { posts: await posts() });
  await page.getByRole("button", { name: "Load posts" }).click();
  await pill(page).click();
  const controls = panel(page)
    .locator("span")
    .filter({ has: panel(page).getByText("Follow new") })
    .filter({ has: panel(page).getByRole("button", { name: /^Clear/ }) })
    .last();
  const button = controls.getByRole("button", { name: /^Profiling/ });

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

for (const width of [220, 300, 360, 480]) {
  test(`docked at the bottom with a list ${width} px wide, its toolbar row holds the user, Follow new, Profile and Clear in one line`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript((stored) => localStorage.setItem("tracepanel:list-width", stored), String(width));
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
    const row = panel(page).locator(".panel-brand");
    const user = row.getByRole("button", { name: "Acting as a-rather-long-username-for-a-toolbar" });
    const controls = [
      user,
      row.locator("label").filter({ hasText: "Follow new" }),
      row.getByRole("button", { name: /^Profiling/ }),
      row.getByRole("button", { name: /^Clear/ }),
    ];

    await expect(user).toBeVisible();
    // The name is the hint's: the button stays its size.
    await expect(user).not.toContainText("a-rather-long");
    await expect(user.getByTestId("user-set-dot")).toBeVisible();

    const box = await row.boundingBox();
    const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
    const middles = boxes.map((each) => (each ? each.y + each.height / 2 : Number.NaN));

    expect(box && boxes.every((each) => each && each.x >= box.x && each.x + each.width <= box.x + box.width)).toBe(
      true,
    );
    // One line, side by side: centred alike (within a pixel or so), none over the one before.
    expect(Math.max(...middles) - Math.min(...middles)).toBeLessThanOrEqual(2);
    expect(
      boxes.every((each, at) => {
        const before = boxes[at - 1];
        return (
          at === 0 || (each !== null && before !== null && before !== undefined && before.x + before.width <= each.x)
        );
      }),
    ).toBe(true);
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await expectHint(page, user, "Acting as a-rather-long-username-for-a-toolbar · click to change");
  });
}

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

    await expect(pill(page)).toHaveCSS("background-color", token("--dt-float", theme));
    await expect(pill(page)).toHaveCSS("color", token("--dt-float-text", theme));
    await expect(status).toHaveText("200");
    await expect(status).toHaveCSS("color", token("--dt-ok", theme));
  });
}

test("with no theme chosen the pill is dark, even on a light system", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openApp(page, { posts: await posts() });

  await expect(page.locator("tracepanel-widget")).toHaveAttribute("data-theme", "dark");
  await expect(pill(page)).toHaveCSS("background-color", token("--dt-float", "dark"));
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
