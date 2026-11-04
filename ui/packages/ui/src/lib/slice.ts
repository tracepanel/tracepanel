// A part of a trace's time picked to look at: kinds of calls (a share of the time, a filter chip) and a stretch of
// the timeline. Plain data, no React: the call tree draws from it, the console keeps it in its URL.

import { duration } from "../format";
import type { Log } from "../types";
import { isDump } from "./dump";

/** A stretch of the trace's time, in microseconds since it started. */
export type TimeRange = readonly [number, number];

/**
 * Stretches of the trace's time, in order and apart: what a profile is taken over (a code row's own time is its
 * pieces between the calls inside, not the calls).
 */
export type Windows = readonly TimeRange[];

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

/**
 * "11 ms – 1.6 s": where the range starts and ends, as the page says times; where both would read the same, in the
 * end's unit with as many decimals as tell them apart ("170.2 ms – 170.9 ms").
 */
export function rangeLabel(range: TimeRange): string {
  const [from, to] = range;
  const [start, end] = [from === 0 ? "0" : duration(from), duration(to)];
  if (start !== end) return `${start} – ${end}`;
  // Whole µs apart at the most: as many decimals as the unit has µs.
  const [unit, size, most] = to >= 1_000_000 ? ["s", 1_000_000, 6] : to >= 1000 ? ["ms", 1000, 3] : ["µs", 1, 0];
  for (let decimals = Math.min(1, most); decimals <= most; decimals++) {
    const [a, b] = [(from / size).toFixed(decimals), (to / size).toFixed(decimals)];
    if (a !== b || decimals === most) return `${a} ${unit} – ${b} ${unit}`;
  }
  return `${start} – ${end}`;
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

const STRETCH = /^(\d+)-(\d+)$/;

/** Stretches as a link and Back carry them: `from-to`, comma-separated, in whole µs since the trace started. */
export function stretchText(windows: Windows): string {
  return windows.map(([from, to]) => `${Math.round(from)}-${Math.round(to)}`).join(",");
}

/** Stretches from their text (stretchText), in order and apart; undefined where it isn't that. */
export function parseStretch(value: string): Windows | undefined {
  const windows: TimeRange[] = [];
  for (const part of value.split(",")) {
    const found = STRETCH.exec(part);
    if (!found) return undefined;
    const [from, to] = [Number(found[1]), Number(found[2])];
    if (!(to > from) || from < (windows.at(-1)?.[1] ?? 0)) return undefined;
    windows.push([from, to]);
  }
  return windows.length ? windows : undefined;
}

/** How long stretches are in all (µs): a code row's time, and what its profile is profiled of. */
export function windowsTime(windows: Windows): number {
  return windows.reduce((sum, [from, to]) => sum + to - from, 0);
}

/** How many stretches a title names one by one; more read as their time and where they lie. */
const NAMED_WINDOWS = 3;

/**
 * "93 ms – 100 ms", "0 – 38 ms, 97 ms – 100 ms", "46 ms in 5 stretches of 0 – 100 ms": the stretches a profile is
 * of, as its title says them.
 */
export function windowsLabel(windows: Windows): string {
  if (windows.length <= NAMED_WINDOWS) return windows.map(rangeLabel).join(", ");
  const first = windows[0] as TimeRange;
  const last = windows.at(-1) as TimeRange;
  return `${duration(windowsTime(windows))} in ${windows.length} stretches of ${rangeLabel([first[0], last[1]])}`;
}
