import { duration, localTime, stamp } from "./format";
import { LinkedTrace, single, tracesRow } from "./LinkedTrace";
import { plural } from "./lib/plural";
import { linkProps, type TraceLinks, traceLinkProps } from "./links";
import type { PropRow } from "./PropTable";
import type { Attrs, Related, Trace, TraceSummary } from "./types";

type Workflow = NonNullable<Related["workflow"]>;

function text(value: unknown): string | null {
  return value === undefined || value === null || value === "" ? null : String(value);
}

/** A gap between two moments, roughly: 840 ms, 40 s, 3 min, 2.0 h. */
function roughly(us: number): string {
  const seconds = us / 1_000_000;
  if (seconds < 1) return duration(us);
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** An ISO 8601 time as epoch µs; one without an offset is UTC, as the SDKs write a naive one. */
function isoMicros(value: string): number | null {
  const zoned = /(z|[+-]\d\d:?\d\d)$/i.test(value) ? value : `${value}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? null : ms * 1000;
}

/** When it was due beside when it started: on time, "2 min late", or "in 3 min" (it started before). */
function dueWhen(due: number, started: number): string {
  const gap = started - due;
  if (Math.abs(gap) < 1_000_000) return "on time";
  return gap > 0 ? `${roughly(gap)} late` : `in ${roughly(-gap)}`;
}

/** When a delayed task was due (task.eta): its moment as the console writes one, and how that compares. */
function dueRows(trace: Trace): PropRow[] {
  const eta = text(trace.attrs["task.eta"]);
  const due = eta ? isoMicros(eta) : null;
  if (!eta) return [];
  if (due === null) return [{ label: "Due", value: eta, copy: eta, mono: true }];
  const value = (
    <span title={localTime(due)}>
      <span className="font-mono text-xs">{stamp(due)}</span>
      <span className="text-muted-foreground"> · {dueWhen(due, trace.start)}</span>
    </span>
  );
  return [{ label: "Due", value, copy: eta }];
}

/** A time limit in seconds as people say it: 30 s, 2.5 s, 5 min. */
function limitText(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${(seconds / 60).toFixed(1)} min`;
}

/** Its time limit (task.timeout): an SDK records it on a run the limit stopped. */
function limitRows(trace: Trace): PropRow[] {
  const seconds = Number(trace.attrs["task.timeout"]);
  if (!(seconds > 0)) return [];
  const stopped = trace.status === "error" || text(trace.attrs["task.state"])?.toUpperCase() === "FAILURE";
  const value = (
    <span>
      {limitText(seconds)}
      {stopped ? <span className="text-error"> · stopped by its time limit</span> : null}
    </span>
  );
  return [{ label: "Time limit", value, copy: String(seconds) }];
}

/** A task's own timing facts: when it was due, its priority, its time limit. */
export function taskTimingRows(trace: Trace): PropRow[] {
  const priority = text(trace.attrs["task.priority"]);
  return [
    ...dueRows(trace),
    ...(priority ? [{ label: "Priority", value: priority, copy: priority, mono: true }] : []),
    ...limitRows(trace),
  ];
}

/** What a task id leads to: the trace of its latest run, that run's name where related lists it, and the links. */
interface Steps {
  runs: Record<string, string>;
  names: Map<string, string>;
  /** How many tasks its group has. */
  groupTasks: number | undefined;
  links: TraceLinks | undefined;
}

function stepsOf(related: Related | undefined, links: TraceLinks | undefined): Steps {
  if (!related?.workflow) return { runs: {}, names: new Map(), groupTasks: undefined, links };
  const workflow = related.workflow;
  const named = [related.enqueued_by, workflow.root, ...workflow.follows];
  const names = new Map(named.flatMap((run) => (run ? [[run.id, run.name] as const] : [])));
  return { runs: workflow.runs, names, groupTasks: workflow.group?.tasks, links };
}

/** Where a run's trace opens, when the host links traces. */
function traceLink(steps: Steps, traceId: string | undefined): ReturnType<typeof traceLinkProps> | null {
  if (!traceId) return null;
  return traceLinkProps(steps.links, traceId) ?? null;
}

/** A task as its latest run is named, or by its id. */
function taskLabel(steps: Steps, traceId: string | undefined, task: string): string {
  return (traceId && steps.names.get(traceId)) || task;
}

/** A task by its id: a link to its latest run's trace, by the run's name, where the agent has one. */
function TaskLink({ task, steps }: { task: string; steps: Steps }) {
  const traceId = steps.runs[task];
  const label = taskLabel(steps, traceId, task);
  const link = traceLink(steps, traceId);
  if (!link) {
    return (
      <span className="font-mono text-xs" title={`${task}: no run of this task is stored`}>
        {label}
      </span>
    );
  }
  return (
    <a className="font-mono text-xs text-brand hover:underline" title={task} {...link}>
      {label}
    </a>
  );
}

function linkRow(label: string, task: string | null, steps: Steps): PropRow[] {
  if (!task) return [];
  return [{ label, value: <TaskLink task={task} steps={steps} />, copy: task }];
}

/** The tasks it waits for beside its parent (RQ's depends_on). */
function waitsFor(attrs: Attrs, parent: string | null): string[] {
  const ids = attrs["task.depends_on"];
  const all = Array.isArray(ids) ? ids.map(String) : [];
  return all.filter((id) => id !== parent);
}

function waitsRows(attrs: Attrs, parent: string | null, steps: Steps): PropRow[] {
  const others = waitsFor(attrs, parent);
  if (others.length === 0) return [];
  const value = (
    <span className="flex min-w-0 flex-wrap gap-x-2">
      {others.map((task) => (
        <TaskLink key={task} task={task} steps={steps} />
      ))}
    </span>
  );
  return [{ label: "Waits for", value, copy: others.join(" ") }];
}

/** A search for a group's runs, as a link where the host has searches. */
function GroupSearch({ group, links, children }: { group: string; links: TraceLinks | undefined; children: string }) {
  if (!links?.search) return <>{children}</>;
  return (
    <a className="text-brand hover:underline" title={group} {...linkProps(links, links.search(`group:${group}`))}>
      {children}
    </a>
  );
}

/** Its group (task.group_id): how many tasks it has, a link to their runs. */
function groupRows(attrs: Attrs, steps: Steps): PropRow[] {
  const group = text(attrs["task.group_id"]);
  if (!group) return [];
  const tasks = steps.groupTasks;
  const value = (
    <GroupSearch group={group} links={steps.links}>
      {tasks ? plural(tasks, "task", "tasks") : group}
    </GroupSearch>
  );
  return [{ label: "Group", value, copy: group }];
}

/** A task run's place in its workflow: what it follows (or is the callback of), what it waits for, its root, its group. */
export function workflowFacts(trace: Trace, related: Related | undefined, links: TraceLinks | undefined): PropRow[] {
  const attrs = trace.attrs;
  const steps = stepsOf(related, links);
  const parent = text(attrs["task.parent_id"]);
  const root = text(attrs["task.root_id"]);
  const callback = text(attrs["task.callback"]);
  return [
    ...linkRow(callback ? `Callback (${callback}) of` : "Follows", parent, steps),
    ...waitsRows(attrs, parent, steps),
    ...linkRow("Root", root === parent ? null : root, steps),
    ...groupRows(attrs, steps),
  ];
}

/* ---------- the Related traces part: the workflow's runs ---------- */

/** How many of a group's other tasks are listed before a search for them all. */
const GROUP_SHOWN = 5;

/** The rest of a long group: how many more, and a search for them all. */
function MoreInGroup({
  group,
  more,
  links,
}: {
  group: NonNullable<Workflow["group"]>;
  more: number;
  links: TraceLinks | undefined;
}) {
  return (
    <span className="flex items-center gap-2 text-sm text-muted-foreground">
      <span>+{more} more</span>
      {links?.search ? <GroupSearch group={group.id} links={links}>{`All ${group.tasks} tasks`}</GroupSearch> : null}
    </span>
  );
}

/** Its group's other tasks: the first few, each with how it ended and how long it took, then a search for the rest. */
function groupPart(workflow: Workflow, links: TraceLinks | undefined): PropRow[] {
  const group = workflow.group;
  if (!group) return [];
  const shown = group.runs.slice(0, GROUP_SHOWN);
  const more = group.tasks - Number(group.member) - shown.length;
  const value = (
    <span className="grid w-full gap-0.5">
      {shown.map((run) => (
        <LinkedTrace key={run.id} group={single(run)} links={links} />
      ))}
      {more > 0 ? <MoreInGroup group={group} more={more} links={links} /> : null}
    </span>
  );
  return [{ label: `Group (${plural(group.tasks, "task", "tasks")})`, id: "workflow-group", value }];
}

/** A callback's kind beside its name: on_success. */
function CallbackNote({ kind }: { kind: string }) {
  return <span className="shrink-0 font-mono text-xs text-muted-foreground">{kind}</span>;
}

/** The runs before this one: the task run that sent it (its enqueued_by) and those it follows by id. */
function previousRuns(related: Related, workflow: Workflow): TraceSummary[] {
  const sender = related.enqueued_by?.kind === "task" ? [related.enqueued_by] : [];
  return [...sender, ...workflow.follows];
}

/** The runs after this one: the tasks it sent and those that follow it by id. */
function nextRuns(related: Related, workflow: Workflow): TraceSummary[] {
  return [...related.enqueued.filter((trace) => trace.kind === "task"), ...workflow.followed_by];
}

export interface WorkflowPart {
  rows: PropRow[];
  /** The linked traces it lists: the other rows leave them out. */
  taken: Set<string>;
}

/** The rows of a workflow's runs under their heading: its root, the runs before and after this one, its callbacks,
 * its group. */
function workflowRows(trace: Trace, related: Related, workflow: Workflow, links: TraceLinks | undefined): PropRow[] {
  const after = nextRuns(related, workflow);
  const isCallback = (run: TraceSummary) => run.id in workflow.callbacks;
  const callbackOf = text(trace.attrs["task.callback"]) !== null;
  const rows = [
    ...tracesRow("Root", "Root", workflow.root ? [workflow.root] : [], links),
    ...tracesRow(
      callbackOf ? "Callback of" : "Previous step",
      "Previous steps",
      previousRuns(related, workflow),
      links,
    ),
    ...tracesRow(
      "Next step",
      "Next steps",
      after.filter((run) => !isCallback(run)),
      links,
    ),
    ...tracesRow("Callback", "Callbacks", after.filter(isCallback), links, (run) => (
      <CallbackNote kind={workflow.callbacks[run.id] ?? ""} />
    )),
    ...groupPart(workflow, links),
  ];
  return rows.length ? [{ label: "Workflow", heading: true, value: "" }, ...rows] : [];
}

/** A task run's workflow in its related traces; the runs it lists. */
export function workflowPart(trace: Trace, related: Related | undefined, links: TraceLinks | undefined): WorkflowPart {
  if (!related?.workflow) return { rows: [], taken: new Set() };
  const workflow = related.workflow;
  const taken = new Set([...previousRuns(related, workflow), ...nextRuns(related, workflow)].map((run) => run.id));
  return { rows: workflowRows(trace, related, workflow, links), taken };
}
