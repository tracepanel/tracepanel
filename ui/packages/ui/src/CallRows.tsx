import { FlameIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { CodeRow, indentOf } from "./CallCode";
import {
  aliasBeside,
  aliasOf,
  Bar,
  barPlace,
  barTitle,
  CallStatus,
  Caret,
  CUT_NOTE,
  clipped,
  clockNote,
  foldOf,
  HiddenLogs,
  hopText,
  hopTimes,
  narrowed,
  OpText,
  OwnBar,
  OwnTime,
  ownerFor,
  type RowContext,
  RowTime,
  rowState,
  SHORT_KINDS,
  SpanFold,
  SpanName,
  sameRoute,
  slowness,
  spanButton,
  TaskState,
  type Within,
} from "./CallRowParts";
import {
  CHAIN_LEVELS,
  childrenOf,
  type Mark,
  type Node,
  ownChildren,
  type Remote,
  rootOf,
  type ServedRun,
  type SpanNode,
} from "./callTree";
import { DumpBadge, DumpLine } from "./Dump";
import { duration, since } from "./format";
import { withoutAnsi } from "./lib/ansi";
import { answers, type GroupAnswer, groupAnswer } from "./lib/callAnswer";
import { templatePlace } from "./lib/callFields";
import { callTemplate, groupNoun } from "./lib/calls";
import { isDump } from "./lib/dump";
import { spanKindLabel } from "./lib/handler";
import { foldKeys } from "./lib/keys";
import { traceRuntime } from "./lib/runtime";
import { type TraceLinks, traceLinkProps } from "./links";
import { MigrationNotes } from "./Migrations";
import { RowFlame } from "./ProfileHint";
import {
  AliasChip,
  AppChip,
  GroupStatus,
  ISSUE_CHIP_SHRINKS,
  IssueChip,
  KindBadge,
  StatusBadge,
  TaskName,
  TemplateChip,
  Times,
} from "./primitives";
import { RunChips } from "./RunChips";
import { SignalNotes } from "./SignalNotes";
import type { IssueKind, Span, Trace, TraceSummary } from "./types";
import { GroupNotTraced, NotTraced, useUntraced } from "./Untraced";
import { useAxis, useWaterfall } from "./Waterfall";

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
  return {
    kind: "log",
    level: node.log.level,
    time: node.log.time,
    text: withoutConsoleFormat(withoutAnsi(node.log.message)),
  };
}

/** A leaf's badge: its level, muted, or a dump's own. */
function LeafBadge({ kind, level }: { kind: string; level: string }) {
  if (kind === "dump") return <DumpBadge className="dt-map-kind" />;
  return <KindBadge kind={level} muted={true} className="dt-map-kind" />;
}

/** A leaf's text: a dump's call site and first value, coloured; any other's message or error. */
function LeafText({ node, text }: { node: Extract<Node, { type: "log" | "error" }>; text: string }) {
  if (node.type === "log" && isDump(node.log)) return <DumpLine log={node.log} className="dt-map-text" />;
  return (
    <span className="dt-map-text" title={text}>
      {text}
    </span>
  );
}

const LOG_PREFIX =
  /^\s*\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:?\d\d)?\s+(?:\[?(?:TRC|DBG|INF|WRN|ERR|FTL|TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]?\s+)?/;

/**
 * A browser console's format: `%c` and the CSS it takes as arguments ("font-weight: bold") are how it looked, not
 * what it said.
 */
function withoutConsoleFormat(given: string): string {
  // A logger's own prefix (its timestamp and level) is the record's details': its row says the level in its badge.
  const text = given.replace(LOG_PREFIX, "");
  if (!text.includes("%c")) return text;
  return text
    .replace(/%c/g, "")
    .replace(/(\s+[a-z-]+\s*:\s*[^;]+;?)+\s*$/i, "")
    .trim();
}

/** A record's time: when, since the request started; in the waterfall only on hover (its column says durations). */
function LeafTime({ time, trace }: { time: number; trace: Trace }) {
  const offset = `+${duration(Math.max(time - trace.start, 0))}`;
  const waterfall = useWaterfall() !== null;
  return (
    <span className="dt-map-time" title={`Logged ${since(time, trace.start)} (${offset})`}>
      {waterfall ? "" : offset}
    </span>
  );
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
        <LeafTime time={view.time} trace={ctx.trace} />
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
      <GroupKind kind={spanKindLabel(first?.kind, ctx.trace.attrs)} />
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
  const axis = useAxis(trace);
  // The repeats' whole stretch, faint, under their ticks: where they ran, from the first's start to the last's end.
  const first = Math.min(...spans.map((span) => span.start));
  const last = Math.max(...spans.map((span) => span.start + span.duration));
  const range = barPlace(axis, first, last - first);
  return (
    <span className="dt-map-track" aria-hidden="true">
      <span className="dt-map-bar" data-range="" style={range.style} />
      {spans.map((span) => {
        const [at] = clipped(span.start, 0, within);
        const left = Math.min(Math.max(((at - axis.start) / Math.max(axis.duration, 1)) * 100, 0), 100);
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

/** A span: its kind, its name and what goes with it, its bar and its time; its rows under it, open or folded. */
function SpanRow({ node, place }: RowProps<"span">) {
  return node.served ? <HopRow node={node} served={node.served} place={place} /> : <OwnRow node={node} place={place} />;
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
          {span.parent_id === null ? <RootStatus trace={ctx.trace} /> : null}
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

/** In the waterfall, a call whose callee has a profile says so on its row. */
function ServedProfile({ served }: { served: ServedRun }) {
  if (!(useWaterfall() && served.whole?.profile)) return null;
  return (
    <FlameIcon className="dt-wf-has-profile" aria-label="Has a profile" role="img">
      <title>Has a profile: select this row to see it</title>
    </FlameIcon>
  );
}

/** A group's kind badge: in short in the waterfall, as a span's is. */
function GroupKind({ kind }: { kind: string }) {
  const short = useWaterfall() ? (SHORT_KINDS[kind] ?? kind) : kind;
  return <KindBadge kind={short} muted={true} className="dt-map-kind" title={short === kind ? undefined : kind} />;
}

/** In the waterfall, a request's root row says how it was answered, as a call's row does. */
function RootStatus({ trace }: { trace: Trace }) {
  const host = useWaterfall();
  const status = trace.attrs["http.status_code"];
  if (!host) return null;
  return (
    <>
      {trace.profile ? (
        <FlameIcon className="dt-wf-has-profile" aria-label="Has a profile" role="img">
          <title>Has a profile: select this row to see it</title>
        </FlameIcon>
      ) : null}
      {typeof status === "number" ? <StatusBadge status={status} /> : null}
    </>
  );
}

/* ---------- a call and the trace served for it, one row ---------- */

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
  const axis = useAxis(trace);
  const call = barPlace(axis, from, long);
  const [at, length] = clipped(run.start, run.duration, narrowed(within, span));
  const server = barPlace(axis, at, length);
  return (
    <span
      className="dt-map-track"
      aria-hidden="true"
      title={`${barTitle(span.name, span.kind, span.duration, trace.duration)}\nserver ${duration(run.duration)} · ${run.name}`}
    >
      <span className="dt-map-bar" data-call="" data-past={call.past} data-before={call.before} style={call.style} />
      <span className="dt-map-bar" data-server="" style={server.style} />
    </span>
  );
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
          <ServedProfile served={served} />
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
