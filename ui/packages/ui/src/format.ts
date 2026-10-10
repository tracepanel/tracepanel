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
  return new Date(us / 1000).toLocaleTimeString();
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
