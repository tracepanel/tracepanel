// collectstatic, where its time went: how many files it copied, linked, left and post-processed (on the command's
// trace), and each phase's time (a span each: clear, copy, post-process), as the Python SDK records them.
import { duration } from "../format";
import type { Span, Trace } from "../types";
import { plural } from "./plural";

export interface Fact {
  label: string;
  value: string;
}

const COUNTS: readonly (readonly [key: string, word: string])[] = [
  ["collectstatic.copied", "copied"],
  ["collectstatic.linked", "linked"],
  ["collectstatic.unmodified", "unmodified"],
  ["collectstatic.post_processed", "post-processed"],
];

const PHASES: Record<string, string> = { clear: "Clear", copy: "Copy", "post-process": "Post-process" };

function count(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** "12 copied · 3 linked · 400 unmodified · 15 post-processed": every count the run has, none left out for 0. */
function filesFact(trace: Trace): Fact[] {
  const parts = COUNTS.flatMap(([key, word]) => {
    const n = count(trace.attrs[key]);
    return n === null ? [] : [`${n.toLocaleString()} ${word}`];
  });
  return parts.length ? [{ label: "Files", value: parts.join(" · ") }] : [];
}

/** A milliseconds attribute as the console says a time. */
function ms(value: unknown): string | null {
  return typeof value === "number" ? duration(value * 1000) : null;
}

/** "415 files in 900 ms": how many files the phase handled and their time. */
function filesPart(span: Span): string | null {
  const files = count(span.attrs["collectstatic.files"]);
  if (!files) return null;
  const time = ms(span.attrs["collectstatic.files_ms"]);
  return time ? `${plural(files, "file", "files")} in ${time}` : plural(files, "file", "files");
}

/** What else the phase spent its time on: the finders' listing, storage calls outside its files. */
function otherParts(span: Span): (string | null)[] {
  const listing = ms(span.attrs["collectstatic.find_ms"]);
  const calls = count(span.attrs["collectstatic.storage_calls"]);
  return [
    listing ? `listing ${listing}` : null,
    calls ? plural(calls, "other storage call", "other storage calls") : null,
  ];
}

/** "1.2 s · 415 files in 900 ms · listing 300 ms": the phase's time, its files' and what else it spent it on. */
function phaseValue(span: Span): string {
  return [duration(span.duration), filesPart(span), ...otherParts(span)].filter(Boolean).join(" · ");
}

/**
 * A collectstatic run's facts, for its job's first tab: its files' counts, then each phase as it ran. Nothing for any
 * other command.
 */
export function collectstaticFacts(trace: Trace): Fact[] {
  if (trace.kind !== "command") return [];
  const phases = trace.spans.flatMap((span) => {
    const phase = span.attrs["collectstatic.phase"];
    const label = typeof phase === "string" ? PHASES[phase] : undefined;
    return label ? [{ label, value: phaseValue(span) }] : [];
  });
  return [...filesFact(trace), ...phases];
}
