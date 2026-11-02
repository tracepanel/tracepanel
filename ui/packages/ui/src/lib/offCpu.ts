// A CPU profile (Go's, Node's) read on the trace's clock: the time its code wasn't on the CPU is waiting, and where
// the trace's calls say who waited (a query's, an HTTP call's code.origin), under that function of yours, as a Python
// or a JVM profile has its waits under the function that waited. Plain data, no React.
import type { Span, Trace } from "../types";
import type { Frame, Profile, Stack } from "./profile";
import { CALL_KINDS } from "./systems";
import { callLabel, waitFrame } from "./waitCalls";

/** "lib/catalog.ts:31 in card": where the app made a call, as every SDK writes code.origin. */
const ORIGIN = /^(.+):(\d+) in (.+)$/;

interface Origin {
  file: string;
  function: string;
}

function originOf(span: Pick<Span, "attrs">): Origin | null {
  const value = span.attrs["code.origin"];
  const found = typeof value === "string" ? ORIGIN.exec(value) : null;
  if (!found) return null;
  const [, file = "", , name = ""] = found;
  return { file, function: name };
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
 * The sampled frame of yours a call's origin names: in its file, the function it names. None where that function
 * was never sampled: a line says nothing of which function it is in.
 */
function frameOf(profile: Profile, origin: Origin): number | null {
  const index = profile.frames.findIndex(
    (frame) => frame.in_app && sameFile(frame.file, origin.file) && sameName(frame.function, origin.function),
  );
  return index === -1 ? null : index;
}

/** The sampled frame of yours a handler's span names by its full name (code.function: `shop.(*App).listProducts`). */
function frameNamed(profile: Profile, span: Pick<Span, "attrs">): number | null {
  const full = span.attrs["code.function"];
  if (typeof full !== "string" || full === "") return null;
  const index = profile.frames.findIndex(
    (frame) =>
      frame.in_app && frame.function !== "" && (full === frame.function || full.endsWith(`.${frame.function}`)),
  );
  return index === -1 ? null : index;
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

/**
 * Who waited for a call: the stack to the deepest sampled function of yours above it in the trace, the one its
 * origin names, else its callers' (a function's row, the handler's); none, the trace's own waiting, without one.
 */
function waiterOf(profile: Profile, span: Span, byId: ReadonlyMap<string, Span>): number[] | null {
  for (let at: Span | undefined = span; at; at = at.parent_id ? byId.get(at.parent_id) : undefined) {
    const origin = originOf(at);
    const index = (origin ? frameOf(profile, origin) : null) ?? frameNamed(profile, at);
    const path = index === null ? null : pathTo(profile, index);
    if (path) return path;
  }
  return null;
}

/** A call's stretch of the trace (µs since it started), the stack that waited for it, and what the call is. */
interface Waited {
  from: number;
  to: number;
  path: number[];
  label: string;
  span: string;
}

/** The trace's calls out (queries, HTTP calls, cache and queue calls) with the function of yours that made each. */
function callsWaited(profile: Profile, trace: Pick<Trace, "start" | "duration" | "spans">): Waited[] {
  const byId = new Map(trace.spans.map((span) => [span.id, span]));
  return trace.spans.flatMap((span): Waited[] => {
    if (span.parent_id === null || !CALL_KINDS.has(span.kind)) return [];
    const path = waiterOf(profile, span, byId);
    const from = Math.max(0, span.start - trace.start);
    const to = Math.min(trace.duration, span.start + span.duration - trace.start);
    return path && to > from ? [{ from, to, path, label: callLabel(span), span: span.id }] : [];
  });
}

/**
 * Each waiter's time in the calls (µs), by its stack: calls at once share the time they overlap, so none is
 * counted twice.
 */
function timeWaited(calls: readonly Waited[]): Map<string, WaitedBy> {
  const edges = [...new Set(calls.flatMap((call) => [call.from, call.to]))].sort((a, b) => a - b);
  const waited = new Map<string, WaitedBy>();
  for (const [at, from] of edges.entries()) {
    const to = edges[at + 1];
    if (to === undefined) break;
    const open = calls.filter((call) => call.from <= from && call.to >= to);
    for (const call of open) {
      const key = `${call.path.join(",")}|${call.label}`;
      const found = waited.get(key) ?? { path: call.path, label: call.label, spans: new Set(), us: 0 };
      found.us += (to - from) / open.length;
      found.spans.add(call.span);
      waited.set(key, found);
    }
  }
  return waited;
}

/** A stack's time waiting on calls of one kind (its label), and which calls. */
interface WaitedBy {
  path: number[];
  label: string;
  spans: Set<string>;
  us: number;
}

/** The profile's frames with a wait frame per label of the calls waited on, and where each is. */
function waitFrames(profile: Profile, waiters: readonly WaitedBy[]): { frames: Frame[]; at: Map<string, number> } {
  const spans = new Map<string, Set<string>>();
  for (const each of waiters) spans.set(each.label, new Set([...(spans.get(each.label) ?? []), ...each.spans]));
  const frames: Frame[] = [...profile.frames];
  const at = new Map<string, number>();
  for (const [label, ids] of spans) {
    at.set(label, frames.length);
    frames.push(waitFrame(label, [...ids]));
  }
  return { frames, at };
}

/**
 * How long a CPU profile's trace was off the CPU (µs): its time, less what was sampled or dropped for other traces.
 * None where its code ran on the CPU for longer than the trace (goroutines at once).
 */
export function offCpu(profile: Profile, trace: Pick<Trace, "duration">): number {
  return Math.max(0, trace.duration - (profile.samples + (profile.dropped ?? 0)) * profile.interval_us);
}

/**
 * A CPU profile read on the trace's clock: the time it wasn't on the CPU (not sampled, nor dropped for other traces;
 * the database, the network, a lock, a timer) waiting (WAITED), as a Python or a JVM profile has its waits. The
 * trace's calls say who waited for them: their time off the CPU is waiting under the function of yours that made
 * each (its code.origin, else the nearest function of yours above it in the trace that was sampled); the rest, no
 * call's or no sampled function's, one waiting stack of its own. None
 * where its code ran on the CPU for longer than the trace (goroutines at once).
 */
export function withOffCpu(profile: Profile, trace: Pick<Trace, "start" | "duration" | "spans">): Profile {
  const off = offCpu(profile, trace) / profile.interval_us;
  if (off < 1) return profile;
  const waiters = [...timeWaited(callsWaited(profile, trace)).values()];
  // Each wait named by what it waited on ("waiting · SQL postgresql"); the rest, no call's.
  const { frames, at } = waitFrames(profile, waiters);
  const waiting = frames.push(waitFrame(null)) - 1;
  const inCalls = waiters.reduce((sum, each) => sum + each.us, 0) / profile.interval_us;
  // The calls' time on the CPU (a driver encoding a query) is in the samples already: theirs is what's left, shared.
  const scale = inCalls > off ? off / inCalls : 1;
  const stacks: Stack[] = waiters.map(({ path, label, us }) => ({
    frames: [...path, at.get(label) ?? waiting],
    count: (us / profile.interval_us) * scale,
  }));
  const rest = off - inCalls * scale;
  if (rest > 0) stacks.push({ frames: [waiting], count: rest });
  return { ...profile, frames, stacks: [...profile.stacks, ...stacks], samples: profile.samples + off };
}
