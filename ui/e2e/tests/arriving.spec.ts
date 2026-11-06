// A trace the panel lists before the agent has it: a view in the browser goes out once it ends, a request once its
// app wrote it. Until then it is on its way, not "not found", and it opens by itself as it is stored.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { openApp, panel, pill, records } from "../app.ts";
import { expect, test } from "../fixtures.ts";
import { trace } from "../seed.ts";

type Doc = Record<string, unknown>;

/**
 * A trace with a name of its own, as the agent stores it once it arrives. A request, not a view: a view the Pages
 * section counts would change the other tests' lists, while a request of hours ago is in none of them.
 */
function stored(path: string): Doc {
  const doc = trace("http", `GET ${path}`, { "service.name": "shop-node", "http.method": "GET" });
  // Hours ago, older than the seed's traces: no list opens on it. Its id still says it started a moment ago.
  doc["start"] = Date.now() * 1000 - 3 * 3_600_000_000;
  return doc;
}

async function store(doc: Doc): Promise<void> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([doc]),
  });
  expect(response.status).toBe(202);
}

/** The recording's announcement of the view of `path`, as it starts (`open`) and as it ends. */
async function announce(page: Page, id: unknown, path: string, open: boolean): Promise<void> {
  const detail = {
    id,
    name: path,
    start: Date.now() * 1000,
    duration: open ? 0 : 2_700_000,
    status: "ok",
    open,
  };
  await page.evaluate((sent) => {
    dispatchEvent(new CustomEvent("tracepanel:page", { detail: sent }));
  }, detail);
}

test("a view the panel follows while it is open shows as running, then on its way, then opens by itself", async ({
  page,
}) => {
  await openApp(page, {}, { recording: true });
  await pill(page).click();
  await expect(records(page)).toHaveCount(1);
  const path = `/campaigns/${Date.now()}`;
  const doc = stored(path);

  // The SPA's route changes: the recording announces the new view, and sends it only once it ends.
  await announce(page, doc["id"], path, true);

  // The newest first: open, running, its time ticking in its row.
  const view = records(page).first();
  await expect(records(page)).toHaveCount(2);
  await expect(view).toHaveText(new RegExp(`^view\\s*${path}`, "i"));
  await expect(view).toHaveAttribute("aria-current", "true");
  await expect(view).toHaveAttribute("data-live", "");
  const before = await view.locator(".tp-map-time").innerText();
  // Longer than the panel's quick retries: still on its way, never "not found".
  await page.waitForTimeout(2500);
  await expect(view).toHaveAttribute("data-live", "");
  await expect(view.locator(".tp-map-time")).not.toHaveText(before);
  await expect(panel(page).getByText("Trace not found")).toHaveCount(0);

  // Ended, not stored yet: on its way, no longer running.
  await announce(page, doc["id"], path, false);
  await expect(view).not.toHaveAttribute("data-live", "");
  await store(doc);

  // Stored: its call tree opens by itself, its row the tree's first.
  await expect(records(page).first()).toHaveAttribute("data-root", "");
  await expect(panel(page).getByText("Trace not found")).toHaveCount(0);
});

test("the console's page of a trace started a moment ago waits for it", async ({ page }) => {
  const path = `/campaigns/${Date.now()}`;
  const doc = stored(path);
  await page.goto(`/#/t/${doc["id"]}`);
  const main = page.getByRole("main");

  await expect(main.getByText("Trace on its way")).toBeVisible();

  await store(doc);

  await expect(main.getByRole("heading", { level: 2, name: path })).toBeVisible();
});

// Each view's row, the newest first: its badge, its path.
const VIEWS = [/^view\s*\/app\/campaigns\/42/i, /^view\s*\/app\/campaigns(?!\/)/i, /^view\s*\/app\//i];

test("an SPA's route changes each add a view, the earlier ones staying; a reload replaces an empty one", async ({
  page,
}) => {
  await openApp(page, {}, { recording: true });
  await pill(page).click();
  const rows = records(page);
  await expect(rows).toHaveCount(1);

  for (const path of ["/app/campaigns", "/app/campaigns/42"]) {
    const id = stored(path)["id"];
    await announce(page, id, path, true);
    await announce(page, id, path, false);
  }

  await expect(rows).toHaveText(VIEWS);
  await expect(rows.first()).toHaveAttribute("aria-current", "true");

  // The same page again with nothing done on it before (a reload): one row for it, not two.
  await announce(page, stored("/app/campaigns/42")["id"], "/app/campaigns/42", true);

  await expect(rows).toHaveText(VIEWS);
});
