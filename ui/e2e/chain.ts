// A chain of calls across three apps, stored by the agent: a browser's view calls a GraphQL BFF, whose three
// Book.author steps each call a service, which runs one query each (an N+1 across apps) and logs in it.
import { expect, test } from "@playwright/test";
import { CONSOLE } from "./agent.ts";

type Doc = Record<string, unknown>;

const W3C = "4bf92f3577b34da6a3ce929d0e0e47c1";

/** A ULID of this test's own: 26 Crockford characters. */
const NUMBERS: Record<string, number> = { view: 1, bff: 2, api1: 11, api2: 12, api3: 13 };
const id = (name: string) => `01M4C4A1N5${String(NUMBERS[name.toLowerCase()]).padStart(16, "0")}`;

/** A trace of the chain by its role: the view, the BFF, a service's (`api1`…`api3`). */
export const chainTrace = (name: "view" | "bff" | "api1" | "api2" | "api3") => id(name);

function span(
  name: string,
  parent: string | null,
  kind: string,
  label: string,
  start: number,
  duration: number,
  attrs: Doc = {},
): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id: name, parent_id: parent, kind, name: label, start, duration, status: "ok", attrs };
}

function log(span: string | null, time: number, level: string, logger: string, message: string): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { span_id: span, time, level, logger, message, exception: null, attrs: {} };
}

function trace(
  name: string,
  label: string,
  app: string,
  start: number,
  duration: number,
  parent: string | null,
  spans: Doc[],
  logs: Doc[],
): Doc {
  const attrs: Doc = {
    "service.name": app,
    "w3c.trace_id": W3C,
    "http.method": label.split(" ")[0],
    "http.route": label.split(" ")[1],
  };
  if (parent) attrs["w3c.parent_span_id"] = parent;
  // The seed's apps, in their roles: the Services map keeps its boxes.
  if (app === "shop-web") attrs["service.role"] = "browser";
  return {
    id: id(name),
    kind: "http",
    name: label,
    start,
    duration,
    status: "ok",
    attrs,
    spans,
    logs,
    errors: [],
    links: [],
    issues: [],
  };
}

/** The view, the BFF (its clock 4 ms ahead) and the service's three traces, stored by the agent. */
export async function chain(): Promise<string> {
  // Hours ago: the other tests list the newest records and requests first.
  const start = Date.now() * 1000 - 6 * 3_600_000_000;
  const ahead = 4_000;
  const view = trace(
    "VIEW",
    "GET /shelf",
    "shop-web",
    start,
    10_000,
    null,
    [
      span("v0", null, "http", "GET /view", start, 10_000),
      span("v1", "v0", "http.client", "POST /graphql", start + 1_000, 8_000, { "w3c.span_id": "f000000000000001" }),
    ],
    [log(null, start + 500, "info", "console", "view loading")],
  );
  const b = start + 1_200 + ahead;
  const steps = [0, 1, 2].flatMap((n) => [
    span(`s${n}`, "b0", "function", "Book.author", b + 1_000 + n * 2_000, 1_500, { "graphql.field": "Book.author" }),
    span(`c${n}`, `s${n}`, "http.client", `GET /authors/${n + 1}`, b + 1_100 + n * 2_000, 1_200, {
      "w3c.span_id": `c00000000000000${n + 1}`,
    }),
  ]);
  const bff = trace(
    "BFF",
    "POST /graphql",
    "shop",
    b,
    7_600,
    "f000000000000001",
    [span("b0", null, "http", "POST /graphql", b, 7_600), ...steps],
    [
      log("b0", b + 100, "info", "yoga", "query Books"),
      log("b0", b + 1_050, "debug", "resolvers", "author step"),
      log("s1", b + 3_050, "info", "resolvers", "author 2 asked"),
      log("b0", b + 7_000, "warning", "yoga", "slow query"),
    ],
  );
  // Profiled, its samples timed (1 ms buckets from its start): the steps' time and the BFF's own.
  // biome-ignore-start lint/style/useNamingConvention: the trace format.
  bff["profile"] = {
    interval_us: 1_000,
    samples: 7,
    bucket_us: 1_000,
    frames: [
      { function: "handleGraphql", file: "server.js", line: 90, in_app: true },
      { function: "resolveAuthor", file: "server.js", line: 70, in_app: true },
      { function: "fetch", file: "node:internal/deps/undici", line: 1, in_app: false, waiting: true },
    ],
    stacks: [
      {
        frames: [0],
        count: 2,
        at: [
          [0, 1],
          [7, 1],
        ],
      },
      {
        frames: [0, 1],
        count: 2,
        at: [
          [1, 1],
          [3, 1],
        ],
      },
      {
        frames: [0, 1, 2],
        count: 3,
        at: [
          [2, 1],
          [4, 1],
          [6, 1],
        ],
      },
    ],
  };
  // biome-ignore-end lint/style/useNamingConvention: the trace format.
  const apis = [0, 1, 2].map((n) => {
    const at = b + 1_200 + n * 2_000 - ahead;
    const api = trace(
      `API${n + 1}`,
      `GET /authors/${n + 1}`,
      "shop",
      at,
      1_000,
      `c00000000000000${n + 1}`,
      [
        span(`a${n}`, null, "http", `GET /authors/${n + 1}`, at, 1_000),
        // Its statement as the SDKs record it: a SELECT, which EXPLAIN runs for.
        span(`q${n}`, `a${n}`, "sql", "SELECT author", at + 200, 300, {
          "db.statement": "SELECT author",
          "db.vendor": "postgresql",
        }),
      ],
      [log(`q${n}`, at + 300, n === 1 ? "error" : "info", "app.db", n === 1 ? "no author 2" : `author ${n + 1}`)],
    );
    // One route for the three: the BFF's step calls it once per book.
    (api["attrs"] as Doc)["http.route"] = "/authors/{id}";
    (api["attrs"] as Doc)["http.path"] = `/authors/${n + 1}`;
    // Profiled too, its samples not timed: the service's own process, its own flame.
    // biome-ignore-start lint/style/useNamingConvention: the trace format.
    api["profile"] = {
      interval_us: 1_000,
      samples: 1,
      frames: [{ function: "get_author", file: "app/main.py", line: 115, in_app: true }],
      stacks: [{ frames: [0], count: 1 }],
    };
    // biome-ignore-end lint/style/useNamingConvention: the trace format.
    return api;
  });
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([view, bff, ...apis]),
  });
  expect(response.status).toBe(202);
  await expect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${id("VIEW")}/chain`)).json()) as Doc)["traces"])
    .toHaveLength(5);
  return id("VIEW");
}

/** One call a fan-out's BFF makes: its route and actual path, when it starts (µs after the BFF's), what it calls. */
export interface FanoutCall {
  route: string;
  path: string;
  at: number;
  /** Another app's trace this one's call served, in turn. */
  calls?: { app: string; route: string; path: string } | undefined;
}

/**
 * A BFF whose calls a service serves, one trace each, its clock 3 ms behind, sent in the reverse order: the list puts
 * them in the order they started on the BFF's clock. Both are the seed's "shop", as in `chain()`: a link to another
 * app would change the Services map the other tests read. `tag` keeps each test's traces apart (1…99). Returns the
 * BFF's id.
 */
export async function fanout(tag: number, calls: readonly FanoutCall[]): Promise<{ bff: string }> {
  const w3c = `5a${String(tag).padStart(30, "0")}`;
  const fid = (n: number) => `01M4C4A1N6${String(tag * 10_000 + n).padStart(16, "0")}`;
  const sid = (n: number) => `${String(tag).padStart(4, "0")}${String(n).padStart(12, "0")}`;
  const start = Date.now() * 1000 - 7 * 3_600_000_000;
  const behind = 3_000;
  const end = Math.max(...calls.map((call) => call.at)) + 2_000;
  const bff = linked(fid(0), w3c, "POST /graphql", start, end, null);
  bff["spans"] = [
    span("b0", null, "http", "POST /graphql", start, end),
    ...calls.map((call, n) =>
      span(`c${n}`, "b0", "http.client", `GET ${call.path}`, start + call.at, 900, { "w3c.span_id": sid(n + 1) }),
    ),
  ];
  const served = calls.flatMap((call, n) => {
    const at = start + call.at + 100 - behind;
    const api = linked(fid(n + 1), w3c, `GET ${call.route}`, at, 700, sid(n + 1), call.path);
    api["spans"] = [
      span(`a${n}`, null, "http", `GET ${call.route}`, at, 700),
      span(`q${n}`, `a${n}`, "sql", "SELECT 1", at + 100, 200),
      ...(call.calls
        ? [span(`d${n}`, `a${n}`, "http.client", "GET", at + 400, 200, { "w3c.span_id": sid(5000 + n) })]
        : []),
    ];
    if (!call.calls) return [api];
    const route = `GET ${call.calls.route}`;
    const deep = linked(fid(5000 + n), w3c, route, at + 450, 100, sid(5000 + n), call.calls.path, call.calls.app);
    deep["spans"] = [span(`e${n}`, null, "http", `GET ${call.calls.route}`, at + 450, 100)];
    return [api, deep];
  });
  await send([bff, ...served.reverse()]);
  await expect.poll(() => chainLength(fid(0))).toBe(1 + served.length);
  return { bff: fid(0) };
}

/** A trace of the W3C trace `w3c`, by its id: a BFF's (no parent) or the trace a service served for its call. */
function linked(
  id: string,
  w3c: string,
  label: string,
  start: number,
  duration: number,
  parent: string | null,
  path?: string,
  app = "shop",
): Doc {
  const doc = trace("x", label, app, start, duration, parent, [], []);
  doc["id"] = id;
  const attrs = doc["attrs"] as Doc;
  attrs["w3c.trace_id"] = w3c;
  if (path) attrs["http.path"] = path;
  return doc;
}

/** A call the BFF of `arriving()` makes: where to, and how long before now it ended (µs; a moment ago unless given). */
export interface ArrivingCall {
  url: string;
  ago?: number | undefined;
}

/**
 * A BFF's request that just ended, its calls to other apps carrying the trace on (`calls`), stored before any of
 * their traces: the agent has only it, as when a service's trace comes a moment after its caller's. `serve(n)` stores
 * the n-th call's trace, as that service's SDK would send it. Hours ago, as `fanout()` (the other tests list the
 * newest first), all of it "shop" (the Services map stays): `now` is the moment it ended, for the browser's clock.
 * `tag` keeps tests apart (1…99), and each run of a test (a repeat, a retry) has ids of its own: the agent of a run
 * keeps what an earlier one served, and a call whose trace is already there doesn't wait.
 */
export async function arriving(
  tag: number,
  calls: readonly ArrivingCall[],
): Promise<{ bff: string; now: number; serve: (n: number) => Promise<void> }> {
  const { repeatEachIndex, retry } = test.info();
  const run = tag * 10_000 + repeatEachIndex * 10 + retry;
  const w3c = `6b${String(run).padStart(30, "0")}`;
  const fid = (n: number) => `01M4C4A1N7${String(run * 100 + n).padStart(16, "0")}`;
  const sid = (n: number) => `${String(run).padStart(8, "0")}${String(n).padStart(8, "0")}`;
  const now = (Date.now() - 8 * 3_600_000) * 1000;
  const spans = calls.map((call, n) => {
    // Each ends a moment before `now` (`ago` earlier still); the request 50 ms after its last.
    const end = now - (call.ago ?? 0) - 100_000;
    // One after another, each well before the next: its trace's row comes before the next call's.
    const at = end - 200_000 + 20_000 * n;
    const path = new URL(call.url).pathname;
    return span(`c${n}`, "b0", "http.client", `GET ${path}`, at, end - at, {
      "http.method": "GET",
      "url.full": call.url,
      "w3c.span_id": sid(n + 1),
    });
  });
  // The request around its calls.
  const start = Math.min(...spans.map((call) => call["start"] as number)) - 50_000;
  const end = Math.max(...spans.map((call) => (call["start"] as number) + (call["duration"] as number))) + 50_000;
  const bff = linked(fid(0), w3c, "POST /graphql", start, end - start, null);
  bff["spans"] = [span("b0", null, "http", "POST /graphql", start, end - start), ...spans];
  await send([bff]);
  const serve = async (n: number) => {
    const call = spans[n] as Doc;
    const path = new URL((calls[n] as ArrivingCall).url).pathname;
    const api = linked(fid(n + 1), w3c, `GET ${path}`, (call["start"] as number) + 1_000, 50_000, sid(n + 1), path);
    api["spans"] = [span(`a${n}`, null, "http", `GET ${path}`, api["start"] as number, 50_000)];
    const before = await chainLength(fid(0));
    await send([api]);
    await expect.poll(() => chainLength(fid(0))).toBe(before + 1);
  };
  await expect.poll(() => chainLength(fid(0))).toBe(1);
  return { bff: fid(0), now: now / 1000, serve };
}

async function send(traces: Doc[]): Promise<void> {
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(traces),
  });
  expect(response.status).toBe(202);
}

async function chainLength(id: string): Promise<number> {
  const response = await fetch(`${CONSOLE}api/traces/${id}/chain`);
  return response.ok ? (((await response.json()) as Doc)["traces"] as unknown[]).length : 0;
}
