// A trace the panel lists before the agent has it: a view in the browser goes out once it ends, a request once its
// app wrote it. Until then it is on its way, not "not found", and it opens by itself as it is stored.
import type { Page } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { openApp, panel, pill } from "../app.ts";
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

test("a view the panel follows before it is stored shows as on its way, then opens by itself", async ({ page }) => {
  await openApp(page, {}, { recording: true });
  await pill(page).click();
  const rows = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button");
  await expect(rows).toHaveCount(1);
  const path = `/campaigns/${Date.now()}`;
  const doc = stored(path);

  // The SPA's route changes: the recording announces the new view, and sends it only once it ends.
  await announce(page, doc["id"], path, true);

  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  const main = panel(page).getByRole("main");
  await expect(main.getByText("Trace on its way")).toBeVisible();
  // Longer than the panel's quick retries: still on its way, never "not found".
  await page.waitForTimeout(2500);
  await expect(main.getByText("Trace on its way")).toBeVisible();
  await expect(main.getByText("Trace not found")).toHaveCount(0);

  await announce(page, doc["id"], path, false);
  await store(doc);

  await expect(main.getByRole("tab", { name: /^Call tree/ })).toBeVisible();
  await expect(main.getByText("Trace on its way")).toHaveCount(0);
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

// Each view's row: its badge, its path, its time.
const VIEWS = [/^VIEW\s*\/app\/\d/, /^VIEW\s*\/app\/campaigns\d/, /^VIEW\s*\/app\/campaigns\/42\d/];

test("an SPA's route changes each add a view, the earlier ones staying; a reload replaces an empty one", async ({
  page,
}) => {
  await openApp(page, {}, { recording: true });
  await pill(page).click();
  const rows = panel(page).getByRole("region", { name: "Pages and requests in this browser tab" }).getByRole("button");
  await expect(rows).toHaveCount(1);

  for (const path of ["/app/campaigns", "/app/campaigns/42"]) {
    const id = stored(path)["id"];
    await announce(page, id, path, true);
    await announce(page, id, path, false);
  }

  await expect(rows).toHaveText(VIEWS);
  await expect(rows.nth(2)).toHaveAttribute("aria-current", "true");

  // The same page again with nothing done on it before (a reload): one row for it, not two.
  await announce(page, stored("/app/campaigns/42")["id"], "/app/campaigns/42", true);

  await expect(rows).toHaveText(VIEWS);
});
