// Why a trace was profiled, as its SDK says on its root span (`profile.reason`): said on its Profile tab, by the
// time and by the memory, in words ("Profiled: by the panel's cookie"); a reason the console doesn't know as sent,
// and nothing more said without one.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const COOKIE = "01M4PR0F11ER0000000000000C";
const OTHER = "01M4PR0F11ER0000000000000T";
const NONE = "01M4PR0F11ER0000000000000N";

/** A request of 20 ms, sampled every ms in the view, its memory counted; profiled for `reason`, if it says. */
function profiled(id: string, reason: string | null, start: number): Doc {
  const attrs: Doc = reason === null ? {} : { "profile.reason": reason };
  // biome-ignore-start lint/style/useNamingConvention: a trace as the SDKs send it.
  return {
    id,
    kind: "http",
    name: "GET /profile-reason",
    start,
    duration: 20_000,
    status: "ok",
    attrs: { "service.name": "shop", "http.method": "GET", "http.route": "/profile-reason" },
    spans: [
      {
        id: "r",
        parent_id: null,
        kind: "http",
        name: "GET /profile-reason",
        start,
        duration: 20_000,
        status: "ok",
        attrs,
      },
    ],
    logs: [],
    errors: [],
    links: [],
    issues: [],
    profile: {
      interval_us: 1_000,
      samples: 20,
      frames: [{ function: "report", module: "shop.views", file: "shop/views.py", line: 12, in_app: true }],
      stacks: [{ frames: [0], count: 20 }],
      memory: { peak: 2_097_152, net: 0, sites: [{ frames: [0], bytes: 2_097_152, count: 10 }] },
    },
  };
  // biome-ignore-end lint/style/useNamingConvention: a trace as the SDKs send it.
}

test.beforeEach(async () => {
  const start = Date.now() * 1000 - 6.5 * 3_600_000_000;
  const traces = [profiled(COOKIE, "cookie", start), profiled(OTHER, "sampler", start), profiled(NONE, null, start)];
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(traces),
  });
  expect(response.status).toBe(202);
  for (const id of [COOKIE, OTHER, NONE]) {
    await expect.poll(async () => (await fetch(`${CONSOLE}api/traces/${id}`)).status).toBe(200);
  }
});

const profileTab = async (page: Page, id: string) => {
  await page.goto(`/#/t/${id}?tab=profile`);
  await expect(page.getByText("20 samples, one every 1 ms")).toBeVisible();
};

test("a trace profiled by the panel's cookie says so, by its time and by its memory", async ({ page }) => {
  await profileTab(page, COOKIE);

  await expect(page.getByText("Profiled: by the panel's cookie", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Memory", exact: true }).click();

  await expect(page.getByText("peak, above where it started")).toBeVisible();
  await expect(page.getByText("Profiled: by the panel's cookie", { exact: true })).toBeVisible();
});

test("a reason the console doesn't know is said as sent; none, nothing more is said", async ({ page }) => {
  await profileTab(page, OTHER);
  await expect(page.getByText("Profiled: sampler", { exact: true })).toBeVisible();

  await profileTab(page, NONE);
  await expect(page.getByText(/^Profiled:/)).toHaveCount(0);
});
