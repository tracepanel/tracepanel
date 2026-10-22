import {
  type Capabilities,
  type DataColumn,
  type DataSource,
  DataTable,
  type LiveTask,
  type LiveTasks,
  type LiveWorker,
  NO_LIVE_TASKS,
  TaskName,
  type TraceSummary,
} from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { useStored } from "@tracepanel/ui/hooks/useStored";
import { argumentsOf, byState, elapsed, LIVE_STATES, stateSince } from "@tracepanel/ui/lib/liveTasks";
import { cn } from "@tracepanel/ui/lib/utils";
import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useSearch } from "./data";
import { useCapabilities } from "./hooks";
import { FIGURE, Figure, OverviewNumbers } from "./Overview";
import { groupRoute, href, traceHref } from "./routes";
import { taskSystem } from "./sections";
import { TaskState } from "./tables";
import { Mono, Tr } from "./ui";

/* The Tasks page's Now: what is in flight as the apps' task events tell the agent, on one line above the overview,
   and the tasks themselves in a table under it on demand. A task leaves it when it ends, and its run is listed with
   the others. It reloads with the page: every 2 seconds with Live on. */

/** What the page needs to know of Now: the tasks in flight, and whether to show the line at all. */
export interface Now {
  live: LiveTasks | undefined;
  /** The latest run that ended: idle says when, so a queue whose tasks end in milliseconds still shows it works. */
  last: TraceSummary | undefined;
  /** An app sends task events, or the agent has some: a project without a task queue has no Now. */
  shown: boolean;
  /** Whether `shown` is known: the tasks in flight and the capabilities answered (always, off Tasks). */
  settled: boolean;
}

/** The newest run of a task, if any ended. */
async function latestRun(source: DataSource): Promise<TraceSummary | undefined> {
  return (await source.searchTraces("kind:task")).items[0];
}

/** Nothing in flight for a page other than Tasks: it asks nothing. */
function loadNow(source: DataSource, tasks: boolean): Promise<LiveTasks> {
  return tasks ? source.liveTasks() : Promise.resolve(NO_LIVE_TASKS);
}

function hasLive(live: LiveTasks | undefined): boolean {
  return Boolean(live && (live.tasks.length || live.workers.length));
}

/** Now, for Tasks only: other entry points ask nothing. */
export function useNow(source: DataSource, tasks: boolean): Now {
  const capabilities = useCapabilities(source);
  const live = useSearch(
    useCallback(() => loadNow(source, tasks), [source, tasks]),
    "",
  ).data;
  const last = useSearch(
    useCallback(() => (tasks ? latestRun(source) : Promise.resolve(undefined)), [source, tasks]),
    "",
  ).data;
  return { live, last, shown: tasks && sendsOrHas(capabilities, live), settled: !tasks || both(capabilities, live) };
}

/** An app says it sends task events, or the agent has some. */
function sendsOrHas(capabilities: Capabilities | undefined, live: LiveTasks | undefined): boolean {
  return capabilities?.live_tasks === true || hasLive(live);
}

function both(capabilities: Capabilities | undefined, live: LiveTasks | undefined): boolean {
  return capabilities !== undefined && live !== undefined;
}

const OPEN_KEY = "tracepanel:tasks:now-open";
const readOpen = (raw: unknown): boolean => raw === true;

/** The line: how many tasks run, wait and wait again, and the workers; the tasks in a table when opened. */
export function NowStrip({ now }: { now: Now }) {
  if (!(now.shown && now.live)) return null;
  return <NowLine live={now.live} last={now.last} />;
}

function NowLine({ live, last }: { live: LiveTasks; last: TraceSummary | undefined }) {
  const [open, setOpen] = useStored(OPEN_KEY, readOpen);
  const busy = live.tasks.length > 0;
  return (
    <section className="grid gap-3 pb-5" aria-label="Now">
      {/* The Overview's bar: what runs now, its numbers as the Overview says them, then the workers at its end. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-4 py-3 text-md">
        {busy ? (
          <NowToggle live={live} open={open} setOpen={setOpen} />
        ) : (
          <NowIdle workers={live.workers} last={last} />
        )}
        <Workers workers={live.workers} />
      </div>
      {busy && open ? <InFlightTable live={live} /> : null}
    </section>
  );
}

/** A light for the queue's state: pulsing while tasks run, steady when workers wait, hollow with none. */
function Light({ state }: { state: "busy" | "ready" | "none" }) {
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden="true">
      {state === "busy" ? <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-60" /> : null}
      <span
        className={cn("relative size-2 rounded-full", state === "none" ? "border-2 border-muted-foreground" : "bg-ok")}
      />
    </span>
  );
}

/** The counts, which open the table of the tasks in flight. */
function NowToggle({ live, open, setOpen }: { live: LiveTasks; open: boolean; setOpen: (open: boolean) => void }) {
  return (
    <button
      type="button"
      className="flex items-center gap-3 rounded-md py-1 text-left focus-visible:outline-2 focus-visible:outline-ring"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      {/* The Overview's own chevron, size and gap: "Now" stands over "Overview". */}
      <ChevronRightIcon className={cn("size-5 text-muted-foreground transition-transform", open && "rotate-90")} />
      <NowCounts live={live} />
    </button>
  );
}

/** Nothing in flight: idle, with workers there to run what comes and the last run; or no worker. */
function NowIdle({ workers, last }: { workers: readonly LiveWorker[]; last: TraceSummary | undefined }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-8">
      <span className="font-semibold text-foreground">Now</span>
      <Light state={workers.length ? "ready" : "none"} />
      <OverviewNumbers>
        <span className={FIGURE}>
          <b className="font-semibold text-foreground">{workers.length ? "Idle" : "No worker connected"}</b>
        </span>
        {last ? <LastRun run={last} /> : null}
      </OverviewNumbers>
    </span>
  );
}

/** "last run refresh_stats ✓ 12s ago", ticking: the queue works even when its tasks end too fast to be seen. */
function LastRun({ run }: { run: TraceSummary }) {
  const now = useClock();
  const failed = run.status === "error";
  return (
    <a href={traceHref(run.id)} className={cn(FIGURE, "min-w-0 hover:[&_bdi]:underline")}>
      <span className="whitespace-nowrap text-muted-foreground">last run</span>{" "}
      <TaskName name={run.name} className="text-sm font-medium text-foreground" />{" "}
      {failed ? (
        <XIcon className="size-4 shrink-0 self-center text-error" aria-label="failed" />
      ) : (
        <CheckIcon className="size-4 shrink-0 self-center text-ok" aria-label="succeeded" />
      )}{" "}
      <span className="whitespace-nowrap text-muted-foreground">{ago(now - (run.start + run.duration) / 1000)}</span>
    </a>
  );
}

/** "just now", "12s ago", "3m ago", "2h ago". */
function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** The time now, once a second. */
function useClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "Now  2 running | 5 queued | 1 retrying": the states with tasks in them. */
function NowCounts({ live }: { live: LiveTasks }) {
  const groups = byState(live);
  return (
    <span className="flex flex-wrap items-center gap-x-3">
      <span className="font-semibold text-foreground">Now</span>
      <Light state="busy" />
      <OverviewNumbers>
        {LIVE_STATES.filter((state) => groups[state].length).map((state) => (
          <Figure
            key={state}
            value={groups[state].length}
            label={state}
            tone={state === "retrying" ? "warn" : "plain"}
          />
        ))}
      </OverviewNumbers>
    </span>
  );
}

/** The workers seen, each with what it does now; none before any is seen ("No worker connected" says so). */
function Workers({ workers }: { workers: readonly LiveWorker[] }) {
  if (workers.length === 0) return null;
  return (
    <ul className="m-0 ml-auto flex list-none flex-wrap items-center gap-1.5 p-0" aria-label="Workers">
      {workers.map((worker) => (
        <li key={worker.name}>
          <Badge
            variant="outline"
            className="gap-1.5 bg-background text-xs font-normal"
            // The app it serves, not a system: one app's worker runs @Async and Kafka alike, and its last task's
            // system would flip the label.
            title={worker.service}
          >
            <Light state={worker.in_flight ? "busy" : "ready"} />
            <span className="font-mono">{worker.name}</span>{" "}
            <span className={cn("tabular-nums", worker.in_flight ? "text-foreground" : "text-muted-foreground")}>
              {worker.in_flight ? `${worker.in_flight} running` : "idle"}
            </span>
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** The agent's clock now: its answer's `now`, moved on by the time since it came, so elapsed times tick. */
function useAgentNow(live: LiveTasks): number {
  const [received] = useState(() => ({ at: Date.now(), now: live.now }));
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return received.now + (Date.now() - received.at) * 1000;
}

/** A task in flight, and the agent's clock as it ticks: how long it has run or waited is worked out from both. */
interface Ticking {
  task: LiveTask;
  now: number;
}

const muted = (text: string | null | undefined) => <span className="text-muted-foreground">{text || "—"}</span>;

/** Running, queued and retrying together: how long each has run or waited, the attempt, the last error. */
const COLUMNS: DataColumn<Ticking>[] = [
  {
    id: "task",
    label: "Task",
    required: true,
    cell: ({ task }) => (task.name ? <TaskName name={task.name} /> : muted(null)),
  },
  { id: "state", label: "State", width: 7, cell: ({ task }) => <TaskState state={task.state} /> },
  {
    id: "system",
    label: "System",
    width: 7.5,
    cell: ({ task }) => (
      <Badge variant="outline" className="text-xs">
        {taskSystem(task.system)}
      </Badge>
    ),
  },
  // Where it is: the worker that runs it, or the queue it waits in.
  { id: "where", label: "Where", width: 10, cell: ({ task }) => <Where task={task} /> },
  { id: "for", label: "For", width: 7, num: true, cell: ({ task, now }) => elapsed(now, stateSince(task)) },
  { id: "attempt", label: "Attempt", width: 6.5, num: true, cell: ({ task }) => task.retries + 1 },
  // What a glance needs: why the last attempt failed, else what it was given.
  {
    id: "details",
    label: "Details",
    width: 13,
    cell: ({ task }) => (task.error ? <LastError error={task.error} /> : <Arguments task={task} />),
  },
];

/** The rows ordered as the line counts them: running, then queued, then retrying; newest first in each. */
function ordered(live: LiveTasks): LiveTask[] {
  const groups = byState(live);
  return LIVE_STATES.flatMap((state) => groups[state]);
}

/** Where a row leads: the trace that enqueued it, else the task's own page. */
function rowHref(task: LiveTask): string {
  return task.enqueued_by ? traceHref(task.enqueued_by.trace_id) : href(groupRoute("tasks", task.name));
}

function InFlightTable({ live }: { live: LiveTasks }) {
  return (
    <DataTable table="tasks:now" columns={COLUMNS}>
      {/* Keyed by the answer: each refresh starts the clock from the agent's own `now` again. */}
      {({ cells }) => <TickingRows key={live.now} live={live} cells={cells} />}
    </DataTable>
  );
}

function TickingRows({ live, cells }: { live: LiveTasks; cells: (item: Ticking) => ReactNode }) {
  const now = useAgentNow(live);
  return ordered(live).map((task) => (
    <Tr key={task.id} href={rowHref(task)} tone={task.state === "retrying" ? "warn" : undefined}>
      {cells({ task, now })}
    </Tr>
  ));
}

/** Its arguments at a glance, whole on hover. */
// A long value cut to one line, whole on hover: the table fits the page's width, as the console's other tables do.
const CUT = "block truncate text-sm";

/** Where a task is: the worker that runs it, or the queue it waits in. */
function Where({ task }: { task: LiveTask }) {
  const where = task.worker ?? task.queue;
  if (!where) return muted(null);
  return (
    <Mono className={CUT} title={where}>
      {where}
    </Mono>
  );
}

function Arguments({ task }: { task: LiveTask }) {
  const text = argumentsOf(task);
  if (!text) return muted(null);
  return (
    <Mono className={cn(CUT, "text-muted-foreground")} title={text}>
      {text}
    </Mono>
  );
}

function LastError({ error }: { error: string }) {
  return (
    <Mono className={cn(CUT, "text-error")} title={error}>
      {error}
    </Mono>
  );
}
