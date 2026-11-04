// The one result every view of a trace's time reads (lib/split), over random traces: spans nested any way, a
// profile timed, partial, with no samples or none at all, the collector's pauses, an app's traces in a chain. Whatever
// the trace, its shares' times add up to its total, its percents to 100% ("<1%" a share said as none, ">99%" as
// all), what the profile covers is the total less its Not profiled; the legend and the Profile tab's bar say the
// split's shares, a code row's time is the time of the stretch it opens, a stretch's title tells its ends apart. The
// MCP server's split.rs has the same property test (crates/mcp/src/split.rs).
import { duration } from "../../packages/ui/src/format.ts";
import { headFacts } from "../../packages/ui/src/HeadFacts.tsx";
import { GC } from "../../packages/ui/src/lib/memory.ts";
import { plural } from "../../packages/ui/src/lib/plural.ts";
import { WAITING } from "../../packages/ui/src/lib/profile.ts";
import { parseStretch, stretchText, type Windows } from "../../packages/ui/src/lib/slice.ts";
import { appSplit, callsTime, type Split, splitOf, wholeWindows, writtenAt } from "../../packages/ui/src/lib/split.ts";
import {
  NOT_PROFILED,
  type Shared,
  segmentsOf,
  spanSegments,
  splitByProfile,
} from "../../packages/ui/src/lib/timeShares.ts";
import { windowProfile } from "../../packages/ui/src/lib/windowProfile.ts";
import { sharesOf } from "../../packages/ui/src/TimeLegend.tsx";
import type { Span, Trace } from "../../packages/ui/src/types.ts";
import { expect, test } from "../fixtures.ts";

/** A seeded generator (mulberry32): the same traces every run, any failure the same again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Random = () => number;
const int = (next: Random, from: number, to: number) => from + Math.floor(next() * (to - from + 1));
const pick = <T>(next: Random, items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

const KINDS = [
  "sql",
  "redis",
  "http.client",
  "template",
  "view",
  "function",
  "cache",
  "sql.connect",
  "transaction",
] as const;

/** Spans under `parent` in [from, to): a few, apart or overlapping, some with spans of their own. */
function children(next: Random, parent: string, from: number, to: number, depth: number, out: unknown[]): void {
  const count = depth > 2 || to - from < 4 ? 0 : int(next, 0, 4);
  for (let at = 0; at < count; at++) {
    const start = int(next, from, to - 2);
    const end = int(next, start + 1, to);
    const id = `${parent}.${at}`;
    const kind = pick(next, KINDS);
    out.push({
      id,
      // biome-ignore lint/style/useNamingConvention: a span as the SDKs send it.
      parent_id: parent,
      kind,
      name: `${kind} ${id}`,
      start,
      duration: end - start,
      status: "ok",
      attrs: kind === "sql" ? { "db.system": "postgresql" } : {},
    });
    children(next, id, start, end, depth + 1, out);
  }
}

/** A profile of the trace: none, one with no samples, timed (from its start or late), or not timed. */
function profileOf(next: Random, duration: number): Trace["profile"] {
  const shape = pick(next, ["none", "empty", "timed", "late", "untimed"] as const);
  if (shape === "none") return undefined;
  const interval = pick(next, [1000, 10_000]);
  // biome-ignore-start lint/style/useNamingConvention: a profile as the SDKs send it.
  const frames = [
    { function: "serve", module: "server", file: "server.py", line: 1, in_app: false },
    { function: "handler", module: "app.views", file: "app/views.py", line: 10, in_app: true },
    { function: "helper", module: "app.lib", file: "app/lib.py", line: 20, in_app: true },
    { function: "select", module: "selectors", file: "selectors.py", line: 3, in_app: false, waiting: true },
    { function: "encode", module: "json", file: "json.py", line: 4, in_app: false },
  ];
  const pauses = Array.from({ length: int(next, 0, 3) }, (): [number, number, number] => {
    const from = int(next, 0, Math.max(duration - 1, 0));
    return [from, int(next, 1, Math.max(1, Math.floor(duration / 10))), 0];
  });
  const gc = { collections: pauses.length, pause_us: pauses.reduce((sum, [, length = 0]) => sum + length, 0), pauses };
  if (shape === "empty") return { interval_us: interval, samples: 0, dropped: 0, frames: [], stacks: [], gc };
  const paths = [
    [0, 1],
    [0, 1, 2],
    [0, 1, 3],
    [0, 4],
    [0, 1, 2, 4],
    [0, 3],
  ];
  const bucket = pick(next, [1000, 10_000]);
  const buckets = Math.max(1, Math.ceil(duration / bucket));
  const first = shape === "late" ? int(next, 0, buckets - 1) : 0;
  const stacks = paths.map((frames) => ({ frames, count: 0, at: [] as [number, number][] }));
  for (let at = first; at < buckets; at++) {
    if (next() < 0.2) continue;
    for (const stack of stacks) {
      if (next() < 0.5) continue;
      const seen = int(next, 1, 5);
      stack.at.push([at, seen]);
      stack.count += seen;
    }
  }
  const kept = stacks.filter((stack) => stack.count > 0);
  const samples = kept.reduce((sum, stack) => sum + stack.count, 0);
  const estimated = next() < 0.2 ? { estimated_from: int(next, 1, samples + 1), spread: next() < 0.5 } : {};
  if (shape === "untimed") {
    return {
      interval_us: interval,
      samples,
      dropped: 0,
      frames,
      stacks: kept.map(({ frames: path, count }) => ({ frames: path, count })),
      gc,
    };
  }
  return { interval_us: interval, samples, dropped: 0, bucket_us: bucket, frames, stacks: kept, gc, ...estimated };
  // biome-ignore-end lint/style/useNamingConvention: a profile as the SDKs send it.
}

/** A random trace: its root, spans under it, a profile of some shape. */
function traceOf(next: Random): Trace {
  const duration = Math.round(10 ** (next() * 5.5)) + 1;
  const spans: unknown[] = [
    {
      id: "r",
      // biome-ignore lint/style/useNamingConvention: a span as the SDKs send it.
      parent_id: null,
      kind: pick(next, ["http", "task"]),
      name: "root",
      start: 0,
      duration,
      status: "ok",
      attrs: {},
    },
  ];
  children(next, "r", 0, duration, 0, spans);
  return { start: 0, duration, attrs: {}, spans, profile: profileOf(next, duration) } as unknown as Trace;
}

/** A percent as a number: "<1%" a share said as none, ">99%" as all. */
function said(percent: string): number {
  if (percent === "<1%") return 0;
  if (percent === ">99%") return 100;
  return Number(percent.replace("%", ""));
}

/** A time as written ("1,204.5 ms", "27 µs", "1.6 s") back in whole µs. */
function read(text: string): number {
  // A share under a µs ("<1 µs") counts as none.
  if (text.startsWith("<")) return 0;
  const [value = "0", unit = "µs"] = text.replaceAll(",", "").split(" ");
  return Math.round(Number(value) * (unit === "s" ? 1_000_000 : unit === "ms" ? 1000 : 1));
}

/** A time's unit and how many decimals it is written with: "ms.1" for "0.8 ms". */
function decimals(text: string): string {
  const [value = "", unit = ""] = text.split(" ");
  return `${unit}.${value.split(".")[1]?.length ?? 0}`;
}

/** What every split says, whatever it is of: what it breaks, if anything (one assertion per test reads them all). */
function broken(split: Split): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) problems.push(`${what}: ${JSON.stringify(split)}`);
  };
  // A share the console writes at a finer step on its own ("0.6 ms" of a 310 ms trace) is written so: the header's
  // and the DB tab's text. The rest are whole steps of the split's, rounded with every share to add up to the total.
  const finer = split.shares.filter((share) => share.step < split.step);
  check(
    finer.every((share) => share.time === duration(share.exact)),
    "a share finer than the split written as duration writes it",
  );
  check(
    split.shares.every(
      (share) =>
        share.us >= 0 &&
        share.step <= split.step &&
        Math.abs(share.us / share.step - Math.round(share.us / share.step)) < 1e-9,
    ),
    "each share a whole number of its steps",
  );
  // Each finer share is within one of the split's steps of what it rounds to with the rest.
  const slack = finer.length * split.step;
  check(
    Math.abs(split.shares.reduce((sum, share) => sum + share.us, 0) - split.total) < slack + 1e-6,
    "times add up to the total",
  );
  check(
    split.shares.length === 0 || split.shares.reduce((sum, share) => sum + said(share.percent), 0) === 100,
    "percents add up to 100%",
  );
  // As read: the shares' times written add up to the total written, what it covers to the total less Not profiled,
  // but for the finer shares' own rounding.
  const written = split.shares.reduce((sum, share) => sum + read(share.time), 0);
  check(Math.abs(written - read(split.time)) < slack + 1e-6, `times as read add up (${written} of ${split.time})`);
  const notProfiled = split.shares.find((share) => share.share === NOT_PROFILED);
  check(
    Math.abs(read(split.covered) - (read(split.time) - (notProfiled ? read(notProfiled.time) : 0))) <
      (notProfiled && notProfiled.step < split.step ? split.step : 0) + 1e-6,
    "covered as read",
  );
  check(
    split.shares.every(
      (share) => share.step < split.step || share.time.startsWith("<") || decimals(share.time) === decimals(split.time),
    ),
    "one precision for the total and the shares at its step",
  );
  // The total as the console writes a duration everywhere (the page's header).
  check(split.shares.length === 0 || split.time === duration(split.exact), `the total as duration writes it`);
  check(
    split.profiled % split.step === 0 && split.covered === writtenAt(split.profiled, split.step),
    "covered at the split's step",
  );
  const rest = split.shares.filter((share) => share.share !== WAITING).map((share) => share.us);
  check(JSON.stringify(rest) === JSON.stringify([...rest].sort((a, b) => b - a)), "largest first");
  const waiting = split.shares.findIndex((share) => share.share === WAITING);
  check(waiting < 0 || waiting === split.shares.length - 1, "waiting last");
  // A stretch's title tells its ends apart: never "170 ms – 170 ms".
  check(
    split.of.split(", ").every((part) => {
      const ends = part.split(" – ");
      return ends.length !== 2 || ends[0] !== ends[1];
    }),
    "a stretch's ends apart",
  );
  return problems;
}

/**
 * Database is the time in queries, as the DB tab adds them up: where each query runs alone (no span of its own
 * inside, none beside it but those it runs under), the Database share's time before it is said is their durations'
 * sum, the collector's pauses during them included. What breaks that, if anything.
 */
const QUERIES = { checked: 0 };

/** Whether each of the trace's queries runs alone: no span of its own inside, none beside it but those it runs under. */
function queriesAlone(trace: Trace): boolean {
  const spans = trace.spans;
  const byId = new Map(spans.map((span) => [span.id, span]));
  const above = (span: Span, other: Span): boolean => {
    for (let at = byId.get(String(span.parent_id)); at; at = byId.get(String(at.parent_id)))
      if (at === other) return true;
    return false;
  };
  const queries = spans.filter((span) => span.kind === "sql" && span.duration > 0);
  return (
    queries.length > 0 &&
    queries.every(
      (query) =>
        !spans.some((other) => other.parent_id === query.id) &&
        !spans.some(
          (other) =>
            other !== query &&
            !above(query, other) &&
            other.start < query.start + query.duration &&
            query.start < other.start + other.duration,
        ),
    )
  );
}

function queriesBroken(trace: Trace): string[] {
  if (!queriesAlone(trace)) return [];
  QUERIES.checked += 1;
  const queries = trace.spans.filter((span) => span.kind === "sql" && span.duration > 0);
  const expected = queries.reduce(
    (sum, query) =>
      sum + Math.max(Math.min(query.start + query.duration, trace.duration) - Math.max(query.start, 0), 0),
    0,
  );
  const database = segmentsOf(trace)
    .filter((segment) => segment.share === "sql")
    .reduce((sum, segment) => sum + segment.to - segment.from, 0);
  return Math.abs(database - expected) < 1e-6 ? [] : [`Database ${database} µs, its queries ${expected} µs`];
}

/**
 * One fact, one written value: the header's queries and the DB tab say their time as the strip's Database does, the
 * header's GC as the strip's GC; where the queries run alone, to the letter. What breaks that, if anything.
 */
const HEADERS = { checked: 0 };

function headerBroken(trace: Trace): string[] {
  const split = splitOf(trace);
  const facts = headFacts(trace);
  const problems: string[] = [];
  const queries = trace.spans.filter((span) => span.kind === "sql");
  const database = split.shares.find((share) => share.share === "sql");
  const fact = facts.find((each) => / quer(?:y|ies) /.test(each));
  // The header and the tab say the same text, whatever the queries.
  if (fact && !fact.startsWith(`${plural(queries.length, "query", "queries")} ${callsTime(trace, queries)}`))
    problems.push(`header "${fact}", the DB tab ${callsTime(trace, queries)}`);
  if (database && queriesAlone(trace)) {
    HEADERS.checked += 1;
    if (callsTime(trace, queries) !== database.time)
      problems.push(`the DB tab says ${callsTime(trace, queries)}, the strip's Database ${database.time}`);
    if (!fact?.startsWith(`${plural(queries.length, "query", "queries")} ${database.time}`))
      problems.push(`the header says "${fact}", the strip's Database ${database.time}`);
  }
  const gc = split.shares.find((share) => share.share === GC);
  const collections = trace.profile?.gc?.collections ?? 0;
  if (gc && collections && !facts.includes(`GC ${collections}× ${gc.time}`))
    problems.push(`the header says ${JSON.stringify(facts)}, the strip's GC ${gc.time}`);
  return problems;
}

/** A span's own stretches as its code row opens them: in whole µs, as the link carries them. */
function rowWindows(trace: Shared, span: string): Windows {
  return wholeWindows(spanSegments(trace, span).map((segment): [number, number] => [segment.from, segment.to]));
}

test("any trace's split adds up: times to the total, percents to 100%, what is covered to the total less Not profiled", () => {
  const next = random(20_261_104);
  const problems: string[] = [];
  for (let run = 0; run < 400; run++) {
    const trace = traceOf(next);
    const split = splitOf(trace);
    problems.push(...broken(split), ...queriesBroken(trace), ...headerBroken(trace));

    // The legend and the Profile tab's bar: the split's shares, as it says them.
    const legend = sharesOf(trace).map((share) => [share.label, share.time, share.percent]);
    if (
      JSON.stringify(legend) !== JSON.stringify(split.shares.map((share) => [share.label, share.time, share.percent]))
    )
      problems.push(`legend: ${JSON.stringify(legend)}`);
    if (splitByProfile(trace)) {
      // The flame and the list add up to the split.
      const profile = windowProfile(trace, null, true);
      const flame = Math.round(profile.stacks.reduce((sum, stack) => sum + stack.count * profile.interval_us, 0));
      // Each share's as the split says it: a finer one's at its own step.
      const said = split.shares.reduce((sum, share) => sum + share.us, 0);
      if (flame !== said) problems.push(`flame ${flame} of ${said}`);
    }

    // A code row's time is its stretch's, however the link carries the stretch.
    for (const span of trace.spans) {
      const windows = rowWindows(trace, span.id);
      if (windows.length === 0) continue;
      const row = splitOf(trace, windows);
      problems.push(...broken(row));
      const opened = splitOf(trace, parseStretch(stretchText(windows)) ?? null);
      if (JSON.stringify([opened.total, opened.shares, opened.of]) !== JSON.stringify([row.total, row.shares, row.of]))
        problems.push(`stretch ${opened.of} != row ${row.of}`);
    }
  }

  expect(problems).toEqual([]);
  // Enough traces whose queries run alone for the Database rule to be read, and the header's against it.
  expect(QUERIES.checked).toBeGreaterThan(5);
  expect(HEADERS.checked).toBeGreaterThan(5);
});

test("an app's traces in a chain add up before they are said: its shares to its total, its percents to 100%", () => {
  const next = random(4_242);
  const problems: string[] = [];
  for (let run = 0; run < 100; run++) {
    const traces = Array.from({ length: int(next, 1, 4) }, () => traceOf(next));
    const split = appSplit(traces.map((trace) => ({ trace, windows: null })));
    problems.push(...broken(split));
    const each = traces.map((trace) => splitOf(trace));
    const sum = each.reduce((all, one) => all + one.total, 0);
    // Said once: within the rounding of each trace's own split of their sum.
    if (Math.abs(split.total - sum) > split.step + each.reduce((all, one) => all + one.step, 0))
      problems.push(`app ${split.total} of ${sum}`);
  }

  expect(problems).toEqual([]);
});
