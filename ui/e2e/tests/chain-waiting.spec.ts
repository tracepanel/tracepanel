// The panel's list says what is still coming under a row whose trace called other apps: placeholders while the
// row's chain loads the first time (a slow one), and each call whose trace the agent hasn't got yet, where that
// trace's row will be and as it will look (its status and time, its numbers "…"), until it arrives (or, from a
// service that records none, for a few seconds after the last call to it: then the same row says "not traced").
import type { Locator, Page } from "@playwright/test";
import { openApp, panel, pill } from "../app.ts";
import { type ArrivingCall, arriving } from "../chain.ts";
import { expect, test } from "../fixtures.ts";

/** The panel's list with the BFF's request in it (`bff`), the browser's clock at `now`, and its chain's rows. */
async function listed(page: Page, bff: string, now: number) {
  await page.clock.setFixedTime(now);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, { graphql: { status: 200, trace: bff, queries: 0, totalMs: 8 } });
  await page.getByRole("button", { name: "Load graphql" }).click();
  await pill(page).click();
  const list = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" });
  return {
    list,
    rows: list.locator(".tp-request-row"),
    waiting: list.locator('.tp-request-row[data-chain="waiting"]'),
    loading: list.locator('.tp-request-row[data-chain="loading"]'),
  };
}

/** Each row under the request: what it is, and its name (an app's, or a call's method and path). */
function under(rows: Locator) {
  return rows.evaluateAll((each) =>
    each.slice(1).map((row) => {
      const kind = row.getAttribute("data-chain");
      const name =
        kind === "app"
          ? row.querySelector(".tp-app-chip")?.textContent
          : [row.querySelector(".tp-method")?.textContent, row.querySelector(".tp-request-path")?.textContent]
              .filter(Boolean)
              .join(" ");
      return `${kind} ${name}`;
    }),
  );
}

const calls: ArrivingCall[] = [
  { url: "http://localhost:8901/library/books" },
  { url: "http://localhost:8901/library/authors/batch" },
];

test("calls whose traces haven't arrived wait under the request, their numbers pending, each replaced by its trace's row", async ({
  page,
}) => {
  const { bff, now, serve } = await arriving(1, calls);
  const { rows, waiting } = await listed(page, bff, now);

  // Neither arrived: both calls wait, by their method and path, in the order they were made.
  await expect.poll(() => under(rows)).toEqual(["waiting GET /library/books", "waiting GET /library/authors/batch"]);
  await expect(waiting.first()).toHaveAttribute("aria-disabled", "true");
  // As its trace's row will be: its time, its numbers on their way.
  await expect(waiting.first().locator(".tp-pending")).toHaveText("…");
  await expect(waiting.first()).toHaveAttribute("title", /^GET \/library\/books: waiting for its trace/);

  await serve(0);

  // The first arrived, in the first's place: its app, its trace; the other call to that app waits among its rows.
  await expect
    .poll(() => under(rows), { timeout: 5_000 })
    .toEqual(["app shop", "trace GET /library/books", "waiting GET /library/authors/batch"]);

  // A waiting row is as tall as the row that takes its place.
  const [trace, waits] = await Promise.all(
    [rows.nth(2), waiting.first()].map(async (row) => (await row.boundingBox())?.height),
  );
  expect(waits).toBeCloseTo(trace as number, 0);

  await serve(1);

  // All of them here: nothing waits.
  await expect
    .poll(() => under(rows), { timeout: 5_000 })
    .toEqual(["app shop", "trace GET /library/books", "trace GET /library/authors/batch"]);
  await expect(waiting).toHaveCount(0);
});

test("a call to a service that sends no trace waits a few seconds after it ended, then its row says not traced", async ({
  page,
}) => {
  // A third-party API (its trace never comes), called 8.5 s ago: waited for 10 s after the call.
  const { bff, now } = await arriving(2, [{ url: "https://api.example.com/rates", ago: 8_500_000 }]);
  const { rows, waiting } = await listed(page, bff, now);

  await expect.poll(() => under(rows)).toEqual(["waiting GET /rates"]);
  const row = rows.nth(1);
  await row.evaluate((element) => {
    (element as HTMLElement).dataset["probe"] = "kept";
  });

  // 10.6 s after the call ended: no trace came, none will. The same row stays, as the call tree says it.
  await page.clock.setFixedTime(now + 2_000);

  await expect(waiting).toHaveCount(0, { timeout: 4_000 });
  expect(await under(rows)).toEqual(["untraced GET /rates"]);
  await expect(row).toHaveAttribute("data-probe", "kept");
  await expect(row.locator('[data-state="untraced"]')).toHaveText("not traced");
  await expect(row).toHaveAttribute("title", /^GET \/rates: Not traced: api\.example\.com /);
  // No numbers to wait for.
  await expect(row.locator(".tp-pending")).toHaveCount(0);
});

test("a gateway's early call waits as long as its last one: its trace comes with theirs, never not traced first", async ({
  page,
}) => {
  // Two operations through one gateway over OTLP: the agent holds its spans of the W3C trace until the last one's came,
  // so the first one's trace, ended 7 s ago, comes only after the second's, ended a moment ago.
  const gateway = "http://localhost:8902/graphql";
  const { bff, now, serve } = await arriving(4, [{ url: gateway, ago: 7_000_000 }, { url: gateway }]);
  const { rows, waiting } = await listed(page, bff, now);

  await expect.poll(() => under(rows)).toEqual(["waiting GET /graphql", "waiting GET /graphql"]);
  await expect(rows.locator('[data-state="untraced"]')).toHaveCount(0);

  // The list asks again: still both waited for, 9 s after the first ended.
  await page.clock.setFixedTime(now + 2_000);
  await page.waitForTimeout(2_500);
  expect(await under(rows)).toEqual(["waiting GET /graphql", "waiting GET /graphql"]);
  await expect(waiting).toHaveCount(2);

  // Its trace comes: the row it was, never "not traced" before.
  await serve(0);
  await expect
    .poll(() => under(rows), { timeout: 5_000 })
    .toEqual(["app shop", "trace GET /graphql", "waiting GET /graphql"]);
});

test("while a request's chain loads the first time, a placeholder row stands where its apps' rows go", async ({
  page,
}) => {
  const { bff, now, serve } = await arriving(3, calls.slice(0, 1));
  await serve(0);
  // The agent slow to answer the first time.
  let release: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/traces/${bff}/chain`, async (route) => {
    await answered;
    await route.continue();
  });
  const { rows, loading } = await listed(page, bff, now);

  await expect(loading).toHaveCount(1);
  await expect(loading).toHaveAttribute("role", "status");
  await expect(loading).toHaveAccessibleName("Loading the traces of this request's calls");
  const placeholder = (await loading.boundingBox())?.height;

  release();

  await expect(loading).toHaveCount(0);
  await expect.poll(() => under(rows)).toEqual(["app shop", "trace GET /library/books"]);
  // As tall as the row that took its place: nothing under it moved.
  expect((await rows.nth(1).boundingBox())?.height).toBeCloseTo(placeholder as number, 0);
});
