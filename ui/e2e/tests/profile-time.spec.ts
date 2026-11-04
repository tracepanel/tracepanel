// The one rule a trace's time is split by (lib/timeShares, said by lib/split), over a trace shaped like a FastAPI sync endpoint's: a
// view whose transaction runs a query, the event loop waiting while a worker thread runs the endpoint, a collector's
// pause, a bucket the cleanup alone was seen in. The time strip's legend, the Profile tab's bar and list and the call
// tree's code rows all read it: for the same stretch they say the same shares, a code row's time is its profile's.

import { duration } from "../../packages/ui/src/format.ts";
import { apportion } from "../../packages/ui/src/lib/percent.ts";
import { allFrames, functions, ownCode, type Profile, packageTimes } from "../../packages/ui/src/lib/profile.ts";
import { parseStretch, stretchText, type Windows, windowsLabel } from "../../packages/ui/src/lib/slice.ts";
import { splitOf } from "../../packages/ui/src/lib/split.ts";
import { type Shared, spanSegments, windowsOfSegments } from "../../packages/ui/src/lib/timeShares.ts";
import type { Timed } from "../../packages/ui/src/lib/waiting.ts";
import { windowProfile } from "../../packages/ui/src/lib/windowProfile.ts";
import { expect, test } from "../fixtures.ts";

const frame = (fn: string, module: string, file: string, extra: { inApp?: boolean; waiting?: boolean } = {}) => ({
  function: fn,
  module,
  file,
  line: 1,
  // biome-ignore lint/style/useNamingConvention: a frame as the SDKs send it.
  in_app: extra.inApp ?? false,
  ...(extra.waiting ? { waiting: true } : {}),
});

/**
 * The loop waits for the worker (0, 1), which runs get_author (3) waiting for the pool's connection (5) and on its
 * socket (6); the dependency's exit waits (7); the worker runs get_db's cleanup (10, 11), alone in 90–100 ms.
 */
const PROFILE: Timed = {
  // biome-ignore lint/style/useNamingConvention: the trace format.
  interval_us: 1000,
  // biome-ignore lint/style/useNamingConvention: the trace format.
  bucket_us: 10_000,
  samples: 105,
  frames: [
    frame("run_endpoint_function", "fastapi.routing", "fastapi/routing.py"),
    frame("AsyncIOBackend.run_sync_in_worker_thread", "anyio._backends._asyncio", "anyio/_backends/_asyncio.py", {
      waiting: true,
    }),
    frame("AsyncIOBackend.run_sync_in_worker_thread", "anyio._backends._asyncio", "anyio/_backends/_asyncio.py"),
    frame("get_author", "app.main", "app/main.py", { inApp: true }),
    frame("Session.get", "sqlalchemy.orm.session", "sqlalchemy/orm/session.py"),
    { ...frame("waiter.acquire", "", "", { waiting: true }), module: null },
    frame("Connection.wait", "psycopg.connection", "psycopg/connection.py"),
    frame("_AsyncGeneratorContextManager.__aexit__", "contextlib", "contextlib.py", { waiting: true }),
    frame("Thread._bootstrap", "threading", "threading.py"),
    frame("WorkerThread.run", "anyio._backends._asyncio", "anyio/_backends/_asyncio.py"),
    frame("get_db", "app.db", "app/db.py", { inApp: true }),
    frame("Connection.rollback", "psycopg.connection", "psycopg/connection.py"),
  ],
  stacks: [
    { frames: [0, 1], count: 4, at: [[0, 4]] },
    {
      frames: [0, 2, 3, 4, 5],
      count: 25,
      at: [
        [1, 9],
        [2, 10],
        [3, 6],
      ],
    },
    {
      frames: [0, 2, 3, 4, 6],
      count: 30,
      at: [
        [3, 4],
        [4, 8],
        [5, 9],
        [6, 9],
      ],
    },
    {
      frames: [7],
      count: 30,
      at: [
        [0, 6],
        [7, 8],
        [8, 5],
        [10, 11],
      ],
    },
    { frames: [8, 9, 10, 11], count: 6, at: [[9, 6]] },
  ],
  // biome-ignore lint/style/useNamingConvention: the trace format.
  gc: { collections: 1, pause_us: 2000, pauses: [[12_000, 2000, 0]] },
};

const span = (id: string, parent: string | null, kind: string, name: string, start: number, duration: number) => ({
  id,
  // biome-ignore lint/style/useNamingConvention: the trace format.
  parent_id: parent,
  kind,
  name,
  start,
  duration,
  status: "ok",
  attrs: kind === "sql" ? { "db.system": "postgresql" } : {},
});

/** GET /authors/6: its view, a transaction (38 ms to `ends`) and its query (45–78 ms). */
function trace(ends: number): Shared & { profile: Timed } {
  return {
    kind: "http",
    start: 0,
    duration: 108_000,
    attrs: {},
    spans: [
      span("r", null, "http", "GET /authors/{author_id}", 0, 108_000),
      span("v", "r", "view", "app.main.get_author", 0, 108_000),
      span("t", "v", "transaction", "transaction", 38_000, ends - 38_000),
      span("q", "t", "sql", "SELECT author", 45_000, 33_000),
    ],
    profile: PROFILE,
  } as unknown as Shared & { profile: Timed };
}

/** The strip's shares, by the Profile tab's names. */
const PROFILE_NAMES: Record<string, string> = {
  code: "your code",
  waiting: "waiting",
  sql: "Database",
  gc: "GC",
  django: "Framework & middleware",
};

/** The strip's legend over the windows: each share's time (µs), by the Profile tab's name for it. */
function strip(traced: Shared, windows: Windows | null): Record<string, number> {
  return Object.fromEntries(
    splitOf(traced, windows).shares.map((share) => [PROFILE_NAMES[share.share] ?? share.share, share.us]),
  );
}

/** The Profile tab's bar over the windows, Your code's: each share's time (µs). */
function bar(profile: Profile): Record<string, number> {
  return Object.fromEntries(
    packageTimes(ownCode(profile)).map((share) => [share.name, Math.round(share.samples * profile.interval_us)]),
  );
}

/** The Profile tab's list, Your code's: each function's own time (µs), by name. */
function list(profile: Profile): Record<string, number> {
  return Object.fromEntries(
    functions(ownCode(profile))
      .filter((row) => row.self > 0)
      .map((row) => [row.frame.function, Math.round(row.self * profile.interval_us)]),
  );
}

const total = (shares: Record<string, number>) => Object.values(shares).reduce((sum, us) => sum + us, 0);

test("the strip's legend and the Profile tab's bar say the same shares, for the whole trace or any stretch", () => {
  const traced = trace(90_000);

  for (const windows of [
    null,
    [[30_000, 60_000]],
    [
      [5000, 15_000],
      [80_000, 108_000],
    ],
  ] as (Windows | null)[]) {
    const profile = windowProfile(traced, windows, true);

    expect(bar(profile)).toEqual(strip(traced, windows));
    expect(total(list(profile))).toBeCloseTo(total(strip(traced, windows)), -1);
  }
  expect(Object.entries(strip(traced, null)).sort()).toEqual([
    ["Database", 33_000],
    ["GC", 2000],
    ["waiting", 54_000],
    ["your code", 19_000],
  ]);
});

test("a code row's time is its profile's, and a function that ran only there is as long in the whole trace's list", () => {
  const traced = trace(90_000);
  const own = spanSegments(traced, "v");
  const code = windowsOfSegments(own.filter((segment) => segment.share !== "waiting"));
  const waits = windowsOfSegments(own.filter((segment) => segment.share === "waiting"));
  const row = (windows: Windows) => windows.reduce((sum, [from, to]) => sum + to - from, 0);

  // As said: the row's time and its profile's.
  expect(duration(total(bar(windowProfile(traced, code, true))))).toBe(duration(splitOf(traced, code).total));
  expect(duration(splitOf(traced, code).total)).toBe(duration(row(code)));
  expect(duration(total(bar(windowProfile(traced, waits, true))))).toBe(duration(splitOf(traced, waits).total));
  expect(Object.keys(bar(windowProfile(traced, waits, true)))).toEqual(["waiting"]);
  // get_db's cleanup (90–100 ms) ran in the view's own code only: 10 ms in its row's profile and in the whole list.
  expect(list(windowProfile(traced, code, true))["get_db"]).toBe(10_000);
  expect(list(windowProfile(traced, null, true))["get_db"]).toBe(10_000);
});

test("a bucket a span's end splits counts in both spans' rows by the same rule, adding up to the whole", () => {
  const traced = trace(93_000);
  const rowOf = (id: string) =>
    windowsOfSegments(spanSegments(traced, id).filter((segment) => segment.share !== "waiting"));

  // The transaction ends at 93 ms: 3 ms of the cleanup are its own code's, 7 ms the view's.
  expect(list(windowProfile(traced, rowOf("v"), true))["get_db"]).toBe(7000);
  expect(list(windowProfile(traced, rowOf("t"), true))["get_db"]).toBe(3000);
  expect(list(windowProfile(traced, null, true))["get_db"]).toBe(10_000);
});

test("a 7 ms stretch is 7 ms, however many samples its 10 ms bucket holds", () => {
  const stretch = windowProfile(trace(90_000), [[93_000, 100_000]], true);

  expect(stretch.samples * stretch.interval_us).toBeCloseTo(7000, 6);
  expect(Object.entries(list(stretch))).toEqual([["get_db", 7000]]);
});

test("All frames' shares add up to the trace: the query's time the database's, the pause GC's, by package the rest", () => {
  const all = allFrames(windowProfile(trace(90_000), null));
  const shares = Object.fromEntries(packageTimes(all).map((share) => [share.name, Math.round(share.samples * 1000)]));

  expect(total(shares)).toBe(108_000);
  expect(shares["Database"]).toBe(33_000);
  expect(shares["GC"]).toBe(2000);
  expect(shares["waiting"]).toBe(54_000);
});

test("the parts said add up to the total said: shares, the list's own times, the strip's legend", () => {
  // A code row's profile as get_db's was: get_db 6.9 ms and get_author 3.56 ms of 10.46 ms read 7 + 4 = 11 of 10.
  expect(apportion([6900, 3560], 1000, 10)).toEqual([7000, 3000]);
  expect(apportion([500, 500, 500], 1000, 2)).toEqual([1000, 1000, 0]);

  const traced = trace(93_000);
  const windowsTried: (Windows | null)[] = [
    null,
    [
      [34_275, 37_837],
      [93_103, 100_000],
    ],
    [[93_000, 100_000]],
    [
      [1000, 2500],
      [41_000, 47_300],
    ],
  ];
  for (const windows of windowsTried) {
    const profile = windowProfile(traced, windows, true);
    const split = splitOf(traced, windows);
    const whole = Math.round(profile.samples * profile.interval_us);
    // The shares as said: those a step or more long rounded with the rest to the total, a shorter one as the console
    // writes its time anywhere ("0.5 ms" of 10 ms), within a step of what it rounds to.
    const said = split.shares.reduce((sum, share) => sum + share.us, 0);
    const finer = split.shares.filter((share) => share.step < split.step).length;

    expect(whole).toBe(said);
    expect(total(bar(profile))).toBe(said);
    expect(total(list(profile))).toBe(said);
    expect(Math.abs(said - split.total)).toBeLessThan(finer * split.step + 1e-6);
  }
});

test("a profile's stretches go into a link and come back the same, and its title names them", () => {
  const windows = [
    [34, 38_000],
    [100_000, 108_000],
  ] as const;

  expect(stretchText(windows)).toBe("34-38000,100000-108000");
  expect(parseStretch("34-38000,100000-108000")).toEqual(windows);
  expect(parseStretch("93000-100000")).toEqual([[93_000, 100_000]]);
  expect(parseStretch("100-50")).toBeUndefined();
  expect(parseStretch("0-10,5-20")).toBeUndefined();
  expect(windowsLabel([[93_000, 100_000]])).toBe("93 ms – 100 ms");
  expect(windowsLabel(windows)).toBe("34 µs – 38 ms, 100 ms – 108 ms");
  expect(
    windowsLabel([
      [0, 1000],
      [2000, 3000],
      [4000, 5000],
      [6000, 7000],
    ]),
  ).toBe("4 ms in 4 stretches of 0 – 7 ms");
});
