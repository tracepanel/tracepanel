import { ago, type DataSource, Empty, type LiveTask, type LiveTasks, type LiveWorker } from "@tracepanel/ui";
import { Badge } from "@tracepanel/ui/components/ui/badge";
import { argumentsOf, byState, elapsed, LIVE_STATES, type LiveState, stateSince } from "@tracepanel/ui/lib/liveTasks";
import { type ReactNode, useCallback } from "react";
import { useSearch } from "./data";
import { LiveToggle, RefreshControl } from "./refresh";
import { groupRoute, href, traceHref } from "./routes";
import { ENTRY, taskSystem } from "./sections";
import { TaskState } from "./tables";
import { DataTable, Loading, Mono, PageHeader, Td, Th, Tr } from "./ui";

/* The Tasks page's Live: what is in flight now, as the apps' task events tell the agent. A task leaves it when it
   ends, and its trace is listed with the others. */

interface Column {
  head: string;
  num?: boolean;
  cell: (task: LiveTask, now: number) => ReactNode;
}

const muted = (text: string | null | undefined) => <span className="text-muted-foreground">{text || "—"}</span>;

const TASK: Column = { head: "Task", cell: (task) => <TaskName task={task} /> };
const SYSTEM: Column = { head: "System", cell: (task) => <SystemBadge system={task.system} /> };
const WORKER: Column = { head: "Worker", cell: (task) => <Mono className="text-sm">{task.worker ?? "—"}</Mono> };
const ID: Column = {
  head: "Task id",
  // Its start is enough to tell tasks apart at a glance; the whole id on hover.
  cell: (task) => (
    <Mono className="block max-w-[6.5rem] truncate text-sm text-muted-foreground" title={task.id}>
      {task.id}
    </Mono>
  ),
};
const ARGUMENTS: Column = { head: "Arguments", cell: (task) => <Arguments task={task} /> };
const QUEUE: Column = { head: "Queue", cell: (task) => (task.queue ? <QueueBadge queue={task.queue} /> : muted(null)) };

/** What each state's table shows: how long it has run, waited, or waits since its retry. */
const COLUMNS: Record<LiveState, readonly Column[]> = {
  running: [
    TASK,
    SYSTEM,
    WORKER,
    { head: "Running for", num: true, cell: (task, now) => elapsed(now, task.started_at) },
    { head: "Attempt", num: true, cell: (task) => task.retries + 1 },
    ID,
    ARGUMENTS,
  ],
  queued: [
    TASK,
    SYSTEM,
    QUEUE,
    { head: "Waiting", num: true, cell: (task, now) => elapsed(now, stateSince(task)) },
    { head: "Enqueued by", cell: (task) => <EnqueuedBy task={task} /> },
    ID,
    ARGUMENTS,
  ],
  retrying: [
    TASK,
    SYSTEM,
    { head: "Next attempt", num: true, cell: (task) => task.retries + 1 },
    { head: "Last error", cell: (task) => <LastError error={task.error} /> },
    { head: "Waiting", num: true, cell: (task, now) => elapsed(now, stateSince(task)) },
    WORKER,
    ID,
  ],
};

const TITLES: Record<LiveState, string> = { running: "Running now", queued: "Queued", retrying: "Retrying" };

/** The Tasks page with Live on: the tasks in flight, refreshed every 2 seconds while Live is on. */
export function LiveTasksPage({ source, nav }: { source: DataSource; nav: ReactNode }) {
  const entry = ENTRY.tasks;
  const live = useSearch(
    useCallback(() => source.liveTasks(), [source]),
    "",
  );
  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-background">
      <PageHeader
        title={entry.title}
        description={entry.description}
        actions={
          <div className="flex items-center">
            <LiveToggle list="tasks" paused={false} on />
            <RefreshControl />
          </div>
        }
      />
      <section className="min-h-0 flex-1 overflow-y-auto px-10 pt-5 pb-10" aria-label="Tasks in flight" data-scroll="">
        {nav}
        {live.data ? <InFlight live={live.data} /> : <Loading />}
      </section>
    </main>
  );
}

function InFlight({ live }: { live: LiveTasks }) {
  const groups = byState(live);
  return (
    <div className="grid gap-8">
      {live.tasks.length === 0 ? <Nothing workers={live.workers} /> : null}
      {LIVE_STATES.map((state) =>
        groups[state].length ? (
          <LiveSection key={state} title={TITLES[state]} count={groups[state].length}>
            <LiveTable tasks={groups[state]} columns={COLUMNS[state]} now={live.now} />
          </LiveSection>
        ) : null,
      )}
      {live.workers.length ? (
        <LiveSection title="Workers" count={live.workers.length}>
          <WorkersTable workers={live.workers} now={live.now} />
        </LiveSection>
      ) : null}
    </div>
  );
}

/** No task in flight; with no worker seen either, how to start one. */
function Nothing({ workers }: { workers: readonly LiveWorker[] }) {
  return (
    <Empty title="No tasks running">
      {workers.length
        ? "Tasks show up here while they are queued, running or waiting for a retry."
        : "No worker has been seen yet. Start one (celery -A proj worker) with tracepanel installed, and its tasks show up here while they are queued, running or waiting for a retry."}
    </Empty>
  );
}

function LiveSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2.5 text-xl font-semibold">
        {title} <span className="font-normal text-muted-foreground">· {count}</span>
      </h2>
      {children}
    </section>
  );
}

function LiveTable({ tasks, columns, now }: { tasks: readonly LiveTask[]; columns: readonly Column[]; now: number }) {
  return (
    <DataTable
      head={columns.map((column) => (
        <Th key={column.head} num={Boolean(column.num)}>
          {column.head}
        </Th>
      ))}
    >
      {tasks.map((task) => (
        <Tr
          key={task.id}
          href={href(groupRoute("tasks", task.name))}
          tone={task.state === "retrying" ? "warn" : undefined}
        >
          {columns.map((column) => (
            <Td key={column.head} num={Boolean(column.num)}>
              {column.cell(task, now)}
            </Td>
          ))}
        </Tr>
      ))}
    </DataTable>
  );
}

function WorkersTable({ workers, now }: { workers: readonly LiveWorker[]; now: number }) {
  return (
    <DataTable
      head={
        <>
          <Th>Worker</Th>
          <Th>System</Th>
          <Th num>In flight</Th>
          <Th num>Last seen</Th>
        </>
      }
    >
      {workers.map((worker) => (
        <Tr key={worker.name} className="cursor-default">
          <Td>
            <Mono>{worker.name}</Mono>
          </Td>
          <Td>
            <SystemBadge system={worker.system} />
          </Td>
          <Td num className={worker.in_flight ? "font-semibold" : "text-muted-foreground"}>
            {worker.in_flight}
          </Td>
          <Td num className="text-muted-foreground">
            {ago(worker.last_seen, now / 1000)}
          </Td>
        </Tr>
      ))}
    </DataTable>
  );
}

function TaskName({ task }: { task: LiveTask }) {
  return <Mono className="block max-w-[26.25rem] truncate">{task.name || "—"}</Mono>;
}

/** The queue system, as the Tasks list names it. */
function SystemBadge({ system }: { system: string }) {
  return (
    <Badge variant="outline" className="text-xs">
      {taskSystem(system)}
    </Badge>
  );
}

function QueueBadge({ queue }: { queue: string }) {
  return (
    <Badge variant="outline" className="font-mono text-xs">
      {queue}
    </Badge>
  );
}

/** Its arguments at a glance, whole on hover. */
function Arguments({ task }: { task: LiveTask }) {
  const text = argumentsOf(task);
  if (!text) return muted(null);
  return (
    <Mono className="block max-w-[16rem] truncate text-sm text-muted-foreground" title={text}>
      {text}
    </Mono>
  );
}

/** The trace that sent it, when it was sent inside one: a request, a command, another task. */
function EnqueuedBy({ task }: { task: LiveTask }) {
  if (!task.enqueued_by) return muted(null);
  return (
    <a href={traceHref(task.enqueued_by.trace_id)} title={task.enqueued_by.trace_id}>
      Open trace
    </a>
  );
}

function LastError({ error }: { error: string | null }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <TaskState state="retry" />
      <Mono className="block max-w-[24rem] truncate text-sm text-error" title={error ?? undefined}>
        {error ?? "—"}
      </Mono>
    </span>
  );
}
