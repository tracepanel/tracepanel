/** Microseconds to a short human duration: "0.4 ms", "142 ms", "1.8 s". */
export function duration(us: number): string {
  const ms = us / 1000;
  if (ms < 0.1) return `${Math.round(us)} µs`;
  if (ms < 1) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Epoch microseconds to "12s ago", "3m ago", or a time of day. */
export function ago(us: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - us / 1000) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return new Date(us / 1000).toLocaleTimeString([], { hour12: false });
}

export type Tone = "ok" | "warn" | "error";

export function tone(status: number | null, issues: number): Tone {
  if ((status ?? 200) >= 500) return "error";
  return issues > 0 ? "warn" : "ok";
}

/** Share of `part` in `total` as a whole percent string. */
export function percent(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";
}

/** A moment as a log line shows it, to the millisecond, in local time: 14:03:21.146. */
function clock(us: number): string {
  const at = new Date(us / 1000);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${time}.${String(at.getMilliseconds()).padStart(3, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A moment as a log row shows it, its day with it, in local time: Oct 21 15:45:20.345. Every row the same, today's
 * too: one width down the column, and a row read alone still says which day.
 */
export function stamp(us: number): string {
  const at = new Date(us / 1000);
  return `${MONTHS[at.getMonth()]} ${String(at.getDate()).padStart(2, "0")} ${clock(us)}`;
}

/** A moment in full, in local time, as its row shows it plus the date and the offset: 2026-10-20 15:27:31.008 +03:00. */
export function localTime(us: number): string {
  const at = new Date(us / 1000);
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  const offset = -at.getTimezoneOffset();
  const zone = `${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock(us)} ${zone}`;
}

/** When a record was made, said in words: "146 ms after the request started". */
export function since(us: number, start: number): string {
  return `${duration(Math.max(us - start, 0))} after the request started`;
}
