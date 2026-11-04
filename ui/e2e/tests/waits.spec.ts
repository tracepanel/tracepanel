// A trace's time by share and its profile's rows that are no function: the console's rule (lib/timeShares), which
// the MCP server's get_profile shares, over its cases. Each row Your code reads that is a wait or a call's share, by
// its name, with its own time in µs, most first; and the trace's time by share, as the time strip says it. A case
// with what an SDK sent (`sent`, a Go CPU profile) has the profile the agent made of it at ingest: the console reads
// that one, as every language's.
import { readFileSync } from "node:fs";
import { functions, ownCode, type Profile, shareFrame } from "../../packages/ui/src/lib/profile.ts";
import { type Shared, shareLabel, shareTimes, windowProfile } from "../../packages/ui/src/lib/timeShares.ts";
import { type Timed, timed } from "../../packages/ui/src/lib/waiting.ts";
import type { Trace } from "../../packages/ui/src/types.ts";
import { expect, test } from "../fixtures.ts";

type Profiled = Pick<Trace, "start" | "duration" | "spans" | "attrs"> & { profile: Profile };

interface Case {
  name: string;
  trace: Profiled;
  waits: [string, number][];
  shares: [string, number][];
}

const CASES: Case[] = JSON.parse(readFileSync(new URL("../../../schema/waits.json", import.meta.url), "utf8"));

/** What Your code reads, as the Profile tab scopes the whole trace. */
function own(trace: Profiled): Profile {
  const { profile } = trace;
  return timed(profile) ? windowProfile(trace as Shared & { profile: Timed }, null, true) : profile;
}

const byTime = (a: [string, number], b: [string, number]) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

function waitsOf(trace: Profiled): [string, number][] {
  const profile = ownCode(own(trace));
  return functions(profile)
    .filter((row) => (row.frame.waiting === true || shareFrame(row.frame) !== null) && row.self > 0)
    .map((row): [string, number] => [row.frame.function, Math.round(row.self * profile.interval_us)])
    .sort(byTime);
}

function sharesOf(trace: Profiled): [string, number][] {
  if (!timed(trace.profile)) return [];
  return [...shareTimes(trace as Shared)]
    .map(([share, us]): [string, number] => [shareLabel(share), Math.round(us)])
    .sort(byTime);
}

test("the shared cases: a call's time its own share, a wait named by the frame that waited, the time by share", () => {
  const read = CASES.map(({ name, trace }) => ({ name, waits: waitsOf(trace), shares: sharesOf(trace) }));

  expect(read).toEqual(CASES.map(({ name, waits, shares }) => ({ name, waits, shares })));
});
