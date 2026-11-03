// A call to a host that records no traces (a gateway's remote subgraph) says so: "not traced", muted, on its row in the
// call tree and the HTTP calls tab, and why in its details. A call another app answered is that app's row instead,
// and a call still waited for isn't said untraced yet.

import type { Locator } from "@playwright/test";
import { expect as pollExpect } from "@playwright/test";
import { CONSOLE } from "../agent.ts";
import { laidOut } from "../app.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const ms = 1_000;
const ROUTER = "01M4NTRACE0000000000000001";
const SUBGRAPH = "01M4NTRACE0000000000000002";
const JUST_NOW = "01M4NTRACE0000000000000003";
const W3C = "756e747261636564000000000000ab01";
const NOTE = "Not traced: reviews.example.test sends no traces to Tracepanel.";

function span(id: string, parent: string | null, kind: string, name: string, start: number, duration: number): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start, duration, status: "ok", attrs: {} as Doc };
}

/** A call carrying the trace on (`w3c`) to `url`, answered 200. */
function call(id: string, url: string, start: number, w3c: string): Doc {
  const { host, pathname } = new URL(url);
  return {
    ...span(id, "rr", "http.client", `POST ${host}${pathname}`, start, 300 * ms),
    attrs: { "http.request.method": "POST", "url.full": url, "http.response.status_code": 200, "w3c.span_id": w3c },
  };
}

function trace(id: string, name: string, app: string, start: number, attrs: Doc, spans: Doc[]): Doc {
  return {
    id,
    kind: "http",
    name,
    start,
    duration: 800 * ms,
    status: "ok",
    attrs: { "service.name": app, "w3c.trace_id": W3C, "http.method": "POST", "http.route": "/graphql", ...attrs },
    spans: [span("rr", null, "http", name, start, 800 * ms), ...spans],
    logs: [],
    errors: [],
    links: [],
    issues: [],
  };
}

/** A router's trace (an hour ago): one call to a subgraph that sends its trace, one to one that sends none. */
async function storeRouter(): Promise<void> {
  const start = Date.now() * ms - 3_600_000_000;
  const router = trace(ROUTER, "POST /graphql", "router", start, {}, [
    call("c1", "http://127.0.0.1:4071/graphql", start + 50 * ms, "aaaa000000000001"),
    call("c2", "https://reviews.example.test/graphql", start + 400 * ms, "aaaa000000000002"),
  ]);
  const subgraph = trace(
    SUBGRAPH,
    "POST /graphql",
    "books",
    start + 60 * ms,
    { "w3c.parent_span_id": "aaaa000000000001" },
    [],
  );
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([router, subgraph]),
  });
  expect(response.status).toBe(202);
  await pollExpect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${ROUTER}/chain`)).json()) as Doc)["traces"])
    .toHaveLength(2);
}

/**
 * Whether a label's letters are all shown: its last one's ink (an italic "d" leans past its advance) inside every box
 * that clips it, its own and its rows'.
 */
function inkShown(label: Locator): Promise<boolean> {
  return label.evaluate((element) => {
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return false;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const range = document.createRange();
    range.selectNodeContents(element);
    const ink =
      range.getBoundingClientRect().left + context.measureText(element.textContent ?? "").actualBoundingBoxRight;
    let edge = Number.POSITIVE_INFINITY;
    for (let box: Element | null = element; box; box = box.parentElement) {
      const clips = getComputedStyle(box).overflowX !== "visible";
      if (clips)
        edge = Math.min(
          edge,
          box.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(box).borderRightWidth),
        );
    }
    return ink <= edge + 0.25;
  });
}

test("a call to a host that sends no traces says not traced, on its row and in its details; the traced one doesn't", async ({
  page,
}) => {
  await storeRouter();
  await page.goto(`/#/t/${ROUTER}?tab=tree`);
  const untraced = page.locator(".dt-map-row").filter({ hasText: "reviews.example.test" });
  const traced = page.locator(".dt-map-row").filter({ hasText: "books" });

  await expect(untraced.locator('[data-state="untraced"]')).toHaveText("not traced");
  await expect(untraced.locator('[data-state="untraced"]')).toHaveAttribute("title", new RegExp(`^${NOTE}`));
  // Its italic letters whole, its last one too.
  await laidOut(page);
  expect(await inkShown(untraced.locator('[data-state="untraced"]'))).toBe(true);
  await expect(traced).toHaveCount(1);
  await expect(traced.locator('[data-state="untraced"]')).toHaveCount(0);

  await untraced.click();

  await expect(page.getByRole("complementary", { name: "Details" }).locator(".dt-not-traced-note")).toContainText(NOTE);

  await page.getByRole("tab", { name: /^HTTP calls/ }).click();

  const untracedCall = page.getByRole("tabpanel").getByText("not traced");
  await expect(untracedCall).toHaveCount(1);
  await expect(untracedCall).toHaveAttribute("title", new RegExp(`^${NOTE}`));
  await laidOut(page);
  expect(await inkShown(untracedCall)).toBe(true);
});

test("a call that just ended is waited for first: not traced only once no trace came in time", async ({ page }) => {
  const start = Date.now() * ms - 1_000 * ms;
  const router = trace(JUST_NOW, "POST /graphql", "router", start, {}, [
    call("c2", "https://reviews.example.test/graphql", start + 400 * ms, "aaaa000000000003"),
  ]);
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([router]),
  });
  expect(response.status).toBe(202);
  await pollExpect.poll(async () => (await fetch(`${CONSOLE}api/traces/${JUST_NOW}`)).status).toBe(200);
  await page.goto(`/#/t/${JUST_NOW}?tab=tree`);
  const row = page.locator(".dt-map-row").filter({ hasText: "reviews.example.test" });

  await expect(page.locator(".dt-on-its-way")).toBeVisible();
  await expect(row.locator('[data-state="untraced"]')).toHaveCount(0);

  // Waited for 5 s after it ended: no trace came.
  await expect(row.locator('[data-state="untraced"]')).toHaveText("not traced", { timeout: 10_000 });
  await expect(page.locator(".dt-on-its-way")).toHaveCount(0);
});
