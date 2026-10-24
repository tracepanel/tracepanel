// A profile that says when its stacks were seen, which frames waited and how much wasn't sampled: the Profile tab says
// how much of the trace it sampled and why the rest wasn't, waiting is its own share; the time strip, its legend and
// the call tree split the code's own time into waiting and computing, name the wait and open the profile at that
// stretch. A profile from before (no buckets) is the whole trace's, said so.
import type { Locator, Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { DIGEST, HELD_REPORT } from "../seed.ts";

async function centre(locator: Locator): Promise<[number, number]> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} isn't on the page`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

function codeRow(page: Page, kind: string) {
  return page.locator('.dt-map-row[data-kind="code"]').filter({ has: page.locator(".dt-map-kind", { hasText: kind }) });
}

test("the Profile tab says how much it sampled, what it couldn't, and waiting as its own share", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=profile`);

  await expect(page.getByText("Profile of the whole trace")).toBeVisible();
  // In the trace's own time, as the strip says it: the time not sampled filled in from the samples around it.
  await expect(page.getByText("profiled of the trace's 1.6 s")).toBeVisible();
  await expect(page.getByText("110 samples, one every 10 ms")).toBeVisible();
  await expect(
    page.getByText("500 ms not sampled: other traces ran on the same thread, filled in from the samples around it"),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Time by package" }).getByRole("button")).toHaveText([
    /^waiting\s*94%\s*1\.5 s$/,
    /^your code\s*6%\s*100 ms$/,
  ]);
});

test("the strip and its share's numbers split the code's own time; the wait is named, a click opens its profile", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=tree`);
  const waiting = page.locator(".dt-quiet-said").filter({ hasText: "waiting" });

  await expect(waiting).toHaveText("waiting · 1.5 s");

  // Said once on the strip; the legend says it only on hover.
  await page
    .getByRole("list", { name: /^Where the time went/ })
    .getByRole("button", { name: /^Your code/ })
    .hover();

  await expect(page.getByRole("tooltip", { name: /^Your code/ })).toContainText(
    "of it 1.5 s waiting · 102 ms untraced",
  );

  const middle = await centre(waiting);
  await page.mouse.move(...middle);

  await expect(page.getByRole("tooltip").filter({ hasText: "Waiting · 1.5 s" })).toContainText(
    "await asyncio.sleep in send_digest · tasks.py:108",
  );

  await page.mouse.click(...middle);

  await expect(page.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Profile of 120 → 1600 ms · 1480 ms")).toBeVisible();
  await expect(page).toHaveURL(/[?&]range=120-1600/);
  await expect(page.getByRole("region", { name: "Time by package" }).getByRole("button")).toHaveText([
    /^waiting\s*100%/,
  ]);
});

test("the call tree has the wait and the code as rows of their own; the wait's opens the profile at it", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=tree`);

  await expect(codeRow(page, "wait").locator(".dt-map-text")).toHaveText("asyncio.sleep in send_digest");
  await expect(codeRow(page, "code").locator(".dt-map-text")).toHaveText("render_digest");
  await expect(codeRow(page, "wait").locator(".dt-map-time")).toHaveText("1.5 s");
  await expect(codeRow(page, "code").locator(".dt-map-time")).toHaveText("102 ms");

  await codeRow(page, "wait").click();

  await expect(page.getByText("Profile of 120 → 1600 ms · 1480 ms")).toBeVisible();

  await openApp(page, { one: { status: 200, trace: await traceId(DIGEST), queries: 1, totalMs: 1600 } });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await frame.locator('.dt-map-row[data-kind="code"]').first().click();

  await expect(frame.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
  await expect(frame.getByText("Profile of 120 → 1600 ms · 1480 ms")).toBeVisible();
});

test("a profile that doesn't say when its samples were taken is the whole trace's, said so", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=profile&range=100-400`);

  await expect(page.getByText("Profile of the whole trace")).toBeVisible();
  await expect(page.getByText("Its samples aren't timed: the range picked can't narrow it.")).toBeVisible();
  await expect(page.getByText(/not sampled/)).toHaveCount(0);
});

test("the strip's tooltip holds while the pointer travels into it: its Open the profile is a click away", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=tree`);
  const waiting = page.locator(".dt-time-track .dt-stretch[data-waiting]").first();
  await page.mouse.move(...(await centre(waiting)));
  const tip = page.getByRole("tooltip").filter({ hasText: "Waiting · 1.5 s" });
  const open = tip.getByRole("button", { name: "Open the profile" });
  // Down into it, across the lane under the strip: it stays.
  await page.mouse.move(...(await centre(open)), { steps: 8 });

  await expect(tip).toBeVisible();

  await open.click();

  await expect(page.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Profile of 120 → 1600 ms · 1480 ms")).toBeVisible();
});

test("the strip's tooltip from the keyboard: Tab to the stretch opens it, Tab again reaches its link, Esc closes it", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=tree&range=100-400`);
  const waiting = page.locator(".dt-quiet-said").filter({ hasText: "waiting" });
  await waiting.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const tip = page.getByRole("tooltip").filter({ hasText: "Waiting · 1.5 s" });

  await expect(tip).toBeVisible();

  await page.keyboard.press("Tab");

  await expect(tip.getByRole("button", { name: "Open the profile" })).toBeFocused();

  await page.keyboard.press("Escape");

  await expect(tip).toHaveCount(0);
  // The tooltip took Esc: the range picked stays.
  await expect(page).toHaveURL(/[?&]range=100-400/);
});

test("the tree's code row's tooltip holds while the pointer travels into it; its link opens the profile", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=tree`);
  await codeRow(page, "wait").hover();
  const tip = page.getByRole("tooltip").filter({ hasText: "Waiting · 1.5 s" });
  const open = tip.getByRole("button", { name: "Open the profile" });
  await page.mouse.move(...(await centre(open)), { steps: 8 });

  await expect(tip).toBeVisible();
  // No title of the browser's under it: the tooltip says the row.
  await expect(codeRow(page, "wait").locator("[title]")).toHaveCount(0);

  await open.click();

  await expect(page.getByText("Profile of 120 → 1600 ms · 1480 ms")).toBeVisible();
});
