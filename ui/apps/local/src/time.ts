/** Times the console writes into searches: ISO with the browser's offset, so the server reads them exactly. */

const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, "0");

/** `2026-10-07T15:27:14+03:00` for a Date or epoch microseconds. */
export function isoWithOffset(at: Date | number): string {
  const date = typeof at === "number" ? new Date(at / 1000) : at;
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

/**
 * The search terms for a time range picked on a chart, [start, end) in epoch µs: whole seconds that hold all of it,
 * the start rounded down and the end up. Rounding the end down would leave out a record in its last second.
 */
export function rangeTerms(start: number, end: number): { since: string; until: string } {
  const second = 1_000_000;
  return {
    since: isoWithOffset(Math.floor(start / second) * second),
    until: isoWithOffset(Math.ceil(end / second) * second),
  };
}

/** A since:/until: value as a Date, when it is an absolute time (not "15m"). */
export function parseAbsolute(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** What <input type="datetime-local"> shows and takes: local `YYYY-MM-DDTHH:MM`. */
export function toLocalInput(date: Date): string {
  return isoWithOffset(date).slice(0, 16);
}

/** Short local form for chips and buttons: `15:27:14`, or `Oct 7, 15:27` on another day. */
export function shortTime(date: Date): string {
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
