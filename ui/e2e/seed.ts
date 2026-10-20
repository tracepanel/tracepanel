// What the console shows in the tests: the traces in schema/examples (as the SDKs send them: N+1, errors, slow SQL,
// htmx...), and some made here for what those don't have: a page's view and actions in the browser, a task and a
// job. Sent to the agent as a page sends its traces (POST /api/ingest), moved to the last few minutes so the
// console's default period shows them.
import { readdirSync, readFileSync } from "node:fs";
import { CONSOLE } from "./agent.ts";

type Doc = Record<string, unknown>;

const EXAMPLES = new URL("../../schema/examples/", import.meta.url);
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// A minute apart, from this long ago: newest last, all inside the console's default period.
const SPREAD_US = 60_000_000;

// The section of /api/counts that counts a trace of each kind.
const SECTIONS: Record<string, string> = { http: "http", page: "pages", task: "tasks", command: "jobs" };

let sequence = 0;

/** A ULID, as the SDKs make trace ids: the time, then a counter where the randomness goes. */
function ulid(ms: number): string {
  let time = BigInt(ms);
  let random = BigInt(++sequence);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(random & 31n)] + out;
    random >>= 5n;
  }
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[Number(time & 31n)] + out;
    time >>= 5n;
  }
  return out;
}

/** Every time in a trace (its start, its spans', logs' and errors' times) moved by `delta` microseconds. */
function shift(value: unknown, delta: number): unknown {
  if (Array.isArray(value)) return value.map((item) => shift(item, delta));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) =>
      (key === "start" || key === "time") && typeof item === "number" ? [key, item + delta] : [key, shift(item, delta)],
    ),
  );
}

// biome-ignore-start lint/style/useNamingConvention: traces as the SDKs send them; their field names are the wire format.
function trace(kind: string, name: string, attrs: Doc, extra: Partial<Doc> = {}): Doc {
  const id = ulid(Date.now());
  return {
    id,
    kind,
    name,
    start: 0,
    duration: 42_000,
    status: "ok",
    attrs,
    spans: [{ id: `${id}R`, parent_id: null, kind, name, start: 0, duration: 42_000, status: "ok", attrs: {} }],
    logs: [],
    errors: [],
    links: [],
    issues: [],
    ...extra,
  };
}

const BROWSER = { "service.name": "shop-web", "service.role": "browser", "telemetry.sdk.language": "webjs" };

/** A page's view, an action on it that called the API, and one whose call failed: the Pages section's rows. */
function pages(): Doc[] {
  const view = trace("page", "/books", { ...BROWSER, "page.path": "/books", "page.trigger": "load" });
  const save = trace("page", '/books › click "Save"', {
    ...BROWSER,
    "page.path": "/books",
    "page.trigger": "click",
    "page.action": 'click "Save"',
  });
  const call = (status: number): Doc => ({
    id: `${save["id"]}C${status}`,
    parent_id: `${save["id"]}R`,
    kind: "http.client",
    name: "GET 127.0.0.1/api/books",
    start: 1_000,
    duration: 30_000,
    status: status >= 500 ? "error" : "ok",
    attrs: {
      "http.request.method": "GET",
      "url.full": "http://127.0.0.1:8028/api/books",
      "http.response.status_code": status,
    },
  });
  (save["spans"] as Doc[]).push(call(200));
  const broken = trace(
    "page",
    '/books › click "Delete"',
    { ...BROWSER, "page.path": "/books", "page.trigger": "click", "page.action": 'click "Delete"' },
    { status: "error" },
  );
  (broken["spans"] as Doc[]).push({ ...call(500), id: `${broken["id"]}C500`, parent_id: `${broken["id"]}R` });
  return [view, save, broken];
}

/** A request that published a message per book, and the listener's run of each, delivered from it. */
function messages(): Doc[] {
  const announce = trace("http", "POST /api/books/announce", {
    "service.name": "shop",
    "http.method": "POST",
    "http.path": "/api/books/announce",
    "http.route": "/api/books/announce",
    "http.status_code": 202,
  });
  const id = String(announce["id"]);
  for (const n of [1, 2, 3]) {
    (announce["spans"] as Doc[]).push({
      id: `${id}P${n}`,
      parent_id: `${id}R`,
      kind: "rabbitmq",
      name: "publish book-announcements",
      start: n * 1_000,
      duration: 500,
      status: "ok",
      attrs: {
        "messaging.system": "rabbitmq",
        "messaging.operation": "publish",
        "messaging.destination.name": "book-announcements",
        "messaging.rabbitmq.destination.routing_key": "book-announcements",
        "code.origin": "src/main/java/shop/BookEvents.java:31 in announce",
      },
    });
  }
  (announce["spans"] as Doc[]).push({
    id: `${id}K`,
    parent_id: `${id}R`,
    kind: "kafka",
    name: "publish book-events",
    start: 5_000,
    duration: 700,
    status: "ok",
    attrs: {
      "messaging.system": "kafka",
      "messaging.operation": "publish",
      "messaging.destination.name": "book-events",
      "messaging.kafka.partition": 2,
      "messaging.kafka.offset": 41,
      "server.address": "localhost",
      "server.port": 9092,
    },
  });
  // The broker's client logs as it connects: inside the publish, and the request's own line outside every call.
  announce["logs"] = [
    {
      span_id: `${id}K`,
      time: 5_100,
      level: "info",
      logger: "org.apache.kafka",
      message: "Kafka producer started",
      exception: null,
      // Out of order on purpose, as an SDK may send them: every view lists them the same way.
      attrs: {
        "thread.name": "kafka-producer-network-thread",
        "code.function": "send",
        "code.lineno": 42,
        "code.filepath": "shop/events.py",
      },
    },
    {
      span_id: `${id}R`,
      time: 6_000,
      level: "info",
      logger: "shop.books",
      message: "3 books announced",
      exception: null,
      attrs: {},
    },
  ];
  // A span whose parent never arrived (cut by a limit, lost on the way): the call tree still shows it.
  (announce["spans"] as Doc[]).push({
    id: `${id}O`,
    parent_id: "gone",
    kind: "function",
    name: "orphan block",
    start: 6_000,
    duration: 500,
    status: "ok",
    attrs: {},
  });
  const delivered = [1, 2, 3].map((n) =>
    trace(
      "task",
      "BookEvents.onAnnounced",
      { "service.name": "shop", "task.system": "rabbitmq", "task.queue": "book-announcements" },
      { links: [{ kind: "sent_by", trace_id: id, span_id: `${id}P${n}` }] },
    ),
  );
  return [announce, ...delivered];
}

/** A task a worker ran and a job a command ran: the Tasks and Jobs sections. */
function background(): Doc[] {
  const worker = { "service.name": "shop", "service.role": "worker", "telemetry.sdk.language": "python" };
  const log = (logger: string, message: string): Doc => ({
    // biome-ignore lint/style/useNamingConvention: a log record as the SDKs send it.
    span_id: null,
    time: 1_000,
    level: "info",
    logger,
    message,
    exception: null,
    attrs: {},
  });
  const task = trace(
    "task",
    "shop.tasks.send_receipt",
    { ...worker, "task.id": "t-1", "task.state": "SUCCESS" },
    { logs: [log("shop.tasks", "receipt sent to ann@example.com")] },
  );
  const job = trace(
    "command",
    "manage.py rebuild_index",
    { "service.name": "shop", "service.role": "command", "telemetry.sdk.language": "python" },
    { logs: [log("shop.index", "index rebuilt: 120 books")] },
  );
  return [task, job];
}

/** A report on a replica with a long name: a long transaction and slow queries, each with its alias and issue chip. */
function report(): Doc {
  const alias = "FANSIFTER_APP_REPORTING/QA";
  const doc = trace("http", "PATCH /campaigns/{id}/report", {
    "service.name": "shop",
    "http.method": "PATCH",
    "http.path": "/campaigns/7/report",
    "http.route": "/campaigns/{id}/report",
    "http.status_code": 200,
  });
  const id = doc["id"] as string;
  const span = (
    suffix: string,
    parent: string,
    kind: string,
    name: string,
    start: number,
    duration: number,
    attrs: Doc,
  ) => ({
    id: `${id}${suffix}`,
    // biome-ignore lint/style/useNamingConvention: a span as the SDKs send it.
    parent_id: `${id}${parent}`,
    kind,
    name,
    start,
    duration,
    status: "ok",
    attrs,
  });
  const select = (index: number, start: number, duration: number) =>
    span(`Q${index}`, "T", "sql", `SELECT campaign_stats_${index}`, start, duration, {
      "db.alias": alias,
      "db.system": "postgresql",
      "db.statement": `SELECT * FROM campaign_stats_${index} WHERE campaign_id = %s`,
      "code.origin": "campaigns/reports.py:40 in build",
    });
  return {
    ...doc,
    duration: 5_900_000,
    spans: [
      { ...(doc["spans"] as Doc[])[0], duration: 5_900_000 },
      span("V", "R", "view", "campaigns.api.report", 0, 5_900_000, {}),
      span("T", "V", "transaction", "transaction", 100_000, 4_100_000, { "db.alias": alias }),
      select(1, 200_000, 428_000),
      select(2, 700_000, 371_000),
      select(3, 1_100_000, 363_000),
      select(4, 1_500_000, 245_000),
    ],
  };
}

function examples(): Doc[] {
  return readdirSync(EXAMPLES)
    .filter((file) => file.endsWith(".json") && file !== "expected.json")
    .sort()
    .map((file) => JSON.parse(readFileSync(new URL(file, EXAMPLES), "utf8")) as Doc);
}

/** What /api/counts should say once every trace is stored: how many of each section's traces were sent. */
function expectedCounts(docs: readonly Doc[]): Record<string, number> {
  const expected: Record<string, number> = {};
  for (const doc of docs) {
    const section = SECTIONS[String(doc["kind"])] ?? "http";
    expected[section] = (expected[section] ?? 0) + 1;
  }
  return expected;
}

/** The agent takes a batch, then stores it: wait until every section counts all of its traces. */
async function stored(expected: Record<string, number>): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const counts = (await (await fetch(`${CONSOLE}api/counts`)).json()) as { sections: Record<string, unknown> };
    if (Object.entries(expected).every(([section, count]) => Number(counts.sections[section] ?? 0) >= count))
      return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** A request whose SDK dropped spans and records over its limits. */
function late(): Doc {
  return trace("http", "GET /api/clock", {
    "service.name": "shop",
    "http.method": "GET",
    "http.path": "/api/clock",
    "http.route": "/api/clock",
    "http.status_code": 200,
    "tracepanel.dropped_spans": 501,
    "tracepanel.dropped_logs": 1503,
  });
}

const SHOP = { "service.name": "shop", "telemetry.sdk.language": "python" };

/**
 * A sign-in form's POST, answered with a redirect, as the Python SDK records what a request carried: its headers
 * (the browser's own among them), query, form body, cookies, session, and the response's headers.
 */
function signIn(): Doc {
  return trace("http", "POST /accounts/login/", {
    ...SHOP,
    "http.method": "POST",
    "http.path": "/accounts/login/",
    "http.route": "/accounts/login/",
    "http.status_code": 302,
    "code.view": "accounts.views.login",
    "url.query": "next=/orders/",
    "http.request.header.host": "127.0.0.1:8000",
    "http.request.header.origin": "http://127.0.0.1:8000",
    "http.request.header.content_type": "application/x-www-form-urlencoded",
    "http.request.header.accept": "text/html",
    "http.request.header.accept_language": "en-GB",
    "http.request.header.user_agent": "Mozilla/5.0",
    "http.request.header.sec_fetch_mode": "navigate",
    "http.request.body": "csrfmiddlewaretoken=********&username=ann&password=********",
    "http.request.cookie.csrftoken": "********",
    "http.request.cookie.theme": "dark",
    "session._auth_user_id": "7",
    "http.response.header.location": "/orders/",
    "http.response.header.set_cookie": "********",
  });
}

/** A request profiled by its sampler: most of its time in the ORM, under a function of the project's own. */
function profiled(): Doc {
  const frame = (fn: string, module: string, file: string, line: number, inApp: boolean) => ({
    function: fn,
    module,
    file,
    line,
    in_app: inApp,
  });
  return trace(
    "http",
    "GET /reports/sales",
    {
      ...SHOP,
      "http.method": "GET",
      "http.path": "/reports/sales",
      "http.route": "/reports/sales",
      "http.status_code": 200,
    },
    {
      duration: 120_000,
      profile: {
        interval_us: 1_000,
        samples: 100,
        frames: [
          frame("WSGIHandler.__call__", "django.core.handlers.wsgi", "django/core/handlers/wsgi.py", 124, false),
          frame("sales", "reports.views", "reports/views.py", 18, true),
          frame("totals", "reports.queries", "reports/queries.py", 42, true),
          frame(
            "SQLCompiler.execute_sql",
            "django.db.models.sql.compiler",
            "django/db/models/sql/compiler.py",
            1574,
            false,
          ),
          frame("Template.render", "django.template.base", "django/template/base.py", 171, false),
        ],
        stacks: [
          { frames: [0, 1, 2, 3], count: 60 },
          { frames: [0, 1, 4], count: 30 },
          { frames: [0, 1], count: 10 },
        ],
      },
    },
  );
}

/** A page of a library's own (an admin's list): its queries are made by no code of the project's. */
function adminList(): Doc {
  const doc = trace("http", "GET /admin/users/", {
    ...SHOP,
    "http.method": "GET",
    "http.path": "/admin/users/",
    "http.route": "/admin/users/",
    "http.status_code": 200,
  });
  const id = String(doc["id"]);
  const count = (index: number, caller: string) => ({
    id: `${id}C${index}`,
    parent_id: `${id}R`,
    kind: "sql",
    name: "SELECT COUNT auth_user",
    start: index * 1_000,
    duration: 500,
    status: "ok",
    attrs: {
      "db.alias": "default",
      "db.system": "sqlite",
      "db.statement": 'SELECT COUNT(*) AS "__count" FROM "auth_user"',
      "code.origin": null,
      "code.caller": caller,
    },
  });
  (doc["spans"] as Doc[]).push(
    count(1, "django/core/paginator.py:110 in Paginator.count"),
    count(2, "django/contrib/admin/views/main.py:320 in ChangeList.get_results"),
  );
  return doc;
}

// biome-ignore-end lint/style/useNamingConvention: traces as the SDKs send them; their field names are the wire format.

export default async function seed(): Promise<void> {
  const docs = [...examples(), ...pages(), ...background(), ...messages(), report(), signIn(), profiled(), adminList()];
  const first = Date.now() * 1000 - SPREAD_US * (docs.length + 1);
  const moved = docs.map((doc, index) => shift(doc, first + index * SPREAD_US - Number(doc["start"])) as Doc);
  // A trace from an app whose clock is two hours behind, and that went over the limits: the oldest of all, so no list
  // opens on it.
  moved.push(shift(late(), first - 2 * 3_600_000_000) as Doc);
  const response = await fetch(`${CONSOLE}api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(moved),
  });
  if (response.status !== 202) throw new Error(`seeding the agent: ${response.status} ${await response.text()}`);
  if (!(await stored(expectedCounts(moved))))
    throw new Error(`seeding the agent: ${moved.length} sent, not all stored`);
}
