// Tasks in flight as a console lists them (GET /tasks/live): by state, how long each has waited or run, and its
// arguments at a glance. Times are the agent's: `now` comes with the answer, so the browser's clock doesn't matter.
import { duration } from "../format";
import type { LiveTask, LiveTasks } from "../types";
import { type Json, pythonLiteral } from "./pyliteral";

export type LiveState = LiveTask["state"];

/** The order a page lists them in: what runs now, what waits for a worker, what waits for its next attempt. */
export const LIVE_STATES: readonly LiveState[] = ["running", "queued", "retrying"];

/** The tasks of each state, in the answer's order (newest first). */
export function byState(live: LiveTasks): Record<LiveState, LiveTask[]> {
  const groups: Record<LiveState, LiveTask[]> = { running: [], queued: [], retrying: [] };
  for (const task of live.tasks) groups[task.state].push(task);
  return groups;
}

/** How long since `at` (microseconds), as a clock would say it: "4.2 s", "3m 05s", "1h 12m". */
export function elapsed(now: number, at: number | null): string {
  if (at === null) return "—";
  const us = Math.max(now - at, 0);
  const seconds = Math.floor(us / 1_000_000);
  if (seconds < 60) return duration(us);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`;
}

/**
 * Since when a task is in its state: a running one since it started, the others since they were (re)sent; a retry
 * not sent again yet, since its last attempt started.
 */
export function stateSince(task: LiveTask): number | null {
  return task.state === "running" ? task.started_at : (task.enqueued_at ?? task.started_at);
}

/**
 * Its arguments on one line, as JSON as a trace shows them: `[7] {"to": "ann"}`; none sent, or empty, left out.
 * A value that isn't a Python literal stays as the SDK wrote it.
 */
export function argumentsOf(task: LiveTask): string {
  return [oneLine(task.args), oneLine(task.kwargs)].filter(Boolean).join(" ");
}

function oneLine(text: string | null | undefined): string {
  if (!text) return "";
  const value = pythonLiteral(text);
  if (value === undefined) return text;
  return isEmpty(value) ? "" : inline(value);
}

/** `()`, `[]` or `{}`: nothing sent. */
function isEmpty(value: Json): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}

/** JSON on one line, spaced as it reads: `{"to": "ann", "ids": [3, 5]}`. */
function inline(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}
