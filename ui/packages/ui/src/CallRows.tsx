import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { CodeRow, indentOf } from "./CallCode";
import {
  CHAIN_LEVELS,
  childrenOf,
  type Mark,
  type Node,
  ownChildren,
  type Remote,
  rootOf,
  type ServedRun,
  SKEW_NOTE_MIN,
  type SpanNode,
} from "./callTree";
import { DumpBadge, DumpLine } from "./Dump";
import { duration, since } from "./format";
import { ChevronRightIcon } from "./icons";
import { NoAnswer } from "./LiveMarks";
import { withoutAnsi } from "./lib/ansi";
import type { Category } from "./lib/breakdown";
import { answers, callAnswer, cutLength, type GroupAnswer, groupAnswer, unfinished } from "./lib/callAnswer";
import { templatePlace } from "./lib/callFields";
import { callTemplate, callText, groupNoun } from "./lib/calls";
import { isDump } from "./lib/dump";
import { spanKindLabel } from "./lib/handler";
import { foldKeys } from "./lib/keys";
import { cutNote, isCut } from "./lib/live";
import { pageParts } from "./lib/page";
import { plural } from "./lib/plural";
import { type Quiet, quietSpans } from "./lib/quiet";
import { traceRuntime } from "./lib/runtime";
import type { Slice, Windows } from "./lib/slice";
import { type TraceLinks, traceLinkProps } from "./links";
import { MigrationNotes } from "./Migrations";
import { RowFlame } from "./ProfileHint";
import {
  AliasChip,
  AppChip,
  FailedStatus,
  GroupStatus,
  ISSUE_CHIP_SHRINKS,
  IssueChip,
  KindBadge,
  StateBadge,
  StatusBadge,
  TaskName,
  TemplateChip,
  Times,
} from "./primitives";
import { RunChips } from "./RunChips";
import { SignalNotes } from "./SignalNotes";
import type { IssueKind, Span, Trace, TraceSummary } from "./types";
import { GroupNotTraced, NotTraced, useUntraced } from "./Untraced";

export interface RowContext {
  trace: Trace;
  issueBySpan: ReadonlyMap<string, IssueKind>;
  selected: string | null;
  onSelect: (key: string) => void;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Set while filters are on: only marked rows show. */
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** The selected row's details, opened right under that row; null while they show in the side pane. */
  details: ReactNode;
  /** How many info and debug records each span has that don't show, by its id; and what shows them. */
  hiddenLogs: ReadonlyMap<string, number>;
  onShowLogs: () => void;
  /** Whose code the code rows under are: this trace's, or a call's trace opened under its call. */
  code: CodeOwner;
  categories: ReadonlyMap<string, Category>;
  /** What is picked: a code row shows with its share picked, or a range it overlaps. */
  slice: Slice;
  /**
   * Opens another trace's profile (a call's trace from another app, by its id), at a stretch of it where given: its
   * row's flame and its code rows lead there. None where the host can't open one.
   */
  onTraceProfile: TraceProfileOpener | undefined;
  profilesIn: ProfilesIn | undefined;
  /** Loads the links of a call's trace opened in the tree: the calls it made in turn open under it. */
  onChain: (traceId: string) => void;
  /** The stretch of the span rows are under, which no bar of theirs is drawn past (and see Clock). */
  within?: Within | undefined;
}

type Within = readonly [number, number];

/** Opens a trace's profile by its id, at stretches of it (µs since it started) where given. */
export type TraceProfileOpener = (traceId: string, windows?: Windows) => void;

/**
 * The trace whose own code the code rows under a row are: this one's, or a call's trace from another app opened under
 * its call (on this trace's clock), with its own profile. `quiet`: its spans whose own code ran long with nothing
 * recorded inside (as the strip says them); `onProfile` opens its profile at a stretch, when it has one.
 */
export interface CodeOwner {
  trace: Trace;
  quiet: ReadonlyMap<string, Quiet>;
  onProfile: ((windows: Windows) => void) | undefined;
  /** Its app profiles a request when asked: untraced code then says how to see what ran. */
  profiles: boolean;
}

/** A call's trace as the owner of the code rows under it: its own quiet spans, its own profile. */
function ownerFor(whole: Trace, open: TraceProfileOpener | undefined, profilesIn: ProfilesIn | undefined): CodeOwner {
  const onProfile = open && whole.profile ? (windows: Windows) => open(whole.id, windows) : undefined;
  return { trace: whole, quiet: quietSpans(whole), onProfile, profiles: profilesIn?.(whole) === true };
}

/** Whether the app that recorded a trace profiles a request when asked. */
export type ProfilesIn = (trace: Trace) => boolean;

/** The stretch of a call, inside the one rows are already kept in. */
function narrowed(within: Within | undefined, call: Span): Within {
  const [from, to] = [call.start, call.start + call.duration];
  if (!within) return [from, to];
  const start = Math.min(Math.max(from, within[0]), within[1]);
  return [start, Math.max(Math.min(to, within[1]), start)];
}

/** A bar's start and length cut to the stretch it is kept in. */
function clipped(start: number, length: number, within: Within | undefined): [number, number] {
  if (!within) return [start, length];
  const from = Math.min(Math.max(start, within[0]), within[1]);
  const to = Math.min(Math.max(start + length, within[0]), within[1]);
  return [from, to - from];
}

/** The selected row's details, under it: where the click was, not past the end of a long tree. */
function RowDetails({ id, ctx }: { id: string; ctx: RowContext }) {
  const box = useRef<HTMLDivElement>(null);
  const shown = ctx.selected === id;
  // A row near the bottom edge: scrolled just enough for the details to start in view.
  useEffect(() => {
    const top = box.current?.getBoundingClientRect().top;
    if (shown && top !== undefined && top > window.innerHeight - 64) box.current?.scrollIntoView({ block: "nearest" });
  }, [shown]);
  if (!shown || !ctx.details) return null;
  return (
    <div className="dt-map-inline" ref={box}>
      {ctx.details}
    </div>
  );
}

function Bar({
  trace,
  start,
  length,
  point,
  cut,
  within,
}: {
  trace: Trace;
  start: number;
  length: number;
  point?: boolean;
  /** A call cut short (see cutLength): it fades out where it was cut, as one that runs past the end does. */
  cut?: boolean;
  within?: Within | undefined;
}) {
  const [from, long] = clipped(start, length, within);
  const place = point ? pointPlace(trace, from) : barPlace(trace, from, long);
  const past = place.past ?? (cut ? "" : undefined);
  return (
    <span className="dt-map-track" aria-hidden="true">
      <span className="dt-map-bar" data-point={point ? "" : undefined} data-past={past} style={place.style} />
    </span>
  );
}

/** Where a point sits on the request's timeline. */
function pointPlace(trace: Trace, at: number): { style: CSSProperties; past: undefined } {
  const left = Math.min(Math.max(((at - trace.start) / Math.max(trace.duration, 1)) * 100, 0), 100);
  return { style: { left: `${left}%` }, past: undefined };
}

/** The least of the track a run that starts after the request ended still shows, at its right edge. */
const PAST_MIN = 6;

/**
 * Where a bar sits on the request's timeline. One that runs past its end (a task runs longer than the request that
 * enqueued it, or starts after it answered) runs to the right edge and fades out there (`past`).
 */
function barPlace(trace: Trace, start: number, length: number): { style: CSSProperties; past: "" | undefined } {
  const total = Math.max(trace.duration, 1);
  const left = Math.min(Math.max(((start - trace.start) / total) * 100, 0), 100 - PAST_MIN);
  const past = start + length > trace.start + total;
  const width = past ? 100 - left : Math.max((length / total) * 100, 0.4);
  return { style: { left: `${left}%`, width: `${width}%` }, past: past ? "" : undefined };
}

/** A trace of its own under a span of this one: a task (or one waiting for a worker), or another app's trace. */
export type Linked = Extract<Node, { type: "task" | "waiting" }>;

/** How a linked row looks: its kind, its text, its bar on the request's timeline and its time. */
interface LinkedView {
  status: string | undefined;
  kind: string;
  text: ReactNode;
  track: ReactNode;
  time: string;
  timeTitle?: string | undefined;
}

/** A task's run in a worker, or the trace another app served for a call. */
function runView(node: Extract<Node, { type: "task" }>, trace: Trace, within: Within | undefined): LinkedView {
  return {
    status: node.run.status,
    kind: node.kind === "call" ? "app" : "task",
    text: (
      <>
        {node.kind === "task" ? (
          <TaskName name={node.run.name} className="dt-map-text" />
        ) : (
          <span className="dt-map-text">{node.run.name}</span>
        )}
        <TaskState state={node.run.task_state} />
        {node.kind === "call" ? <CallApp node={node} /> : null}
        {/* What its own trace found, before it is opened. */}
        <RowChips>
          <RunChips trace={node.run} />
        </RowChips>
      </>
    ),
    track: <Bar trace={trace} start={node.run.start} length={node.run.duration} within={within} />,
    time: duration(node.run.duration),
    timeTitle: clockNote(node),
  };
}

/** What moving a call's trace onto this clock did, said on its time, when it did more than round off a little. */
function clockNote(node: Extract<Node, { type: "task" }>): string | undefined {
  const { clock, run } = node;
  if (!clock) return undefined;
  const call = duration(clock.call.duration);
  if (run.duration > clock.call.duration) {
    const more = duration(run.duration - clock.call.duration);
    return `Served in ${duration(run.duration)} by its app's clock, ${more} more than the ${call} call took by this one's: the two disagree. Drawn inside the call.`;
  }
  if (Math.abs(clock.shift) < SKEW_NOTE_MIN) return undefined;
  const side = clock.shift < 0 ? "ahead of" : "behind";
  const away = duration(clock.call.duration - run.duration);
  return `Its app's clock is ${duration(Math.abs(clock.shift))} ${side} this one's: drawn centred in the ${call} call, the ${away} not spent serving it split before and after.`;
}

/** Which app served a call: its runtime's mark, and its project (another agent's) or its service (this one's). */
function CallApp({ node }: { node: Extract<Node, { type: "task" }> }) {
  const name = appName(node);
  return name ? <AppChip name={name} runtime={traceRuntime(node.whole?.attrs ?? {})} compact /> : null;
}

export function appName(node: Extract<Node, { type: "task" }>): string | undefined {
  const service = node.whole?.attrs["service.name"];
  return node.remote?.project ?? (typeof service === "string" ? service : undefined);
}

/** A task enqueued that no worker has run yet. */
function waitingView(node: Extract<Node, { type: "waiting" }>, trace: Trace): LinkedView {
  return {
    status: undefined,
    kind: "task",
    text: <span className="dt-map-text dt-map-waiting">waiting for a worker…</span>,
    track: <span className="dt-map-track" aria-hidden="true" />,
    time: `+${duration(Math.max(node.span.start - trace.start, 0))}`,
  };
}

/** A trace of its own under a span of this one: a task (or one waiting for a worker), or another app's trace. */
function LinkedRow({
  node,
  ctx,
  indent,
  depth,
  dim,
}: {
  node: Linked;
  ctx: RowContext;
  indent: CSSProperties;
  depth: number;
  dim: boolean;
}) {
  const children = childrenOf(node);
  // Open from the start (what the other app did is why it is here), but for one of many deeper down the chain: a
  // click on the fold turns it the other way.
  const open =
    children.length > 0 ? dim || (node.type === "waiting" || node.opened) !== ctx.collapsed.has(node.key) : undefined;
  useChainLoad(node, open, ctx.onChain);
  const inner = useLinkedContext(node, ctx);
  const root = node.type === "task" ? node.whole?.spans.find((span) => span.parent_id === null) : undefined;
  return (
    <div>
      <LinkedButton node={node} ctx={inner} indent={indent} dim={dim} open={open} />
      <RowDetails id={node.key} ctx={ctx} />
      {open ? (
        <>
          <Rows nodes={children} depth={depth + 1} ctx={inner} />
          {/* Its request's own code, as a span's is under its rows: the request is this row. */}
          {root ? <CodeRow span={root} ctx={inner} depth={depth + 1} /> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * What the rows of a call's trace are drawn with: no bar past the call's end (see Clock), and that trace's own code
 * and profile for their code rows.
 */
function useLinkedContext(node: Linked, ctx: RowContext): RowContext {
  const call = node.type === "task" ? node.clock?.call : undefined;
  const whole = node.type === "task" && !node.remote ? node.whole : undefined;
  const open = ctx.onTraceProfile;
  const profilesIn = ctx.profilesIn;
  const code = useMemo(() => (whole ? ownerFor(whole, open, profilesIn) : undefined), [whole, open, profilesIn]);
  return {
    ...ctx,
    ...(call ? { within: narrowed(ctx.within, call) } : {}),
    ...(code ? { code } : {}),
  };
}

/** A call's trace whose own calls can open under it: this agent's, not too far down the chain. */
function chainedTrace(node: Linked): string | undefined {
  if (node.type !== "task" || node.remote || node.level >= CHAIN_LEVELS) return undefined;
  return node.whole?.id;
}

/**
 * While a call's trace is open, the links of its own calls load: the traces they reached open under them. Asked
 * before the row paints: the tree counts them on their way from its first frame ("More on its way" never blinks).
 */
function useChainLoad(node: Linked, open: boolean | undefined, onChain: (traceId: string) => void): void {
  const whole = chainedTrace(node);
  useLayoutEffect(() => {
    if (open && whole) onChain(whole);
  }, [open, whole, onChain]);
}

/** The linked row itself; `open` is set when it has rows to fold: a first click selects it, a second folds it. */
function LinkedButton({
  node,
  ctx,
  indent,
  dim,
  open,
}: {
  node: Linked;
  ctx: RowContext;
  indent: CSSProperties;
  dim: boolean;
  open: boolean | undefined;
}) {
  const view = linkedView(node, ctx.trace, ctx.within);
  const selected = ctx.selected === node.key;
  return (
    <button
      type="button"
      className="dt-map-row"
      data-dim={dim ? "" : undefined}
      data-kind="task"
      data-status={view.status}
      aria-expanded={open}
      aria-current={selected ? "true" : undefined}
      onClick={() => {
        if (selected && open !== undefined) ctx.onToggle(node.key);
        ctx.onSelect(node.key);
      }}
      onKeyDown={foldKeys(open, () => ctx.onToggle(node.key))}
    >
      <span className="dt-map-name" style={indent}>
        <Caret open={open} onToggle={() => ctx.onToggle(node.key)} />
        <KindBadge kind={view.kind} muted={true} className="dt-map-kind" />
        {view.text}
        <LinkedFlame node={node} ctx={ctx} />
      </span>
      {view.track}
      <span className="dt-map-time" title={view.timeTitle}>
        {view.time}
      </span>
    </button>
  );
}

/** A call's trace with a profile: its flame, as a code row's, and a click on it opens that trace's profile. */
function LinkedFlame({ node, ctx }: { node: Linked; ctx: RowContext }) {
  const whole = node.type === "task" ? node.whole : undefined;
  if (!whole?.profile) return null;
  const open = ctx.onTraceProfile;
  return <RowFlame trace={whole} onOpen={open && !hasRemote(node) ? () => open(whole.id) : undefined} />;
}

function hasRemote(node: Linked): boolean {
  return node.type === "task" && node.remote !== undefined;
}

function linkedView(node: Linked, trace: Trace, within: Within | undefined): LinkedView {
  return node.type === "task" ? runView(node, trace, within) : waitingView(node, trace);
}

/** Where a row is drawn: how deep, how far in, whether it is only on the way to a filtered row, under which span. */
interface RowPlace {
  ctx: RowContext;
  indent: CSSProperties;
  depth: number;
  mark: Mark | undefined;
  parent: Span | undefined;
}

type RowProps<T extends Node["type"]> = { node: Extract<Node, { type: T }>; place: RowPlace };

export function Rows({
  nodes,
  depth,
  ctx,
  parent,
}: {
  nodes: Node[];
  depth: number;
  ctx: RowContext;
  parent?: Span | undefined;
}) {
  return (
    <>
      {nodes.map((node) => {
        const mark = ctx.marks?.get(node.key);
        if (ctx.marks && !mark) return null;
        const place = { ctx, indent: indentOf(depth), depth, mark, parent };
        return <Row key={node.key} node={node} place={place} />;
      })}
    </>
  );
}

/**
 * How slow a call reads beside its time, as the trace's share it took: amber from a fifth, red from a half. The
 * request's own code (its view, its framework) takes most of it by nature: only calls to a system say it.
 */
function slowness(time: number, trace: Trace, category: Category | undefined): "warn" | "error" | undefined {
  if (category === undefined || OWN_TIME.has(category)) return undefined;
  const share = time / Math.max(trace.duration, 1);
  if (share >= 0.5) return "error";
  return share >= 0.2 ? "warn" : undefined;
}

const OWN_TIME: ReadonlySet<Category> = new Set(["django", "code", "template", "signal"]);

/** A row's time, tabular, in amber or red when the call took much of the trace. */
function RowTime({
  time,
  slow,
  title,
}: {
  time: number;
  slow: "warn" | "error" | undefined;
  title?: string | undefined;
}) {
  return (
    <span className="dt-map-time" data-slow={slow} title={title}>
      {duration(time)}
    </span>
  );
}

const ROWS: { [T in Node["type"]]: (props: RowProps<T>) => ReactNode } = {
  span: SpanRow,
  group: GroupRow,
  log: LeafRow,
  error: LeafRow,
  task: PlacedLinkedRow,
  waiting: PlacedLinkedRow,
};

function Row(props: RowProps<Node["type"]>) {
  const Shown = ROWS[props.node.type] as (props: RowProps<Node["type"]>) => ReactNode;
  return <Shown {...props} />;
}

/** A row's state as its button says it: dimmed on the way to a filtered row, current while selected. */
function rowState(ctx: RowContext, key: string, mark: Mark | undefined) {
  return {
    "data-dim": mark === "path" ? "" : undefined,
    "aria-current": ctx.selected === key ? ("true" as const) : undefined,
  };
}

/** A row's alias chip: none when its name already says it (`transaction app.sqlite3`). */
function aliasBeside(span: Span): unknown {
  const alias = aliasOf(span);
  return typeof alias === "string" && span.name.includes(alias) ? undefined : alias;
}

/** A call's database, cache or storage alias, when it has one. */
function aliasOf(span: Span | undefined): unknown {
  return span?.attrs["db.alias"] ?? span?.attrs["cache.alias"] ?? span?.attrs["storage.alias"];
}

function PlacedLinkedRow({ node, place: { ctx, indent, depth, mark } }: { node: Linked; place: RowPlace }) {
  return <LinkedRow node={node} ctx={ctx} indent={indent} depth={depth} dim={mark === "path"} />;
}

/** How a log record or an error reads as a row: its kind, its level, when, what it says. */
function leafView(node: Extract<Node, { type: "log" | "error" }>) {
  if (node.type === "error") {
    const text = `${node.error.type.replace(/^builtins\./, "")}: ${node.error.message}`;
    return { kind: "error", level: "error", time: node.error.time, text };
  }
  // A dump is a kind of its own, its badge and its line: printed to be looked at, not logged.
  if (isDump(node.log)) return { kind: "dump", level: "dump", time: node.log.time, text: "" };
  return { kind: "log", level: node.log.level, time: node.log.time, text: withoutAnsi(node.log.message) };
}

/** A leaf's badge: its level, muted, or a dump's own. */
function LeafBadge({ kind, level }: { kind: string; level: string }) {
  if (kind === "dump") return <DumpBadge className="dt-map-kind" />;
  return <KindBadge kind={level} muted={true} className="dt-map-kind" />;
}

/** A leaf's text: a dump's call site and first value, coloured; any other's message or error. */
function LeafText({ node, text }: { node: Extract<Node, { type: "log" | "error" }>; text: string }) {
  if (node.type === "log" && isDump(node.log)) return <DumpLine log={node.log} className="dt-map-text" />;
  return <span className="dt-map-text">{text}</span>;
}

/** A log record or an error: a point on the timeline, at its time since the request started. */
function LeafRow({
  node,
  place: { ctx, indent, mark },
}: {
  node: Extract<Node, { type: "log" | "error" }>;
  place: RowPlace;
}) {
  const view = leafView(node);
  return (
    <>
      <button
        type="button"
        className="dt-map-row"
        {...rowState(ctx, node.key, mark)}
        data-kind={view.kind}
        data-level={view.level}
        onClick={() => ctx.onSelect(node.key)}
      >
        <span className="dt-map-name" style={indent}>
          <span className="dt-map-caret" />
          <LeafBadge kind={view.kind} level={view.level} />
          <LeafText node={node} text={view.text} />
        </span>
        <Bar trace={ctx.trace} start={view.time} length={0} point={true} within={ctx.within} />
        <span className="dt-map-time" title={`Logged ${since(view.time, ctx.trace.start)}`}>
          +{duration(Math.max(view.time - ctx.trace.start, 0))}
        </span>
      </button>
      <RowDetails id={node.key} ctx={ctx} />
    </>
  );
}

/**
 * The template a call ran from, unless the row it hangs under is that template, named already (a line of it still
 * says where).
 */
function FromTemplate({ span, parent }: { span: Span | undefined; parent: Span | undefined }) {
  if (!span || saidAbove(span, parent)) return null;
  return <TemplateChip attrs={span.attrs} />;
}

/** Whether the row a call hangs under is the template it ran from. */
function saidAbove(span: Span, parent: Span | undefined): boolean {
  return parent?.kind === "template" && parent.name === templatePlace(span.attrs);
}

/** A group's kind, its call's template, its alias, the page template that made it, how many, how they went and its issue. */
function GroupName({
  node,
  ctx,
  parent,
  answer,
}: {
  node: Extract<Node, { type: "group" }>;
  ctx: RowContext;
  parent: Span | undefined;
  answer: GroupAnswer;
}) {
  const issue = groupIssue(node, ctx.issueBySpan);
  const first = node.spans[0];
  return (
    <>
      <KindBadge kind={spanKindLabel(first?.kind, ctx.trace.attrs)} muted={true} className="dt-map-kind" />
      <OpText text={callTemplate(first)} kind={first?.kind} />
      <AliasChip value={aliasOf(first)} />
      <FromTemplate span={first} parent={parent} />
      <Times count={node.spans.length} />
      <GroupStatus answer={answer} />
      <GroupNotTraced spans={node.spans} />
      <RowChips>{issue ? <IssueChip kind={issue} className={ISSUE_CHIP_SHRINKS} /> : null}</RowChips>
    </>
  );
}

/** The calls a group's issue is on: its own, or a resolver's call it repeats, right under it (Book.author's GET /authors/{id}). */
function groupSpans(node: Extract<Node, { type: "group" }>): Span[] {
  return [...node.spans, ...node.members.flatMap(childSpans)];
}

function groupIssue(node: Extract<Node, { type: "group" }>, issueBySpan: ReadonlyMap<string, IssueKind>) {
  return groupSpans(node)
    .map((span) => issueBySpan.get(span.id))
    .find(Boolean);
}

/**
 * The issues an open group's calls show: not the group's own, which its row says once (an N+1 is the 36 calls
 * together, not each of them); another one a call has on its own still shows on its row.
 */
function withoutGroupIssue(
  node: Extract<Node, { type: "group" }>,
  issueBySpan: ReadonlyMap<string, IssueKind>,
): ReadonlyMap<string, IssueKind> {
  const issue = groupIssue(node, issueBySpan);
  if (!issue) return issueBySpan;
  const said = new Set(groupSpans(node).map((span) => span.id));
  return new Map([...issueBySpan].filter(([id, kind]) => !(said.has(id) && kind === issue)));
}

/**
 * A row's chips after its name: its issue, then what a call's trace found. Short of room they go whole, the last
 * first, onto a line that doesn't show (.dt-map-chips): never a chip cut down to an empty pill.
 */
function RowChips({ children }: { children: ReactNode }) {
  return <span className="dt-map-chips">{children}</span>;
}

/** Repeats of one call folded into one row (×N), its calls as ticks on the timeline; open, each call a row. */
function GroupRow({ node, place: { ctx, indent, depth, mark, parent } }: RowProps<"group">) {
  const open = ctx.collapsed.has(`open:${node.key}`);
  const wall = node.end - node.start;
  const issueBySpan = useMemo(() => withoutGroupIssue(node, ctx.issueBySpan), [node, ctx.issueBySpan]);
  const answer = useMemo(() => groupAnswerOf(node), [node]);
  return (
    <div className="dt-map-group">
      <button
        type="button"
        className="dt-map-row"
        {...rowState(ctx, node.key, mark)}
        data-kind={node.spans[0]?.kind}
        data-category={ctx.categories.get(node.spans[0]?.id ?? "")}
        data-status={answer.tone}
        aria-expanded={open}
        onClick={() => {
          ctx.onSelect(node.key);
          ctx.onToggle(`open:${node.key}`);
        }}
        onKeyDown={foldKeys(open, () => ctx.onToggle(`open:${node.key}`))}
      >
        <span className="dt-map-name" style={indent}>
          <Caret open={open} onToggle={() => ctx.onToggle(`open:${node.key}`)} />
          <GroupName node={node} ctx={ctx} parent={parent} answer={answer} />
        </span>
        <GroupTicks spans={node.spans} trace={ctx.trace} within={ctx.within} />
        <RowTime
          time={wall}
          slow={slowness(wall, ctx.trace, ctx.categories.get(node.spans[0]?.id ?? ""))}
          title={groupTimes(node)}
        />
      </button>
      <RowDetails id={node.key} ctx={ctx} />
      {open ? (
        <Rows nodes={node.members} depth={depth + 1} ctx={{ ...ctx, marks: undefined, issueBySpan }} parent={parent} />
      ) : null}
    </div>
  );
}

/** How a group's calls went, each with the trace served for it as its own row takes it (see rowStatus). */
function groupAnswerOf(node: Extract<Node, { type: "group" }>): GroupAnswer {
  return groupAnswer(node.members.map((member) => ({ span: member.span, served: member.served?.run })));
}

/**
 * A group's time: from its first call's start to its last one's end, as long as the request waited for them (36
 * calls run side by side take about one call's time); what they took added up is the second figure.
 */
function groupTimes(node: Extract<Node, { type: "group" }>): string {
  const total = node.spans.reduce((sum, span) => sum + span.duration, 0);
  const noun = groupNoun(node.spans[0], node.spans.length);
  return `${node.spans.length} ${noun} · ${duration(total)} total, ${duration(node.end - node.start)} from the first's start to the last's end`;
}

/** Where each call of a group started, on the request's timeline. */
function GroupTicks({ spans, trace, within }: { spans: readonly Span[]; trace: Trace; within: Within | undefined }) {
  return (
    <span className="dt-map-track" aria-hidden="true">
      {spans.map((span) => {
        const [at] = clipped(span.start, 0, within);
        const left = Math.min(Math.max(((at - trace.start) / Math.max(trace.duration, 1)) * 100, 0), 100);
        return <span key={span.id} className="dt-map-bar" data-tick="" style={{ left: `${left}%` }} />;
      })}
    </span>
  );
}

/** The spans right under a row: a signal's receivers among them. */
function childSpans(node: Extract<Node, { type: "span" }>): Span[] {
  return ownChildren(node).flatMap((child) => (child.type === "span" ? [child.span] : []));
}

/** A span's fold: none without rows under it; open unless folded, always on the way to a filtered row. */
function spanFold(node: Extract<Node, { type: "span" }>, mark: Mark | undefined, ctx: RowContext): boolean | undefined {
  const hasChildren = node.children.length > 0;
  return foldOf(hasChildren, hasChildren && (mark === "path" || !ctx.collapsed.has(node.key)));
}

/** First click selects the row (and opens it); a second click closes its details (and folds it). */
function clickSpan(ctx: RowContext, key: string, fold: boolean | undefined): void {
  // Closed and not selected yet, or open and selected: the click folds it too.
  if (fold === (ctx.selected === key)) ctx.onToggle(key);
  ctx.onSelect(key);
}

const TASK_SPANS = new Set(["task", "task.enqueue"]);

const ENQUEUE = "enqueue ";

/** A span's name; a task's run, or its sending, named as a task is everywhere (the kind says which). */
function SpanName({ span }: { span: Span }) {
  if (span.kind === "task.enqueue" && span.name.startsWith(ENQUEUE)) {
    // "enqueue " stays whole: only the task's name gives way.
    return (
      <span className="dt-map-text flex">
        <span className="shrink-0 whitespace-pre">{ENQUEUE}</span>
        <TaskName name={span.name.slice(ENQUEUE.length)} />
      </span>
    );
  }
  if (TASK_SPANS.has(span.kind)) return <TaskName name={span.name} className="dt-map-text" />;
  return <OpText text={callText(span)} kind={span.kind} />;
}

// What a call does, then what to: SELECT shop_product, GET api.example.com/users, SET session:*.
const OP = /^([A-Z][A-Z_]+)( .*)$/;

/**
 * A call's text, its operation set apart: a statement's verb or a command a little stronger than what it acts on,
 * an HTTP call's method in its colour as every list shows one.
 */
function OpText({ text, kind, className }: { text: string; kind: string | undefined; className?: string }) {
  const op = OP.exec(text);
  const classes = className ? `dt-map-text ${className}` : "dt-map-text";
  if (!op) return <span className={classes}>{text}</span>;
  return (
    <span className={classes}>
      <span className="dt-map-op" data-method={kind === "http.client" ? op[1] : undefined}>
        {op[1]}
      </span>
      {op[2]}
    </span>
  );
}

/** A span: its kind, its name and what goes with it, its bar and its time; its rows under it, open or folded. */
function SpanRow({ node, place }: RowProps<"span">) {
  return node.served ? <HopRow node={node} served={node.served} place={place} /> : <OwnRow node={node} place={place} />;
}

/** A span's time; a call the page sent its trace before it ended, with no trace served for it, has none known. */
function OwnTime({ span, ctx }: { span: Span; ctx: RowContext }) {
  if (answers(span) && span.duration === 0 && unfinished(span)) {
    return (
      <span className="dt-map-time" title={UNENDED_NOTE}>
        —
      </span>
    );
  }
  // Cut short, no answer yet: its time is where it was cut, not how slow it was (lib/live): never amber or red.
  if (isCut(span)) return <RowTime time={span.duration} slow={undefined} title={cutNote(span.duration)} />;
  const slow = span.parent_id === null ? undefined : slowness(span.duration, ctx.trace, ctx.categories.get(span.id));
  return <RowTime time={span.duration} slow={slow} title={timeTitle(span, ctx.trace)} />;
}

/** A span's bar; a call cut short runs to where it was cut, fading out there, never a 0-width mark. */
function OwnBar({ span, ctx }: { span: Span; ctx: RowContext }) {
  const cut = cutLength(span, ctx.trace);
  return (
    <Bar trace={ctx.trace} start={span.start} length={cut ?? span.duration} cut={cut !== null} within={ctx.within} />
  );
}

function OwnRow({ node, place: { ctx, indent, depth, mark, parent } }: RowProps<"span">) {
  const { span } = node;
  const fold = spanFold(node, mark, ctx);
  const issue = ctx.issueBySpan.get(span.id);
  return (
    <div>
      <button type="button" {...spanButton(ctx, node, mark, fold)} data-root={span.parent_id === null ? "" : undefined}>
        <span className="dt-map-name" style={indent}>
          <CallLead call={answers(span)} span={span}>
            <SpanFold ctx={ctx} node={node} parent={parent} fold={fold} />
            <SpanName span={span} />
          </CallLead>
          <CallStatus node={node} />
          <NotTraced spanId={span.id} />
          <AliasChip value={aliasBeside(span)} />
          <FromTemplate span={span} parent={parent} />
          <SignalNotes span={span} parent={parent} under={childSpans(node)} />
          <MigrationNotes span={span} />
          <HiddenLogs count={ctx.hiddenLogs.get(span.id)} onShow={ctx.onShowLogs} />
          <RowChips>{issue ? <IssueChip kind={issue} className={ISSUE_CHIP_SHRINKS} /> : null}</RowChips>
        </span>
        <OwnBar span={span} ctx={ctx} />
        <OwnTime span={span} ctx={ctx} />
      </button>
      <RowDetails id={node.key} ctx={ctx} />
      {fold ? (
        <>
          {/* A child's bar never runs past its parent's: an SDK timing starts to the millisecond and durations to
              the microsecond puts a call that ends with its caller a little past it. */}
          <Rows
            nodes={node.children}
            depth={depth + 1}
            ctx={{ ...ctx, within: narrowed(ctx.within, span) }}
            parent={span}
          />
          <CodeRow span={span} ctx={ctx} depth={depth + 1} />
        </>
      ) : null}
    </div>
  );
}

/* ---------- a call and the trace served for it, one row ---------- */

// A call's method and where it went: the host, the app chip beside it says better.
const HOST = /^([A-Z]+ )(?:[a-z][a-z0-9+.-]*:\/\/)?[^/\s]+(\/\S*)?$/;

/** A merged call's text: its method and path ("POST /graphql"), the host left to the app chip. */
export function hopText(span: Span): string {
  const text = callText(span);
  const found = HOST.exec(text);
  return found ? `${found[1]}${found[2] ?? "/"}` : text;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a trace's name says no more than the call's path: "GET /authors/{id}" for GET /authors/2. */
function sameRoute(text: string, name: string): boolean {
  const pathOf = (each: string) => (each.replace(/^[A-Z]+ /, "").split("?")[0] ?? "").replace(/(.)\/$/, "$1");
  const [path, route] = [pathOf(text), pathOf(name)];
  if (path === route) return true;
  const parts = route.split(/\{[^}]+\}|<[^>]+>|:[A-Za-z_]\w*/);
  return parts.length > 1 && new RegExp(`^${parts.map(escaped).join("[^/]+")}$`).test(path);
}

/** The served trace's name, where it says more than the path (a GraphQL operation's): what grows in the row. */
function ServedName({ text, name }: { text: string; name: string }) {
  const shown = sameRoute(text, name) ? "" : name;
  return (
    <span className="dt-map-text dt-map-hop-name" title={shown || undefined}>
      {shown}
    </span>
  );
}

/** The call's bar, the way there and back pale; the server's time inside it, solid, on the call's clock (Clock). */
function HopBar({
  trace,
  span,
  run,
  within,
}: {
  trace: Trace;
  span: Span;
  run: TraceSummary;
  within: Within | undefined;
}) {
  const [from, long] = clipped(span.start, span.duration, within);
  const call = barPlace(trace, from, long);
  const [at, length] = clipped(run.start, run.duration, narrowed(within, span));
  const server = barPlace(trace, at, length);
  return (
    <span className="dt-map-track" aria-hidden="true">
      <span className="dt-map-bar" data-call="" data-past={call.past} style={call.style} />
      <span className="dt-map-bar" data-server="" style={server.style} />
    </span>
  );
}

/** A call cut short, on its time's hover. */
const CUT_NOTE =
  "The page sent its trace before this call ended (a route change, or its longest wait): its time is until the trace served for it ended";

/** A call cut short with no trace served for it: its time isn't known. */
const UNENDED_NOTE =
  "The page sent its trace before this call ended (a route change, or its longest wait): its time isn't known";

/** A merged call's time on hover: the server's part and the rest (the network, a queue), and what its clock did. */
function hopTimes(span: Span, served: ServedRun): string {
  const server = served.run.duration;
  // Longer than the call by the caller's clock: the two clocks disagree (the note says), no network time to say.
  const split =
    server > span.duration
      ? `server ${duration(server)} by its app's clock`
      : `server ${duration(server)} · network ${duration(span.duration - server)}`;
  const note = clockNote(served);
  return note ? `${split}\n${note}` : split;
}

/**
 * A call merged with the trace another app served for it (see hopOf): open, that trace's rows straight under it, by
 * the chain's rules (one of many deeper down starts folded); a first click selects it, as a span's.
 */
function HopRow({ node, served, place }: { node: SpanNode; served: ServedRun; place: RowPlace }) {
  const { ctx, indent, depth, mark, parent } = place;
  const { span } = node;
  const has = node.children.length > 0;
  const fold = foldOf(has, has && (mark === "path" || served.opened !== ctx.collapsed.has(node.key)));
  useChainLoad(served, fold, ctx.onChain);
  const inner = useLinkedContext(served, ctx);
  const root = served.whole?.spans.find((each) => each.parent_id === null);
  const under = { ...inner, within: narrowed(ctx.within, span) };
  const text = hopText(span);
  return (
    <div>
      <button type="button" {...spanButton(ctx, node, mark, fold)} data-hop="">
        <span className="dt-map-name" style={indent}>
          <CallLead span={span}>
            <SpanFold ctx={ctx} node={node} parent={parent} fold={fold} />
            <OpText text={text} kind={span.kind} className="dt-map-hop-path" />
            <span className="dt-map-hop" aria-hidden="true">
              →
            </span>
            <span className="sr-only">served by</span>
            <CallApp node={served} />
            <ServedName text={text} name={served.run.name} />
          </CallLead>
          {/* After what served it: the answer is the served trace's when the call says none. */}
          <CallStatus node={node} />
          <FromTemplate span={span} parent={parent} />
          <HiddenLogs count={ctx.hiddenLogs.get(span.id)} onShow={ctx.onShowLogs} />
          <RowChips>
            <HopIssue span={span} served={served} ctx={ctx} />
            <RunChips trace={served.run} />
          </RowChips>
          <LinkedFlame node={served} ctx={ctx} />
        </span>
        <HopBar trace={ctx.trace} span={span} run={served.run} within={ctx.within} />
        <RowTime
          time={span.duration}
          slow={slowness(span.duration, ctx.trace, ctx.categories.get(span.id))}
          title={node.cut ? `${CUT_NOTE}\n${hopTimes(span, served)}` : hopTimes(span, served)}
        />
      </button>
      <RowDetails id={node.key} ctx={ctx} />
      {fold ? (
        <>
          <Rows nodes={node.children} depth={depth + 1} ctx={under} />
          {/* The served request's own code, as a span's is under its rows: the request is this row. */}
          {root ? <CodeRow span={root} ctx={under} depth={depth + 1} /> : null}
          <CodeRow span={span} ctx={ctx} depth={depth + 1} />
        </>
      ) : null}
    </div>
  );
}

/** The call's own issue (an N+1 of calls), unless the served trace's chips say that one already. */
function HopIssue({ span, served, ctx }: { span: Span; served: ServedRun; ctx: RowContext }) {
  const issue = ctx.issueBySpan.get(span.id);
  if (!issue || served.run.issue_kinds.includes(issue)) return null;
  return <IssueChip kind={issue} className={ISSUE_CHIP_SHRINKS} />;
}

/**
 * What a call's row says before its answer (its fold, kind, text, what served it): short of room, it gives way and is
 * cut at its end, so the answer after it stays whole however narrow the tree and deep the row. A row with no answer
 * to keep (`call` false: a query, a function) is as it was, its text cut first.
 */
function CallLead({ call = true, span, children }: { call?: boolean; span: Span; children: ReactNode }) {
  // Said "not traced" after its status: what is before both gives way to all that is left.
  const untraced = useUntraced(span.id) !== undefined;
  if (!call) return children;
  return (
    <span
      className="dt-map-lead"
      data-http={span.kind === "http.client" ? "" : undefined}
      data-untraced={untraced ? "" : undefined}
    >
      {children}
    </span>
  );
}

/** A row's look by how it went: a call by what it was answered (5xx or none red, 4xx amber), else its span's status. */
function rowStatus(node: SpanNode): string {
  if (!answers(node.span)) return node.span.status;
  const { tone } = callAnswer(node.span, node.served?.run);
  return tone ?? node.span.status;
}

/**
 * What a call was answered, beside its name: its status code as every list shows one, "failed" when no answer came
 * (a connection error, a timeout). Nothing for a call that says neither.
 */
function CallStatus({ node }: { node: SpanNode }) {
  if (!answers(node.span)) return null;
  const { status, tone } = callAnswer(node.span, node.served?.run);
  if (status !== null) return <StatusBadge status={status} />;
  // Cut short with no trace served for it yet: still waiting, said so, as everywhere such a call shows (lib/live).
  if (isCut(node.span) && !node.served) return <NoAnswer at={node.span.duration} />;
  if (tone !== "error") return null;
  const failure = node.span.attrs["error.type"];
  return <FailedStatus failure={typeof failure === "string" ? failure : undefined} />;
}

/** A span row's button: its state, kind and share; a click selects it and opens it, the arrows fold it. */
function spanButton(ctx: RowContext, node: SpanNode, mark: Mark | undefined, fold: boolean | undefined) {
  const { span } = node;
  return {
    className: "dt-map-row",
    ...rowState(ctx, node.key, mark),
    "data-kind": span.kind,
    "data-category": ctx.categories.get(span.id),
    "data-status": rowStatus(node),
    "aria-expanded": fold,
    onClick: () => clickSpan(ctx, node.key, fold),
    onKeyDown: foldKeys(fold, () => ctx.onToggle(node.key)),
  };
}

/** A span row's fold and its kind's badge. */
function SpanFold({
  ctx,
  node,
  parent,
  fold,
}: {
  ctx: RowContext;
  node: SpanNode;
  parent: Span | undefined;
  fold: boolean | undefined;
}) {
  return (
    <>
      <Caret open={fold} onToggle={() => ctx.onToggle(node.key)} />
      <KindBadge kind={rowKind(node.span, ctx.trace, parent)} muted={true} className="dt-map-kind" />
    </>
  );
}

/** A row's kind as its badge says it: a browser's view or action as its list names it (view, click, bg). */
function rowKind(span: Span, trace: Trace, parent: Span | undefined): string {
  if (span.kind === "page") return pageParts(span.name).badge.toLowerCase();
  return spanKindLabel(span.kind, trace.attrs, parent?.kind);
}

/** Whether a span runs inside another, however deep. */
function insideOf(ancestor: Span, byId: ReadonlyMap<string, Span>): (span: Span) => boolean {
  return (span) => {
    for (let at = byId.get(String(span.parent_id)); at; at = byId.get(String(at.parent_id))) {
      if (at.id === ancestor.id) return true;
    }
    return false;
  };
}

/** The SQL a transaction ran: its queries' time, nested ones too. */
function sqlInside(transaction: Span, trace: Trace): number {
  const inside = insideOf(transaction, new Map(trace.spans.map((span) => [span.id, span])));
  return trace.spans
    .filter((span) => span.kind === "sql" && inside(span))
    .reduce((sum, span) => sum + span.duration, 0);
}

/**
 * What a row's time is, on hover, where it isn't plain: a transaction's is how long it was open, of which the SQL
 * inside took a part; the rest is code running while it is held, not the database.
 */
function timeTitle(span: Span, trace: Trace): string | undefined {
  if (span.kind !== "transaction") return undefined;
  const sql = duration(sqlInside(span, trace));
  return `Open ${duration(span.duration)}; SQL inside took ${sql}, the rest is code running while it's held`;
}

/* ---------- the code's own time ---------- */

/**
 * The fold of a row with rows under it: a click on it opens or closes them only, without selecting the row and
 * opening its details. A row without any has the empty slot, so names line up.
 */
function Caret({ open, onToggle }: { open: boolean | undefined; onToggle: () => void }) {
  if (open === undefined) return <span className="dt-map-caret" />;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: inside the row's button; the keyboard folds with the arrows (foldKeys).
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row's button takes the keys.
    <span
      className="dt-map-caret"
      data-toggle=""
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <ChevronRightIcon />
    </span>
  );
}

/** A row's fold: open or closed, or none for a row with nothing under it. */
function foldOf(hasChildren: boolean, open: boolean): boolean | undefined {
  return hasChildren ? open : undefined;
}

function TaskState({ state }: { state: string | null }) {
  return state ? <StateBadge state={state} /> : null;
}

/* ---------- details of the selected row ---------- */

/** How a run's details name it: a task a worker ran, or the trace another app served for a call. */
export const RUN_WORDS = {
  task: { what: "task", label: "Task", open: "Open the task's trace →" },
  call: { what: "served by another app", label: "Trace", open: "Open the trace it served →" },
} as const;

/** A run's numbers: its name, a task's state, its queries and issues. */
export function runRows(run: TraceSummary, label: string) {
  return [
    { label, value: run.name, copy: run.name, mono: true },
    ...(run.task_state ? [{ label: "State", value: <TaskState state={run.task_state} /> }] : []),
    { label: "Queries", value: String(run.queries) },
    ...(run.issues ? [{ label: "Issues", value: String(run.issues) }] : []),
  ];
}

/** A trace of its own this trace led to: what it was, when it started, how long it took, a link to it. */
/** Where a linked trace opens: here, or in its own project's console in a tab of its own. */
export function OpenRun({
  run,
  words,
  links,
  remote,
  whole,
}: {
  run: TraceSummary;
  words: { open: string };
  links?: TraceLinks | undefined;
  remote?: Remote | undefined;
  /** The run's trace, when this agent has it whole: it opens with its root row selected. */
  whole?: Trace | undefined;
}) {
  if (remote) {
    return (
      <a className="dt-map-open" href={`${remote.console}#/t/${run.id}`} target="_blank" rel="noopener">
        Open in {remote.project}'s console
      </a>
    );
  }
  // A row of the call tree leads to the run's own call tree, on the row that stands for all of it.
  const open = traceLinkProps(links, run.id, { tab: "tree", span: whole ? rootOf(whole) || undefined : undefined });
  return open ? (
    <a className="dt-map-open" {...open}>
      {words.open}
    </a>
  ) : null;
}

/** What is under the selected row, as its details show it right under their title (see UnderThis). */
export const UnderSlot = createContext<ReactNode>(null);

export function Inside() {
  return useContext(UnderSlot);
}

/**
 * A span's info and debug records, while only warnings and worse show: how many, quietly. A click shows every
 * record (the legend's Logs chip turns on).
 */
function HiddenLogs({ count, onShow }: { count: number | undefined; onShow: () => void }) {
  if (!count) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: inside the row's button; a click here shows the records.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the legend's Logs chip is the keyboard's way.
    <span
      className="dt-map-sub dt-map-logs"
      role="button"
      tabIndex={-1}
      title="Info and debug records here; a click shows every record"
      onClick={(event) => {
        event.stopPropagation();
        onShow();
      }}
    >
      {plural(count, "log", "logs")}
    </span>
  );
}
