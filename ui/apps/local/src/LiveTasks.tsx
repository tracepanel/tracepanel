import { type DataSource, type LiveTask, type LiveTasks, type LiveWorker, NO_LIVE_TASKS } from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { useStored } from "@tracepanel/ui/hooks/useStored";
import { argumentsOf, byState, elapsed, LIVE_STATES, stateSince } from "@tracepanel/ui/lib/liveTasks";
import { cn } from "@tracepanel/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useSearch } from "./data";
import { useCapability } from "./hooks";
import { groupRoute, href, traceHref } from "./routes";
import { taskSystem } from "./sections";
import { TaskState } from "./tables";
import { DataTable, Mono, Td, Th, Tr } from "./ui";

/* The Tasks page's Now: what is in flight as the apps' task events tell the agent, on one line above the overview,
   and the tasks themselves in a table under it on demand. A task leaves it when it ends, and its run is listed with
   the others. It reloads with the page: every 2 seconds with Live on. */

/** What the page needs to know of Now: the tasks in flight, and whether to show the line at all. */
export interface Now {
  live: LiveTasks | undefined;
  /** An app sends task events, or the agent has some: a project without a task queue has no Now. */
  shown: boolean;
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
  const sends = useCapability(source, "live_tasks");
  const live = useSearch(
    useCallback(() => loadNow(source, tasks), [source, tasks]),
    "",
  ).data;
  return { live, shown: tasks && (sends || hasLive(live)) };
}

const OPEN_KEY = "tracepanel:tasks:now-open";
const readOpen = (raw: unknown): boolean => raw === true;

/** The line: how many tasks run, wait and wait again, and the workers; the tasks in a table when opened. */
export function NowStrip({ now }: { now: Now }) {
  if (!(now.shown && now.live)) return null;
  return <NowLine live={now.live} />;
}

function NowLine({ live }: { live: LiveTasks }) {
  const [open, setOpen] = useStored(OPEN_KEY, readOpen);
  const busy = live.tasks.length > 0;
  return (
    <section className="grid gap-3 pb-5" aria-label="Now">
      <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2 text-md text-text-2">
        {busy ? <NowToggle live={live} open={open} setOpen={setOpen} /> : <NowIdle workers={live.workers} />}
        <Workers workers={live.workers} />
      </div>
      {busy && open ? <InFlightTable live={live} /> : null}
    </section>
  );
}

/** The counts, which open the table of the tasks in flight. */
function NowToggle({ live, open, setOpen }: { live: LiveTasks; open: boolean; setOpen: (open: boolean) => void }) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 rounded-md py-1 text-left"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      <ChevronRightIcon className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
      <NowCounts live={live} />
    </button>
  );
}

/** Nothing in flight: idle, with workers there to run what comes. */
function NowIdle({ workers }: { workers: readonly LiveWorker[] }) {
  return (
    <span className="flex items-center gap-2 py-1 pl-6">
      <span className="font-semibold text-foreground">Now</span>
      {workers.length ? <span className="text-muted-foreground">Idle</span> : null}
    </span>
  );
}

/** "Now · 2 running · 5 queued · 1 retrying": the states with tasks in them. */
function NowCounts({ live }: { live: LiveTasks }) {
  const groups = byState(live);
  return (
    <span className="flex flex-wrap items-center gap-x-2 tabular-nums">
      <span className="font-semibold text-foreground">Now</span>
      {LIVE_STATES.filter((state) => groups[state].length).map((state) => (
        <span key={state} className={cn(state === "retrying" && "text-warn")}>
          · {groups[state].length} {state}
        </span>
      ))}
    </span>
  );
}

/** The workers seen, each with how many tasks it runs now; before any, how to start one. */
function Workers({ workers }: { workers: readonly LiveWorker[] }) {
  if (workers.length === 0) {
    return (
      <span className="text-muted-foreground">
        No worker connected. Start one: <Mono className="text-sm">celery -A &lt;app&gt; worker</Mono>
      </span>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0" aria-label="Workers">
      {workers.map((worker) => (
        <li key={worker.name}>
          <Badge
            variant="outline"
            className="gap-1.5 font-mono text-xs"
            title={`${taskSystem(worker.system)} · ${worker.service}`}
          >
            {worker.name}
            <span className={cn("tabular-nums", worker.in_flight ? "text-brand" : "text-muted-foreground")}>
              {worker.in_flight}
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

interface Column {
  head: string;
  num?: boolean;
  cell: (task: LiveTask, now: number) => ReactNode;
}

const muted = (text: string | null | undefined) => <span className="text-muted-foreground">{text || "—"}</span>;

/** Running, queued and retrying together: how long each has run or waited, the attempt, the last error. */
const COLUMNS: readonly Column[] = [
  { head: "Task", cell: (task) => <Mono className="block max-w-[26.25rem] truncate">{task.name || "—"}</Mono> },
  { head: "State", cell: (task) => <TaskState state={task.state} /> },
  {
    head: "System",
    cell: (task) => (
      <Badge variant="outline" className="text-xs">
        {taskSystem(task.system)}
      </Badge>
    ),
  },
  // Where it is: the worker that runs it, or the queue it waits in.
  { head: "Where", cell: (task) => <Mono className="text-sm">{task.worker ?? task.queue ?? "—"}</Mono> },
  { head: "For", num: true, cell: (task, now) => elapsed(now, stateSince(task)) },
  { head: "Attempt", num: true, cell: (task) => task.retries + 1 },
  // What a glance needs: why the last attempt failed, else what it was given.
  { head: "Details", cell: (task) => (task.error ? <LastError error={task.error} /> : <Arguments task={task} />) },
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
    <DataTable
      head={COLUMNS.map((column) => (
        <Th key={column.head} num={Boolean(column.num)}>
          {column.head}
        </Th>
      ))}
    >
      {/* Keyed by the answer: each refresh starts the clock from the agent's own `now` again. */}
      <TickingRows key={live.now} live={live} />
    </DataTable>
  );
}

function TickingRows({ live }: { live: LiveTasks }) {
  const now = useAgentNow(live);
  return ordered(live).map((task) => (
    <Tr key={task.id} href={rowHref(task)} tone={task.state === "retrying" ? "warn" : undefined}>
      {COLUMNS.map((column) => (
        <Td key={column.head} num={Boolean(column.num)}>
          {column.cell(task, now)}
        </Td>
      ))}
    </Tr>
  ));
}

/** Its arguments at a glance, whole on hover. */
function Arguments({ task }: { task: LiveTask }) {
  const text = argumentsOf(task);
  if (!text) return muted(null);
  return (
    <Mono className="block max-w-[24rem] truncate text-sm text-muted-foreground" title={text}>
      {text}
    </Mono>
  );
}

function LastError({ error }: { error: string }) {
  return (
    <Mono className="block max-w-[24rem] truncate text-sm text-error" title={error}>
      {error}
    </Mono>
  );
}
