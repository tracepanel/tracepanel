/**
 * The "Slower than" filter's words: a time as the console writes it (500 ms, 2 s), a `duration>` term's value as
 * milliseconds, and what a row filtered by it says of itself: "12 of 340 calls over 500 ms".
 */

const DURATION = /^(\d+(?:\.\d+)?)(us|µs|ms|s)?$/;
const PER_MS: Record<string, number> = { us: 0.001, "\u00b5s": 0.001, ms: 1, s: 1000 };

/** A `duration>` value in milliseconds, as the agent reads it (a bare number is milliseconds); null if it isn't one. */
export function durationMs(value: string): number | null {
  const found = DURATION.exec(value);
  if (!found) return null;
  return Number(found[1]) * (PER_MS[found[2] ?? "ms"] ?? 1);
}

/** 500 ms, 1 s, 2.5 s. */
export function msText(ms: number): string {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(3))} s` : `${Number(ms.toFixed(3))} ms`;
}

/** How a time goes into the search: whole seconds as seconds (`1s`), else milliseconds (`750ms`). */
export function durationTerm(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

const SLOWER = /(?:^|\s)duration>=?("?)([^\s"]+)\1(?=\s|$)/g;

/** The time the search's last `duration>` keeps, as typed (`500ms`); null without one, or one that isn't a time. */
export function slowerOf(q: string): string | null {
  const value = [...q.matchAll(SLOWER)].at(-1)?.[2];
  return value !== undefined && durationMs(value) !== null ? value : null;
}

/** "over 500 ms": what a `duration>` value keeps, as a row says it. */
export function overText(value: string): string | null {
  const ms = durationMs(value);
  return ms === null ? null : `over ${msText(ms)}`;
}

/** What one and several of a row's count are called: ["run", "runs"]. */
export type Noun = readonly [one: string, many: string];

/** "12 of 340 calls over 500 ms": a group's slow ones of all it has; null when the search keeps them all. */
export function shareText(
  count: number,
  all: number | null | undefined,
  noun: Noun,
  over: string | null,
): string | null {
  if (all === null || all === undefined || over === null) return null;
  return `${count.toLocaleString()} of ${all.toLocaleString()} ${all === 1 ? noun[0] : noun[1]} ${over}`;
}

/**
 * What a group's page keeps of its list's Slower than terms (see slowerTermsOf), said: "over 500 ms", "with a call
 * over 100 ms"; null without them.
 */
export function slowerText(terms: string): string | null {
  const own = /(?:^|\s)duration>=?(\S+)/.exec(terms)?.[1];
  const call = /(?:^|\s)call_duration>=?(\S+)/.exec(terms)?.[1];
  const ownText = own === undefined ? null : overText(own);
  const callText = call === undefined ? null : overText(call);
  const parts = [ownText, callText === null ? null : `with a call ${callText}`].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}
