// The one rule a profile's samples become time by (lib/waiting's stackTimes), over a profile shaped like a FastAPI
// sync endpoint's: the event loop waiting while a worker thread runs the endpoint, a sample that stands for ticks the
// sampler missed, a bucket the cleanup alone was seen in. Every number the Profile tab and the call tree say reads
// it: a stretch's profile is the stretch's time, the shares and the functions add up to it, a code row's time is the
// profile it opens.
import { functions, ownCode, type Profile, packageOf, packageTimes } from "../../packages/ui/src/lib/profile.ts";
import { parseStretch, stretchText, windowsLabel, windowsTime } from "../../packages/ui/src/lib/slice.ts";
import { namedWaits } from "../../packages/ui/src/lib/waitCalls.ts";
import { piecesOf, stackTimes, type Timed, waitName, wallClock, windowsOf } from "../../packages/ui/src/lib/waiting.ts";
import { expect, test } from "../fixtures.ts";

const DURATION = 108_000;

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
 * GET /authors/{id}: the loop awaits the worker thread (0, 1), which runs get_author (3) waiting for the pool's
 * connection (5) and on its socket (6); the dependency's exit waits (7), the worker runs get_db's cleanup (10, 11).
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
    // The loop waiting for the worker before it ran the endpoint, and a sample at 75 ms standing for 32 ticks.
    {
      frames: [0, 1],
      count: 36,
      at: [
        [0, 4],
        [7, 32],
      ],
    },
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
      count: 16,
      at: [
        [3, 4],
        [7, 2],
        [8, 5],
        [10, 5],
      ],
    },
    {
      frames: [7],
      count: 22,
      at: [
        [0, 6],
        [8, 5],
        [10, 11],
      ],
    },
    // The cleanup, alone in its bucket (90–100 ms).
    { frames: [8, 9, 10, 11], count: 6, at: [[9, 6]] },
  ],
};

const TRACE = { start: 0, spans: [] };

/** A profile's time, as the Profile tab says it (µs). */
const timeOf = (profile: Profile) => profile.samples * profile.interval_us;

/** The functions as Your code lists them: each one's own time (µs), by name. */
function ownFunctions(profile: Profile): Record<string, number> {
  return Object.fromEntries(
    functions(ownCode(namedWaits(profile, TRACE))).map((row) => [
      row.frame.function,
      Math.round(row.self * profile.interval_us),
    ]),
  );
}

test("a 7 ms stretch is 7 ms, however many samples its 10 ms bucket holds", () => {
  const stretch = wallClock(PROFILE, DURATION, [[93_000, 100_000]]);

  expect(timeOf(stretch)).toBe(7000);
  expect(Object.entries(ownFunctions(stretch))).toEqual([["get_db", 7000]]);
  expect(Object.fromEntries(stackTimes(PROFILE, DURATION, [[93_000, 100_000]]))).toEqual({ 4: 7000 });
});

test("the whole trace's shares and functions add up to its time, each function in a share", () => {
  const whole = wallClock(PROFILE, DURATION, null);
  const own = ownCode(namedWaits(whole, TRACE));
  const shares = packageTimes(own);
  const rows = functions(own);

  expect(timeOf(whole)).toBe(DURATION);
  expect(shares.map((share) => share.name)).toEqual(["waiting", "your code"]);
  expect(shares.reduce((sum, share) => sum + share.samples, 0) * 1000).toBeCloseTo(DURATION, 6);
  expect(rows.reduce((sum, row) => sum + row.self, 0) * 1000).toBeCloseTo(DURATION, 6);
  expect(rows.every((row) => shares.some((share) => share.name === packageOf(row.frame)))).toBe(true);
  // The worker thread's machinery is no function of yours: its time is your code's that ran in it, or waiting.
  expect(rows.map((row) => row.frame.function).sort()).toEqual([
    "get_author",
    "get_db",
    "waiting · AsyncIOBackend.run_sync_in_worker_thread",
    "waiting · _AsyncGeneratorContextManager.__aexit__",
    "waiting · waiter.acquire",
  ]);
});

test("a code row's time is the time of the profile it opens, its waiting and your code's adding up to it", () => {
  // get_author's own code: before the query and after it, the query's span (38–93 ms) between.
  const pieces = [...piecesOf(PROFILE, DURATION, 0, 38_000), ...piecesOf(PROFILE, DURATION, 100_000, 108_000)];
  const waits = windowsOf(pieces.filter((piece) => piece.waiting));
  const row = windowsTime(waits);
  const opened = wallClock(PROFILE, DURATION, waits);
  const shares = packageTimes(ownCode(namedWaits(opened, TRACE)));

  expect(waits).toEqual([
    [0, 38_000],
    [100_000, 108_000],
  ]);
  expect(row).toBe(46_000);
  expect(timeOf(opened)).toBe(row);
  expect(shares.map((share) => ({ ...share, samples: Math.round(share.samples * 1000) }))).toEqual([
    { name: "waiting", samples: 40_300 },
    { name: "your code", samples: 5700 },
  ]);
});

test("a wait row holding several waits says so; the whole trace lists each on its own", () => {
  const pieces = [...piecesOf(PROFILE, DURATION, 0, 38_000), ...piecesOf(PROFILE, DURATION, 100_000, 108_000)];
  const opened = wallClock(PROFILE, DURATION, windowsOf(pieces.filter((piece) => piece.waiting)));
  const whole = ownFunctions(wallClock(PROFILE, DURATION, null));

  expect(waitName(opened)).toEqual({ name: "waiter.acquire and 1 more wait in get_author", yours: true });
  // The row's 46 ms are all its waits; waiter.acquire alone, over the whole trace, is less.
  expect(whole["waiting · waiter.acquire"]).toBeLessThan(46_000);
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
