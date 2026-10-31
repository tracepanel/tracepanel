// A part of a trace's time picked to look at: kinds of calls (a share of the time, a filter chip) and a stretch of
// the timeline. Plain data, no React: the call tree draws from it, the console keeps it in its URL.

import { duration } from "../format";
import type { Log } from "../types";
import { isDump } from "./dump";

/** A stretch of the trace's time, in microseconds since it started. */
export type TimeRange = readonly [number, number];

export interface Slice {
  /** The kinds picked: a filter's id (sql, cache, template…) or a share of the time's own (django, code). */
  parts: readonly string[];
  range: TimeRange | null;
  /** Every log record shown, its info and debug ones too: by default only warnings and worse are. */
  logs: boolean;
}

export const WHOLE: Slice = { parts: [], range: null, logs: false };

/** Whether nothing is picked: no kinds, no range (which records show is how to look, not a pick). */
export function isWhole(slice: Slice): boolean {
  return slice.parts.length === 0 && slice.range === null;
}

/** The slice with nothing picked, its records shown as they were. */
export function cleared(slice: Slice): Slice {
  return { ...WHOLE, logs: slice.logs };
}

/** A log record worth showing by default: a warning or worse. Info and debug ones show when asked for. */
export function isLoud(level: string): boolean {
  return LOUD.has(level.toLowerCase());
}

const LOUD = new Set(["warning", "warn", "error", "critical", "fatal"]);

/** A record that shows by default: a warning or worse, or a dump (printed on purpose, to be seen). */
export function isShown(log: Pick<Log, "level" | "attrs">): boolean {
  return isLoud(log.level) || isDump(log);
}

/** The slice with `part` picked, or no longer picked. */
export function togglePart(slice: Slice, part: string): Slice {
  const parts = slice.parts.includes(part) ? slice.parts.filter((each) => each !== part) : [...slice.parts, part];
  return { ...slice, parts };
}

/** A range in order, inside the trace, or none when it is too thin to be one. */
export function rangeOf(from: number, to: number, total: number): TimeRange | null {
  // Whole microseconds: what the URL keeps of it is all of it.
  const start = Math.round(Math.max(Math.min(from, to), 0));
  const end = Math.round(Math.min(Math.max(from, to), total));
  return end > start ? [start, end] : null;
}

/** Whether a stretch (`start` for `length` µs, both since the trace started) overlaps the range; a point inside it. */
export function overlaps(range: TimeRange, start: number, length: number): boolean {
  return start <= range[1] && start + Math.max(length, 0) >= range[0];
}

/** "11 ms – 1.6 s": where the range starts and ends, as the page says times. */
export function rangeLabel(range: TimeRange): string {
  return `${range[0] === 0 ? "0" : duration(range[0])} – ${duration(range[1])}`;
}

const PART = /^[a-z]+$/;
const RANGE = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;

/**
 * A slice from a link's `part` ("sql code"), `range` ("12.4-18.9", in ms) and `logs` ("all"); whatever isn't one is
 * left out.
 */
export function parseSlice(part: string | undefined, range: string | undefined, logs?: string | undefined): Slice {
  return {
    parts: (part ?? "").split(/[\s+]+/).filter((each) => PART.test(each)),
    range: parseRange(range ?? ""),
    logs: logs === "all",
  };
}

/** "12.4-18.9", in ms, as microseconds; null for anything else. */
function parseRange(range: string): TimeRange | null {
  const [, from = "", to = ""] = RANGE.exec(range) ?? [];
  const start = Number(from) * 1000;
  const end = Number(to) * 1000;
  return end > start ? [start, end] : null;
}

/** The `part` and `range` a link says the slice with; each undefined when it isn't picked. */
export function sliceParams(slice: Slice): {
  part: string | undefined;
  range: string | undefined;
  logs: string | undefined;
} {
  return {
    logs: slice.logs ? "all" : undefined,
    part: slice.parts.length ? slice.parts.join(" ") : undefined,
    range: rangeParam(slice.range),
  };
}

/** "12.4-18.9": a range in ms, microseconds kept (a range in a fast trace is a fraction of a millisecond). */
function rangeParam(range: TimeRange | null): string | undefined {
  if (!range) return undefined;
  return `${Number((range[0] / 1000).toFixed(3))}-${Number((range[1] / 1000).toFixed(3))}`;
}

/** One string per slice: two slices are the same when their keys are. */
export function sliceKey(slice: Slice): string {
  const { part, range, logs } = sliceParams(slice);
  return `${part ?? ""}|${range ?? ""}|${logs ?? ""}`;
}
