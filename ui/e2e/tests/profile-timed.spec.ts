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
    /^your code\s*100 ms\s*6%$/,
    /^waiting\s*1\.5 s\s*94%$/,
  ]);
});

test("the strip and its share's numbers split the code's own time; a click on the wait opens its profile", async ({
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

  await expect(page.getByRole("tooltip", { name: /^Your code/ })).toContainText("of it 1.5 s waiting");

  const middle = await centre(waiting);
  await page.mouse.move(...middle);

  // Its share's numbers only: the wait row in the tree names what it waited on and where.
  await expect(page.locator(".dt-lane-tip")).toContainText("Your code");
  await expect(page.getByRole("tooltip").filter({ hasText: /Open the profile|tasks\.py/ })).toHaveCount(0);

  await page.mouse.click(...middle);

  await expect(page.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Profile of 120 ms – 1.6 s")).toBeVisible();
  await expect(page.getByRole("region", { name: "Time by package" }).getByRole("button")).toHaveText([
    /^waiting\s*[\d.]+ m?s\s*100%$/,
  ]);
  // The stretch is the Profile tab's own: the call tree keeps the whole time, a range there is a drag's only.
  await expect(page).not.toHaveURL(/[?&]range=/);

  await page.getByRole("tab", { name: /^Call tree/ }).click();

  await expect(page.getByRole("button", { name: /^Time / })).toHaveCount(0);
  await expect(page.locator(".dt-range")).toHaveCount(0);
});

test("the call tree has the wait and the code as rows of their own; the wait's opens the profile at it", async ({
  page,
}) => {
  await page.goto(`/#/t/${await traceId(DIGEST)}?tab=tree`);

  await expect(codeRow(page, "wait").locator(".dt-map-text")).toHaveText("asyncio.sleep in send_digest");
  // Where it waited, quietly after its name; no popup over the row.
  await expect(codeRow(page, "wait").locator(".dt-map-sub")).toHaveText("tasks.py:108");
  await expect(codeRow(page, "code").locator(".dt-map-sub")).toHaveCount(0);

  await codeRow(page, "wait").hover();

  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await expect(codeRow(page, "code").locator(".dt-map-text")).toHaveText("render_digest");
  await expect(codeRow(page, "wait").locator(".dt-map-time")).toHaveText("1.5 s");
  await expect(codeRow(page, "code").locator(".dt-map-time")).toHaveText("102 ms");

  await codeRow(page, "wait").click();

  await expect(page.getByText("Profile of 120 ms – 1.6 s")).toBeVisible();

  await openApp(page, { one: { status: 200, trace: await traceId(DIGEST), queries: 1, totalMs: 1600 } });
  await page.getByRole("button", { name: "Load one" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await frame.locator('.dt-map-row[data-kind="code"]').first().click();

  await expect(frame.getByRole("tab", { name: /^Profile/ })).toHaveAttribute("aria-selected", "true");
  await expect(frame.getByText("Profile of 120 ms – 1.6 s")).toBeVisible();
});

test("a profile that doesn't say when its samples were taken is the whole trace's, said so", async ({ page }) => {
  await page.goto(`/#/t/${await traceId(HELD_REPORT)}?tab=profile&range=100-400`);

  await expect(page.getByText("Profile of the whole trace")).toBeVisible();
  await expect(page.getByText("Its samples aren't timed: the range picked can't narrow it.")).toBeVisible();
  await expect(page.getByText(/not sampled/)).toHaveCount(0);
});

/** What of a profile the tests change: its frames, its stacks and when each was seen. */
interface WireProfile {
  frames: Record<string, unknown>[];
  stacks: { frames: number[]; at: [number, number][] }[];
}

/** The digest's trace as the agent gives it, its profile changed by `change`. */
async function withProfile(page: Page, change: (profile: WireProfile) => void): Promise<string> {
  const id = await traceId(DIGEST);
  await page.route(`**/api/traces/${id}`, async (route) => {
    const trace = await (await route.fetch()).json();
    change(trace.profile);
    await route.fulfill({ json: trace });
  });
  return id;
}

test("a wait the app awaited through sync_to_async is named as the app wrote it", async ({ page }) => {
  const id = await withProfile(page, (profile) => {
    profile.frames.push({
      function: "SyncToAsync.__call__",
      module: "asgiref.sync",
      file: "asgiref/sync.py",
      line: 400,
    });
    (profile.stacks[1] as WireProfile["stacks"][number]).frames = [0, 1, 4, 2];
  });
  await page.goto(`/#/t/${id}?tab=tree`);

  await expect(codeRow(page, "wait").locator(".dt-map-text")).toHaveText("await sync_to_async(…) in send_digest");
});

test("a few ms of code beside a long wait is part of the wait: one row, all of the time", async ({ page }) => {
  // Every sample waits, from the first query on: the code's own time before it is a couple of ms.
  const id = await withProfile(page, (profile) => {
    const wait = profile.stacks[1] as WireProfile["stacks"][number];
    wait.at = Array.from({ length: 158 }, (_, index): [number, number] => [index + 2, 1]);
    profile.stacks = [wait];
  });
  await page.goto(`/#/t/${id}?tab=tree`);

  await expect(page.locator('.dt-map-row[data-kind="code"]')).toHaveCount(1);
  await expect(codeRow(page, "wait").locator(".dt-map-time")).toHaveText(/^1\.\d+ s$/);
});
