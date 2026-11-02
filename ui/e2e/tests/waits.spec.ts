// A profile's waits named by what was in flight: the console's rule, which the MCP server's get_profile shares, over
// its cases. Each wait Your code reads, by its name, with its own time in µs, most first.
import { readFileSync } from "node:fs";
import { withOffCpu } from "../../packages/ui/src/lib/offCpu.ts";
import { functions, onCpuOnly, ownCode, type Profile } from "../../packages/ui/src/lib/profile.ts";
import { namedWaits } from "../../packages/ui/src/lib/waitCalls.ts";
import { timed, wallClock } from "../../packages/ui/src/lib/waiting.ts";
import type { Trace } from "../../packages/ui/src/types.ts";
import { expect, test } from "../fixtures.ts";

type Profiled = Pick<Trace, "start" | "duration" | "spans" | "attrs"> & { profile: Profile };

interface Case {
  name: string;
  trace: Profiled;
  waits: [string, number][];
}

const CASES: Case[] = JSON.parse(readFileSync(new URL("../../../schema/waits.json", import.meta.url), "utf8"));

/** What Your code reads, as the Profile tab scopes the whole trace. */
function own(trace: Profiled): Profile {
  const { profile } = trace;
  if (timed(profile)) return namedWaits(wallClock(profile, trace.duration, null), trace);
  return onCpuOnly(trace) ? withOffCpu(profile, trace) : profile;
}

function waitsOf(trace: Profiled): [string, number][] {
  const profile = ownCode(own(trace));
  return functions(profile)
    .filter((row) => row.frame.waiting === true && row.self > 0)
    .map((row): [string, number] => [row.frame.function, Math.round(row.self * profile.interval_us)])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

test("the shared cases: each wait named by the calls in flight, or the frame that waited, or no call", () => {
  const read = CASES.map(({ name, trace }) => ({ name, waits: waitsOf(trace) }));

  expect(read).toEqual(CASES.map(({ name, waits }) => ({ name, waits })));
});
