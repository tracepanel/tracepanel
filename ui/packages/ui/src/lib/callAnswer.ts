// What a call out (an HTTP call, from any SDK or over OTLP) was answered, one rule wherever a call shows: answered 5xx
// or not at all (a connection error, a timeout) it failed, red as an errored span is; answered 4xx it wants a look,
// amber as a warning is, not an error; anything else went well. A call whose trace another app served for it, and that
// says no answer of its own (the page sent its trace before the call ended), takes that trace's.

import type { Span, TraceSummary } from "../types";

/** How a call went: its status code (none when it has none to say), and its tone. */
export interface CallAnswer {
  status: number | null;
  tone: "error" | "warn" | undefined;
}

/** The attribute a browser recording sets on a call that hadn't ended when it sent the page's trace. */
export const UNFINISHED = "http.unfinished";

function codeOf(span: Span): number | null {
  const code = span.attrs["http.response.status_code"] ?? span.attrs["http.status_code"];
  return typeof code === "number" ? code : null;
}

/**
 * A call that hadn't ended when its trace went out: the browser recording sends a view on a route change (or after
 * its longest wait) with its calls still open. Marked so by a newer SDK; an older one left them at 0 µs, no answer.
 */
export function unfinished(span: Span): boolean {
  if (span.attrs[UNFINISHED] === true) return true;
  return span.duration === 0 && codeOf(span) === null && span.status !== "error";
}

/** The tone of an answer's status code: 5xx failed, 4xx a warning. */
function toneOf(status: number): CallAnswer["tone"] {
  if (status >= 500) return "error";
  return status >= 400 ? "warn" : undefined;
}

/**
 * What the call was answered: its own status code, else (for a call with no answer of its own, or one cut short)
 * the status of the trace served for it. Status 0 (a browser's call that got no answer) is no status: it failed.
 */
export function callAnswer(span: Span, served?: TraceSummary | undefined): CallAnswer {
  const code = codeOf(span);
  const own = code === 0 ? null : code;
  if (own !== null) return { status: own, tone: span.status === "error" ? "error" : toneOf(own) };
  const failed = span.status === "error" || code === 0;
  if (served && (!failed || unfinished(span))) {
    const status = served.http_status ?? null;
    const tone = served.status === "error" ? "error" : status === null ? undefined : toneOf(status);
    return { status, tone };
  }
  return { status: null, tone: failed ? "error" : undefined };
}

/** Whether a span is a call that can say what it was answered. */
export function answers(span: Span): boolean {
  return span.kind === "http.client" || codeOf(span) !== null;
}

/** How a group of calls went, as its one row says it: how many failed, how many were answered 4xx. */
export interface GroupAnswer {
  failed: number;
  warned: number;
  /** The 4xx code the warned calls share, when they share one (404 ×3); null when they differ. */
  code: number | null;
  /** The worst of them, the row's edge as a single call's: a failure over a 4xx. */
  tone: CallAnswer["tone"];
}

/** A call's tone wherever a row shows it: a call out's answer, else an errored span's red. */
function toneOfCall(span: Span, served?: TraceSummary | undefined): CallAnswer["tone"] {
  if (answers(span)) return callAnswer(span, served).tone;
  return span.status === "error" ? "error" : undefined;
}

/** What a group's calls were answered, together: one rule with each call's own row (see callAnswer). */
export function groupAnswer(calls: readonly { span: Span; served?: TraceSummary | undefined }[]): GroupAnswer {
  let failed = 0;
  const codes: (number | null)[] = [];
  for (const { span, served } of calls) {
    const tone = toneOfCall(span, served);
    if (tone === "error") failed += 1;
    if (tone === "warn") codes.push(callAnswer(span, served).status);
  }
  const warned = codes.length;
  const code = new Set(codes).size === 1 ? (codes[0] ?? null) : null;
  return { failed, warned, code, tone: failed > 0 ? "error" : warned > 0 ? "warn" : undefined };
}
