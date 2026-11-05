import { CONSOLE, RUN_STARTED } from "../agent.ts";
import { expect, test } from "../fixtures.ts";

type Doc = Record<string, unknown>;

const ms = 1_000;
const OPERATIONS = ["Features", "TenantRoles", "Campaigns"];

/**
 * Which run of the test this is (`--repeat-each`, a retry): its traces' ids and times its own, none an earlier run
 * stored.
 */
const run = () => test.info().repeatEachIndex * 2 + test.info().retry;
const digits = (value: number, width: number) => String(value).padStart(width, "0");

const id = (tag: number, n: number) => `01M4RED1RECT${digits(tag, 3)}${digits(run(), 5)}${digits(n, 6)}`;
/** The id of the browser's trace a test's views are in. */
const traceOf = (tag: number) => `${digits(tag, 4)}${digits(run(), 5)}d0f4e3a8b5c7d9e1f2a3b4c`;
/** The id of the view's call of its `n`th operation, which the gateway's trace names as its parent. */
const callOf = (tag: number, n: number) => `${digits(tag, 3)}a${digits(run(), 5)}${digits(n, 7)}`;

function span(name: string, parent: string | null, kind: string, label: string, start: number, duration: number): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id: name, parent_id: parent, kind, name: label, start, duration, status: "ok", attrs: {} as Doc };
}

function trace(traceId: string, kind: string, name: string, start: number, duration: number, extra: Doc): Doc {
  return {
    id: traceId,
    kind,
    name,
    start,
    duration,
    status: "ok",
    logs: [],
    errors: [],
    links: [],
    issues: [],
    attrs: extra["attrs"],
    spans: [span(`${traceId}r`, null, kind, name, start, duration), ...((extra["spans"] as Doc[] | undefined) ?? [])],
  };
}

/** A view of the browser's, by a route change: `/path`, its calls under it. */
function view(traceId: string, path: string, start: number, duration: number, calls: Doc[], w3c: string): Doc {
  return trace(traceId, "page", path, start, duration, {
    attrs: {
      "service.name": "shop-web",
      "service.role": "browser",
      "telemetry.sdk.language": "webjs",
      "page.path": path,
      "page.trigger": "navigation",
      "user_agent.original": "e2e",
      "w3c.trace_id": w3c,
    },
    spans: calls,
  });
}

/** The view's call of `operation` to the gateway, all of them at once; `cut`: its trace went out before the answer. */
function operationCall(tag: number, n: number, start: number, duration: number, cut: boolean): Doc {
  const call = span(`v${tag}-${n}`, `${id(tag, 1)}r`, "http.client", "POST 127.0.0.1:4000/graphql", start, duration);
  call["attrs"] = {
    "http.request.method": "POST",
    "url.full": "http://127.0.0.1:4000/graphql",
    "server.address": "127.0.0.1",
    "server.port": 4000,
    "w3c.span_id": callOf(tag, n),
    "graphql.operation.type": "query",
    "graphql.operation.name": OPERATIONS[n],
    ...(cut ? { "http.unfinished": true } : { "http.response.status_code": 200 }),
  };
  return call;
}

/** The gateway's trace of the view's `n`th operation, which called a remote service in turn. */
function gatewayTrace(tag: number, n: number, start: number, w3c: string): Doc {
  const traceId = id(tag, 10 + n);
  const upstream = span(
    `g${tag}-${n}`,
    `${traceId}r`,
    "http.client",
    "POST remote.example.test/graphql",
    start,
    80 * ms,
  );
  upstream["attrs"] = {
    "http.request.method": "POST",
    "url.full": "https://remote.example.test/graphql",
    "http.response.status_code": 200,
  };
  return trace(traceId, "http", `GraphQL query ${OPERATIONS[n]}`, start, 100 * ms, {
    attrs: {
      "service.name": "gateway",
      "w3c.trace_id": w3c,
      "w3c.parent_span_id": callOf(tag, n),
      "http.method": "POST",
      "http.route": "/graphql",
      "http.status_code": 200,
      "graphql.operation.type": "query",
      "graphql.operation.name": OPERATIONS[n],
    },
    spans: [upstream],
  });
}

async function ingest(traces: Doc[]): Promise<void> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(traces),
  });
  expect(response.status).toBe(202);
}

const stored = async (traceId: string) => (await fetch(`${CONSOLE}api/traces/${traceId}`)).status;

/** When the seeded views start: hours ago, each test's a minute apart, each run of it half a second later. */
const startOf = (tag: number) =>
  Number(process.env[RUN_STARTED] ?? Date.now()) * ms - 2 * 3_600_000_000 + tag * 60_000_000 + run() * 500_000;

/**
 * Stores what the browser sends for /sms (`path`) redirecting to /sms/campaigns: the view it left (no call, no time),
 * then the one it sent to, a moment later, with its three operations at once and the gateway's traces of them. The
 * ids of the two views.
 */
async function redirected(tag: number, path = "/sms"): Promise<{ from: string; to: string }> {
  const w3c = traceOf(tag);
  const start = startOf(tag);
  const at = start + 3 * ms;
  await ingest([view(id(tag, 0), path, start, 0, [], `${w3c.slice(0, 31)}0`)]);
  await expect.poll(() => stored(id(tag, 0))).toBe(200);
  const calls = OPERATIONS.map((_, n) => operationCall(tag, n, at + 10 * ms, 300 * ms, false));
  await ingest([
    view(id(tag, 1), `${path}/campaigns`, at, 400 * ms, calls, w3c),
    ...OPERATIONS.map((_, n) => gatewayTrace(tag, n, at + 20 * ms, w3c)),
  ]);
  await expect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${id(tag, 1)}/chain`)).json()) as Doc)["traces"])
    .toHaveLength(1 + OPERATIONS.length);
  return { from: id(tag, 0), to: id(tag, 1) };
}

test("the view an SPA redirected from at once leaves the store; the view it sent to says where it came from", async ({
  page,
}) => {
  // Paths of its own: the Pages list is the store's, where the other tests' /sms is a row until its next view comes.
  const path = `/mail${run()}`;
  const { from, to } = await redirected(1, path);

  await expect.poll(() => stored(from)).toBe(404);

  await page.goto(`/#/t/${to}`);

  await expect(page.locator(".tp-trace-head")).toContainText(`redirected from ${path}`);

  await page.goto("/#/pages?view=overview");
  const rows = page.getByRole("main").getByRole("table").last().getByRole("link");

  await expect(rows.filter({ hasText: `${path}/campaigns` })).toHaveCount(1);
  await expect(rows.filter({ hasText: new RegExp(`${path}(?![/\\d])`) })).toHaveCount(0);
});
