// Tasks in flight as a console lists them (GET /tasks/live): by state, how long each has waited or run, and its
// arguments at a glance. Times are the agent's: `now` comes with the answer, so the browser's clock doesn't matter.
import { duration } from "../format";
import type { LiveTask, LiveTasks } from "../types";

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

/** Since when a task is in its state: a running one since it started, the others since they were (re)sent. */
export function stateSince(task: LiveTask): number | null {
  return task.state === "running" ? task.started_at : task.enqueued_at;
}

/** Its arguments on one line, as the SDK wrote them: `(7,) {'to': 'ann'}`; empty when it sent none. */
export function argumentsOf(task: LiveTask): string {
  return [task.args, task.kwargs && task.kwargs !== "{}" ? task.kwargs : null].filter(Boolean).join(" ");
}
