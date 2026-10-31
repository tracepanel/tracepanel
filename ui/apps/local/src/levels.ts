// Log levels as the Logs page filters by them: the Level menu and the chart's legend say a pick the same way.

/** The levels, lowest first: `level>=warning` is warning and every one after it. */
export const LEVELS = ["debug", "info", "warning", "error", "critical"];

/** The levels `level>=from` lets through: `from` and every one above it (all of them for a level unknown here). */
export function levelsFrom(from: string): string[] {
  return LEVELS.slice(Math.max(LEVELS.indexOf(from.toLowerCase()), 0));
}

/** The lowest level of a pick that is a level and every one above it, more than one; else undefined. */
export function rangeStart(levels: Iterable<string>): string | undefined {
  const picked = new Set(levels);
  const from = LEVELS.find((level) => picked.has(level));
  if (!from || picked.size < 2) return;
  const above = levelsFrom(from);
  return above.length === picked.size && above.every((level) => picked.has(level)) ? from : undefined;
}

/** A pick as the search says it: a level and every one above it as `>=warning`, any other as `warning,critical`. */
export function levelTerm(levels: Iterable<string>): { op: string; value: string } {
  const picked = new Set(levels);
  const from = rangeStart(picked);
  return from ? { op: ">=", value: from } : { op: ":", value: LEVELS.filter((level) => picked.has(level)).join(",") };
}

/** A pick as a chip says it: "WARNING and above", one level, or how many. */
export function levelSummary(levels: Iterable<string>): string | null {
  const picked = [...new Set(levels)];
  const from = rangeStart(picked);
  if (from) return `${from.toUpperCase()} and above`;
  if (picked.length === 0) return null;
  return picked.length === 1 ? (picked[0] ?? "").toUpperCase() : `${picked.length} selected`;
}
