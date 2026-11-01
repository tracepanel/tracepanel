// A CPU profile (Go's, Node's) read on the trace's clock: the time its code wasn't on the CPU is waiting, and where
// the trace's calls say who waited (a query's, an HTTP call's code.origin), under that function of yours, as a Python
// or a JVM profile has its waits under the function that waited. Plain data, no React.
import type { Span, Trace } from "../types";
import { type Frame, type Profile, type Stack, WAITED } from "./profile";
import { CALL_KINDS } from "./systems";

/** "lib/catalog.ts:31 in card": where the app made a call, as every SDK writes code.origin. */
const ORIGIN = /^(.+):(\d+) in (.+)$/;

interface Origin {
  file: string;
  line: number;
  function: string;
}

function originOf(span: Pick<Span, "attrs">): Origin | null {
  const value = span.attrs["code.origin"];
  const found = typeof value === "string" ? ORIGIN.exec(value) : null;
  if (!found) return null;
  const [, file = "", line = "0", name = ""] = found;
  return { file, line: Number(line), function: name };
}

/** The same file, however much of its path each names: `catalog.go` and `shop/catalog.go`. */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.endsWith(`/${short}`);
}

/** The same function, however each names it: `card`, `Catalog.card`, `(*App).listProducts`. */
function sameName(a: string, b: string): boolean {
  const last = (name: string) => name.split(".").at(-1);
  return a === b || last(a) === last(b);
}

/**
 * The frame of yours a call's origin names: in its file, the function it names, else the function its line is in
 * (the one starting last before it). None where no sampled frame of yours is in that file.
 */
function frameOf(profile: Profile, origin: Origin): number | null {
  const inFile = profile.frames.flatMap((frame, index) =>
    frame.in_app && sameFile(frame.file, origin.file) ? [{ frame, index }] : [],
  );
  const named = inFile.find(({ frame }) => sameName(frame.function, origin.function));
  if (named) return named.index;
  const around = inFile.filter(({ frame }) => frame.line <= origin.line).sort((a, b) => b.frame.line - a.frame.line)[0];
  return around?.index ?? null;
}

/**
 * The stack down to a frame, outermost first, the frame last: as the stacks reached it through most functions of
 * yours (an async function's stack after an await starts at it, before it at its callers), then most often.
 */
function pathTo(profile: Profile, index: number): number[] | null {
  const paths = profile.stacks.flatMap((stack) => {
    const at = stack.frames.indexOf(index);
    if (at === -1) return [];
    const path = stack.frames.slice(0, at + 1);
    return [{ path, yours: path.filter((each) => profile.frames[each]?.in_app).length, count: stack.count }];
  });
  return paths.sort((a, b) => b.yours - a.yours || b.count - a.count)[0]?.path ?? null;
}

/** Who waited for a call: the stack to the function of yours its origin (else its callers' nearest one) names. */
function waiterOf(profile: Profile, span: Span, byId: ReadonlyMap<string, Span>): number[] | null {
  for (let at: Span | undefined = span; at; at = at.parent_id ? byId.get(at.parent_id) : undefined) {
    const origin = originOf(at);
    const index = origin ? frameOf(profile, origin) : null;
    const path = index === null ? null : pathTo(profile, index);
    if (path) return path;
  }
  return null;
}

/** A call's stretch of the trace (µs since it started), and the stack that waited for it. */
interface Waited {
  from: number;
  to: number;
  path: number[];
}

/** The trace's calls out (queries, HTTP calls, cache and queue calls) with the function of yours that made each. */
function callsWaited(profile: Profile, trace: Pick<Trace, "start" | "duration" | "spans">): Waited[] {
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  return trace.spans.flatMap((span): Waited[] => {
    if (span.parent_id === null || !CALL_KINDS.has(span.kind)) return [];
    const path = waiterOf(profile, span, byId);
    const from = Math.max(0, span.start - trace.start);
    const to = Math.min(trace.duration, span.start + span.duration - trace.start);
    return path && to > from ? [{ from, to, path }] : [];
  });
}

/**
 * Each waiter's time in the calls (µs), by its stack: calls at once share the time they overlap, so none is
 * counted twice.
 */
function timeWaited(calls: readonly Waited[]): Map<string, { path: number[]; us: number }> {
  const edges = [...new Set(calls.flatMap((call) => [call.from, call.to]))].sort((a, b) => a - b);
  const waited = new Map<string, { path: number[]; us: number }>();
  for (const [at, from] of edges.entries()) {
    const to = edges[at + 1];
    if (to === undefined) break;
    const open = calls.filter((call) => call.from <= from && call.to >= to);
    for (const call of open) {
      const key = call.path.join(",");
      const found = waited.get(key) ?? { path: call.path, us: 0 };
      found.us += (to - from) / open.length;
      waited.set(key, found);
    }
  }
  return waited;
}

/**
 * A CPU profile read on the trace's clock: the time it wasn't on the CPU (not sampled, nor dropped for other traces;
 * the database, the network, a lock, a timer) waiting (WAITED), as a Python or a JVM profile has its waits. The
 * trace's calls say who waited for them: their time off the CPU is waiting under the function of yours that made
 * each (its code.origin, matched to the profile's frames); the rest, no call's, one waiting stack of its own. None
 * where its code ran on the CPU for longer than the trace (goroutines at once).
 */
export function withOffCpu(profile: Profile, trace: Pick<Trace, "start" | "duration" | "spans">): Profile {
  const off = trace.duration / profile.interval_us - profile.samples - (profile.dropped ?? 0);
  if (off < 1) return profile;
  const frames: Frame[] = [...profile.frames, WAITED];
  const waiting = frames.length - 1;
  const waiters = [...timeWaited(callsWaited(profile, trace)).values()];
  const inCalls = waiters.reduce((sum, each) => sum + each.us, 0) / profile.interval_us;
  // The calls' time on the CPU (a driver encoding a query) is in the samples already: theirs is what's left, shared.
  const scale = inCalls > off ? off / inCalls : 1;
  const stacks: Stack[] = waiters.map(({ path, us }) => ({
    frames: [...path, waiting],
    count: (us / profile.interval_us) * scale,
  }));
  const rest = off - inCalls * scale;
  if (rest > 0) stacks.push({ frames: [waiting], count: rest });
  return { ...profile, frames, stacks: [...profile.stacks, ...stacks], samples: profile.samples + off };
}
