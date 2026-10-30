// A browser's view whose calls went through a GraphQL gateway that sends its traces over OTLP (Apollo Router): one
// gateway trace per operation the page asked, most of them answered by remote services that record no trace, one by a
// local subgraph, which calls a REST service that runs three queries and logs. Each view stored under ids of its own.
import { expect } from "@playwright/test";
import { CONSOLE, RUN_STARTED } from "./agent.ts";

type Doc = Record<string, unknown>;

const ms = 1_000;

/** The subgraph's record printed as a table: its first line, a border with no words. */
export const GATEWAY_TABLE = { border: "├───────────┬──────────────┤", words: "│ operation │" };

function span(id: string, parent: string | null, kind: string, name: string, start: number, duration: number): Doc {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  return { id, parent_id: parent, kind, name, start, duration, status: "ok", attrs: {} as Doc };
}

/** A call carrying the trace on (`w3c`) to `url`, answered 200. */
function call(id: string, parent: string, url: string, method: string, start: number, duration: number, w3c: string) {
  const { host, pathname } = new URL(url);
  return {
    ...span(id, parent, "http.client", `${method} ${host}${pathname}`, start, duration),
    attrs: {
      "http.request.method": method,
      "url.full": url,
      "http.response.status_code": 200,
      "w3c.span_id": w3c,
    },
  };
}

/** A finding of a trace, on its span `span`. */
function issue(kind: string, fingerprint: string, title: string, span: string): Doc {
  // biome-ignore-start lint/style/useNamingConvention: the trace format.
  return { fingerprint, fingerprint_version: 1, kind, title, culprit: null, hint: null, count: 1, span_ids: [span] };
  // biome-ignore-end lint/style/useNamingConvention: the trace format.
}

function trace(id: string, kind: string, name: string, app: string, start: number, duration: number, extra: Doc): Doc {
  return {
    id,
    kind,
    name,
    start,
    duration,
    status: "ok",
    logs: [],
    errors: [],
    links: [],
    issues: [],
    ...extra,
    attrs: { "service.name": app, ...(extra["attrs"] as Doc) },
    spans: [span(`${id}r`, null, kind, name, start, duration), ...((extra["spans"] as Doc[] | undefined) ?? [])],
  };
}

export interface GatewayView {
  /** The view's trace id. */
  view: string;
  /** The gateway's trace ids, one per operation, in order. */
  gateway: string[];
  subgraph: string;
  rest: string;
}

/**
 * Stores a view that asked the gateway for `operations` in turn (`tag` keeps its ids apart): each operation a remote
 * service answers, slowly (a slow HTTP call, the same one each time it is asked), but the last, which the local
 * subgraph serves, calling the REST service (three of one query, an N+1, and a log record).
 */
export async function gatewayView(tag: number, operations: readonly string[]): Promise<GatewayView> {
  const id = (n: number) => `01M4GATEWAY${String(tag).padStart(3, "0")}${String(n).padStart(12, "0")}`;
  const w3c = `${String(tag).padStart(4, "0")}aa7e9d0f4e3a8b5c7d9e1f2a3b4c`;
  const hex = (kind: string, n: number) => `${kind}${String(n).padStart(15, "0")}`;
  const start = Number(process.env[RUN_STARTED] ?? Date.now()) * ms - 3 * 3_600_000_000 + tag * 60_000_000;
  const last = operations.length - 1;
  const at = (n: number) => start + 20 * ms + n * 1_000 * ms;
  const view = trace(id(0), "page", "/app/", "shop-web", start, (operations.length + 1) * 1_000 * ms, {
    attrs: { "service.role": "browser", "page.path": "/app/", "w3c.trace_id": w3c },
    spans: operations.map((_, n) =>
      call(`v${n}`, `${id(0)}r`, "http://127.0.0.1:4000/graphql", "POST", at(n), 900 * ms, hex("a", n)),
    ),
  });
  const gateway = operations.map((operation, n) => {
    const remote = n !== last;
    const upstream = remote
      ? call(
          `g${n}c`,
          `${id(n + 1)}r`,
          "https://remote.example.test/graphql",
          "POST",
          at(n) + 50 * ms,
          700 * ms,
          hex("b", n),
        )
      : call(`g${n}c`, `${id(n + 1)}r`, "http://127.0.0.1:4001/", "POST", at(n) + 50 * ms, 700 * ms, hex("b", n));
    return trace(id(n + 1), "http", `GraphQL ${operation}`, "gateway", at(n) + 10 * ms, 800 * ms, {
      attrs: {
        "w3c.trace_id": w3c,
        "w3c.parent_span_id": hex("a", n),
        "http.method": "POST",
        "http.route": "/graphql",
        "http.status_code": 200,
      },
      spans: [upstream],
      // Each remote answer is slow, the same finding each time; the second operation also waits on its own.
      issues: remote
        ? [
            issue("slow-http", "remote-slow", "Slow HTTP call · POST remote.example.test/graphql", `g${n}c`),
            ...(n === 1 ? [issue("slow-call", "profile-wait", "Slow call · profile", `g${n}c`)] : []),
          ]
        : [],
    });
  });
  const subgraphId = id(90);
  const restId = id(91);
  const sub = at(last) + 60 * ms;
  const subgraph = trace(subgraphId, "http", `GraphQL ${operations[last]}`, "subgraph", sub, 680 * ms, {
    attrs: {
      "w3c.trace_id": w3c,
      "w3c.parent_span_id": hex("b", last),
      "http.method": "POST",
      "http.route": "/",
      "http.status_code": 200,
    },
    spans: [call("s0", `${subgraphId}r`, "http://127.0.0.1:4002/items", "GET", sub + 20 * ms, 600 * ms, hex("c", 0))],
    // A record printed as a table: its first line a border.
    logs: [
      {
        // biome-ignore lint/style/useNamingConvention: the trace format.
        span_id: null,
        time: sub + 10 * ms,
        level: "info",
        logger: "subgraph",
        message: `${GATEWAY_TABLE.border}\n│ operation │ ${operations[last]} │\n└───────────┴──────────────┘`,
        attrs: {},
      },
    ],
  });
  const queries = [0, 1, 2].map((q) => ({
    ...span(`q${q}`, `${restId}r`, "sql", "SELECT items", sub + 40 * ms + q * 20 * ms, 10 * ms),
    attrs: { "db.statement": `SELECT * FROM items WHERE owner_id = ${q + 1}`, "db.system": "postgresql" },
  }));
  const rest = trace(restId, "http", "GET /items", "shop", sub + 30 * ms, 580 * ms, {
    attrs: {
      "w3c.trace_id": w3c,
      "w3c.parent_span_id": hex("c", 0),
      "http.method": "GET",
      "http.route": "/items",
      "http.path": "/items",
      "http.status_code": 200,
    },
    spans: queries,
    issues: [
      issue("n+1", "items-n1", "N+1: similar queries · SELECT items", "q0"),
      issue("slow-sql", "items-slow", "Slow query · SELECT items", "q2"),
    ],
    logs: [
      // biome-ignore lint/style/useNamingConvention: the trace format.
      { span_id: null, time: sub + 35 * ms, level: "info", logger: "items", message: "Listing items", attrs: {} },
    ],
  });
  const traces = [view, ...gateway, subgraph, rest];
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(traces),
  });
  expect(response.status).toBe(202);
  await expect
    .poll(async () => ((await (await fetch(`${CONSOLE}api/traces/${id(0)}/chain`)).json()) as Doc)["traces"])
    .toHaveLength(traces.length);
  return { view: id(0), gateway: gateway.map((each) => String(each["id"])), subgraph: subgraphId, rest: restId };
}
