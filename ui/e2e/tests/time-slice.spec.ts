// A part of a trace's time, picked over its call tree: a share of the bar says its numbers on hover and keeps only
// its rows on a click; a drag across the lanes or the tree's bars keeps the rows of that stretch of time. Both go
// into the page's URL, and Esc, Show all or a double click let them go. The panel does the same, and its Console
// button opens the trace with what was picked.
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { openApp, panel, pill, traceId } from "../app.ts";
import { expect, test } from "../fixtures.ts";

// GET / (27.6 ms): the request, its view, a query at 1.0–2.2 ms, then the template from 3.1 ms with its 150
// queries; two log records at 2.6 and 2.7 ms.
const TOTAL_MS = 27.637;

type Scope = Page | FrameLocator;

function row(scope: Scope, kind: string, name: string | RegExp): Locator {
  return scope.locator(`.dt-map-row[data-kind="${kind}"]`).filter({ hasText: name });
}

function segment(scope: Scope, category: string): Locator {
  return scope.getByRole("group", { name: "Where the time went" }).locator(`[data-category="${category}"]`);
}

function share(scope: Scope, category: string): Locator {
  return scope
    .getByRole("list", { name: /^Where the time went/ })
    .locator(`[data-category="${category}"]`)
    .getByRole("button");
}

/** Drags across `track` (the lanes' or the tree's time) from one time to another, in ms since the trace started. */
async function drag(page: Page, track: Locator, fromMs: number, toMs: number): Promise<void> {
  const box = await track.boundingBox();
  if (!box) throw new Error(`${track} isn't on the page`);
  const x = (ms: number) => box.x + (ms / TOTAL_MS) * box.width;
  const y = box.y + Math.min(box.height / 2, 30);
  await page.mouse.move(x(fromMs), y);
  await page.mouse.down();
  await page.mouse.move(x((fromMs + toMs) / 2), y, { steps: 4 });
  await page.mouse.move(x(toMs), y, { steps: 4 });
  await page.mouse.up();
}

/** The range the URL says, in ms. */
function rangeOf(url: string): [number, number] {
  const range = new URL(url.replace("#/", "")).searchParams.get("range") ?? "";
  const [from = Number.NaN, to = Number.NaN] = range.split("-").map(Number);
  return [from, to];
}

async function openHome(page: Page, query = "tab=tree"): Promise<void> {
  await page.goto(`/#/t/${await traceId("GET /")}?${query}`);
}

test("a share of the bar says its time, its part of the whole and how many calls on hover", async ({ page }) => {
  await openHome(page);
  await segment(page, "sql").hover();

  await expect(page.getByRole("tooltip", { name: /^Database/ })).toHaveText(/^Database\s*\d+ ms · \d+% · 151 calls$/);

  await segment(page, "view").hover();

  await expect(page.getByRole("tooltip", { name: /^View code/ })).toHaveText(/^View code\s*\d+ ms · \d+% · 1 call$/);
});

test("a share picked keeps its calls, dims the way to them and goes into the URL; again, or Esc, lets it go", async ({
  page,
}) => {
  await openHome(page);
  await segment(page, "template").click();

  await expect(page).toHaveURL(/[?&]part=template(&|$)/);
  await expect(segment(page, "template")).toHaveAttribute("aria-pressed", "true");
  await expect(share(page, "template")).toHaveAttribute("aria-pressed", "true");
  await expect(segment(page, "sql")).toHaveAttribute("data-faded", "");

  await expect(row(page, "template", "blog/post_list.html")).not.toHaveAttribute("data-dim");
  await expect(row(page, "view", "blog.views.post_list")).toHaveAttribute("data-dim", "");
  await expect(row(page, "sql", "SELECT blog_post")).toHaveCount(0);

  await share(page, "template").click();

  await expect(page).not.toHaveURL(/part=/);
  await expect(row(page, "sql", "SELECT blog_post")).toBeVisible();

  await share(page, "view").click();

  await expect(page).toHaveURL(/[?&]part=view(&|$)/);
  await expect(row(page, "view", "blog.views.post_list")).not.toHaveAttribute("data-dim");
  await expect(row(page, "template", "blog/post_list.html")).toHaveCount(0);

  await page.keyboard.press("Escape");

  await expect(page).not.toHaveURL(/part=/);
  await expect(share(page, "view")).toHaveAttribute("aria-pressed", "false");
  await expect(row(page, "template", "blog/post_list.html")).toBeVisible();
  // Esc let the share go: the page stayed.
  await expect(page).toHaveURL(/#\/t\//);
});

test("a link with a share picked opens the tree with it", async ({ page }) => {
  await openHome(page, "tab=tree&part=template");

  await expect(share(page, "template")).toHaveAttribute("aria-pressed", "true");
  await expect(row(page, "sql", "SELECT blog_post")).toHaveCount(0);
});

test("a drag across the lanes keeps the calls of that stretch of time, says it and puts it in the URL", async ({
  page,
}) => {
  await openHome(page, "tab=request");
  const lanes = page.getByRole("figure", { name: "Timeline" }).locator(".dt-timeline-layer");
  await drag(page, lanes, 0.5, 2.4);

  // The lanes' range is the call tree's to show: it opens on it.
  await expect(page.getByRole("tab", { name: /^Call tree/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/[?&]range=/);
  const [from, to] = rangeOf(page.url());

  expect(from).toBeCloseTo(0.5, 0);
  expect(to).toBeCloseTo(2.4, 0);

  await expect(page.locator(".dt-timeline .dt-range-label")).toHaveText(/^0\.\d → 2\.\d ms · 1\.\d ms$/);
  await expect(page.getByRole("button", { name: /^Time 0\.\d → 2\.\d ms/ })).toHaveAttribute("aria-pressed", "true");

  await expect(row(page, "sql", "SELECT blog_post")).toBeVisible();
  await expect(row(page, "template", "blog/post_list.html")).toHaveCount(0);
  await expect(page.locator('.dt-map-row[data-kind="log"]')).toHaveCount(0);

  await page.keyboard.press("Escape");

  await expect(page).not.toHaveURL(/range=/);
  await expect(page.locator(".dt-range")).toHaveCount(0);
  await expect(row(page, "template", "blog/post_list.html")).toBeVisible();
});

test("a drag across the tree's bars picks a stretch too; a click beside the marks or a double click lets it go", async ({
  page,
}) => {
  await openHome(page);
  const ruler = page.locator(".dt-map-ruler");
  await drag(page, ruler, 2.5, 2.9);

  await expect(page).toHaveURL(/[?&]range=/);
  await expect(page.locator('.dt-map-row[data-kind="log"]')).toHaveCount(2);
  await expect(row(page, "sql", "SELECT blog_post")).toHaveCount(0);
  // No row was opened by the drag's end.
  await expect(page.getByRole("complementary", { name: "Details" })).toHaveCount(0);

  await ruler.dblclick();

  await expect(page).not.toHaveURL(/range=/);

  await openHome(page, "tab=tree&range=0.5-2.4");

  await expect(row(page, "template", "blog/post_list.html")).toHaveCount(0);

  const track = page.locator(".dt-lane-track").last();
  const box = await track.boundingBox();
  await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) - 4, (box?.y ?? 0) + 3);

  await expect(page).not.toHaveURL(/range=/);
  await expect(row(page, "template", "blog/post_list.html")).toBeVisible();
});

test("a share and a range together keep the calls of that kind in that stretch; Show all lets both go", async ({
  page,
}) => {
  await openHome(page, "tab=tree&part=sql&range=0.5-2.4");

  await expect(row(page, "sql", "SELECT blog_post")).not.toHaveAttribute("data-dim");
  await expect(row(page, "view", "blog.views.post_list")).toHaveAttribute("data-dim", "");
  await expect(row(page, "template", "blog/post_list.html")).toHaveCount(0);

  await page.getByRole("button", { name: "Show all", exact: true }).click();

  await expect(page).not.toHaveURL(/part=|range=/);
  await expect(row(page, "template", "blog/post_list.html")).toBeVisible();
});

test("in the panel: the numbers on hover, a share and a stretch of time picked, and the Console opens with them", async ({
  page,
}) => {
  await openApp(page, { home: { status: 200, trace: await traceId("GET /"), queries: 151, totalMs: 28 } });
  await page.getByRole("button", { name: "Load home" }).click();
  await pill(page).click();
  const frame = panel(page);
  await frame.getByRole("tab", { name: /^Call tree/ }).click();
  await segment(frame, "sql").hover();

  await expect(frame.getByRole("tooltip", { name: /^Database/ })).toHaveText(/^Database\s*\d+ ms · \d+% · 151 calls$/);

  await segment(frame, "template").click();

  await expect(row(frame, "view", "blog.views.post_list")).toHaveAttribute("data-dim", "");
  await expect(row(frame, "sql", "SELECT blog_post")).toHaveCount(0);
  await expect(frame.getByRole("link", { name: /^Console/ })).toHaveAttribute("href", /[?&]part=template(&|$)/);

  await page.keyboard.press("Escape");

  await expect(row(frame, "sql", "SELECT blog_post")).toBeVisible();
  // Esc let the share go; the panel stayed open.
  await expect(frame.getByRole("tab", { name: /^Call tree/ })).toBeVisible();

  await frame.getByRole("tab", { name: /^Request/ }).click();
  await drag(page, frame.locator(".dt-timeline-layer"), 0.5, 2.4);

  await expect(frame.getByRole("tab", { name: /^Call tree/ })).toHaveAttribute("aria-selected", "true");
  await expect(frame.locator(".dt-map-range-layer .dt-range-label")).toHaveText(/^0\.\d → 2\.\d ms · 1\.\d ms$/);
  await expect(row(frame, "template", "blog/post_list.html")).toHaveCount(0);
  await expect(frame.getByRole("link", { name: /^Console/ })).toHaveAttribute("href", /[?&]range=0\.\d+-2\.\d+/);

  await frame.getByRole("button", { name: "Show all", exact: true }).click();

  await expect(row(frame, "template", "blog/post_list.html")).toBeVisible();
});
