import { type ReactNode, useContext } from "react";
import { AsReceived } from "./AsReceived";
import { hopTimes, Inside, RUN_WORDS, runRows, type TraceProfileOpener } from "./CallRowParts";
import { appName, type Linked, OpenRun } from "./CallRows";
import { type Explain, QueryPlan } from "./CallTable";
import type { Node, Remote, ServedRun } from "./callTree";
import { duration } from "./format";
import { GraphqlCode } from "./GraphqlCode";
import { LlmConversation, withoutMessages } from "./LlmConversation";
import { AllAttributes, LogRecordDetails } from "./LogRecordDetails";
import { callFields } from "./lib/callFields";
import { groupNoun } from "./lib/calls";
import { callDocument } from "./lib/graphql";
import { spanKindLabel } from "./lib/handler";
import { traceRuntime } from "./lib/runtime";
import { isReceiver, raised } from "./lib/signals";
import { attrsWhere } from "./lib/values";
import type { TraceLinks } from "./links";
import { type NameValue, NameValues, RowsLookContext } from "./NameValues";
import { PropTable } from "./PropTable";
import { AppChip, KindWords, SectionHeading } from "./primitives";
import { isRequestDetail, RequestParts, requestParts } from "./RequestParts";
import { RunChips } from "./RunChips";
import { SqlCode } from "./SqlCode";
import { TemplateContext, withoutContext } from "./TemplateContext";
import type { Attrs, Span, Trace, TraceSummary } from "./types";
import { NotTracedNote } from "./Untraced";

function RunDetails({
  run,
  kind,
  trace,
  links,
  remote,
  whole,
  profile,
}: {
  run: TraceSummary;
  kind: "task" | "call";
  trace: Trace;
  links?: TraceLinks | undefined;
  remote?: Remote | undefined;
  whole?: Trace | undefined;
  /** Opens its profile, when it has one. */
  profile?: (() => void) | undefined;
}) {
  const words = RUN_WORDS[kind];
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">
        {words.what} · started {duration(Math.max(run.start - trace.start, 0))} after this request · took{" "}
        {duration(run.duration)}
      </p>
      <Inside />
      <PropTable dense rows={runRows(run, words.label)} />
      <OpenRun run={run} words={words} links={links} remote={remote} whole={whole} />
      <ProfileLink open={profile} />
    </div>
  );
}

/** A task this trace enqueued that no worker has run yet. */
function WaitingDetails({ span }: { span: Span }) {
  const name = String(span.attrs["task.name"] ?? span.name);
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">task · enqueued, not run yet</p>
      <PropTable dense rows={[{ label: "Task", value: name, copy: name, mono: true }]} />
      <p className="text-sm text-muted-foreground">It shows up here once a worker has run it (is a worker running?).</p>
    </div>
  );
}

function LinkedDetails({
  node,
  trace,
  links,
  onTraceProfile,
}: {
  node: Linked;
  trace: Trace;
  links?: TraceLinks | undefined;
  onTraceProfile?: TraceProfileOpener | undefined;
}) {
  if (node.type === "waiting") return <WaitingDetails span={node.span} />;
  const profile = servedProfile(node, onTraceProfile);
  return (
    <RunDetails
      run={node.run}
      kind={node.kind}
      trace={trace}
      links={links}
      remote={node.remote}
      whole={node.whole}
      profile={profile}
    />
  );
}

type DetailsProps<T extends Node["type"]> = {
  node: Extract<Node, { type: T }>;
  trace: Trace;
  links?: TraceLinks | undefined;
  /** EXPLAIN for a query of the trace shown (this one or a linked one), as the DB tab runs it, where its app can. */
  onExplain?: Explain | undefined;
  /** Opens a call's trace's profile, from its details. */
  onTraceProfile?: TraceProfileOpener | undefined;
};

function LogDetails({ node }: DetailsProps<"log">) {
  return <LogRecordDetails log={node.log} titled={true} />;
}

function ErrorDetails({ node }: DetailsProps<"error">) {
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">Error</p>
      <p className="dt-error-message">
        <b>{node.error.type.replace(/^builtins\./, "")}</b>: {node.error.message}
      </p>
    </div>
  );
}

/** A SQL call's statement, formatted, with the values it ran with in place where they were recorded. */
function Statement({ span, attrs }: { span: Span; attrs: Attrs }) {
  if (span.kind !== "sql") return null;
  const values = attrs["db.params"];
  const names = attrs["db.param_names"];
  return (
    <SqlCode
      sql={String(attrs["db.statement"] ?? span.name)}
      vendor={String(attrs["db.vendor"] ?? "")}
      values={Array.isArray(values) ? values : undefined}
      names={Array.isArray(names) ? names : undefined}
    />
  );
}

function GroupDetails({ node, onExplain }: DetailsProps<"group">) {
  const [first] = node.spans;
  // Where they were called from, when they all were from one place; called from several, each call's row says its.
  const origins = new Set(node.spans.map((span) => String(span.attrs["code.origin"] ?? "")));
  const [origin] = origins;
  return (
    <div className="grid gap-3 p-4">
      <p className="dt-map-details-title">
        {node.spans.length} similar {groupNoun(first)} · took {duration(node.end - node.start)} ·{" "}
        {duration(node.spans.reduce((sum, span) => sum + span.duration, 0))} total
      </p>
      <Inside />
      {first ? (
        <>
          <Statement span={first} attrs={first.attrs} />
          <Fields rows={summaryRows(first, false)} />
          <QueryPlan span={first} onExplain={onExplain} />
        </>
      ) : null}
      {origins.size === 1 && origin ? (
        <p className="flex flex-wrap items-center gap-2 text-base text-muted-foreground" data-group-origin="">
          from <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">{origin}</code>
        </p>
      ) : null}
    </div>
  );
}

function SpanTitle({ span, trace, parent }: { span: Span; trace: Trace; parent: Span | undefined }) {
  const offset = duration(Math.max(span.start - trace.start, 0));
  // Beside the tree, the details' own head says what it is and how long it took.
  if (useContext(KindWords) !== null) return null;
  return (
    <p className="dt-map-details-title">
      {spanKindLabel(span.kind, trace.attrs, parent?.kind)} · started at +{offset} · took {duration(span.duration)}
    </p>
  );
}

/** What a span raised (a signal's receiver, under send_robust(): the trace has no error of it), as an error reads. */
function Raised({ attrs }: { attrs: Attrs }) {
  const found = raised(attrs);
  if (!found) return null;
  return (
    <p className="dt-error-message">
      <b className="text-error">{found.type}</b>
      {found.message ? `: ${found.message}` : null}
    </p>
  );
}

/** What every span's details open with: what it was, what it raised, its statement or its GraphQL document. */
function SpanHead({
  span,
  trace,
  parent,
  attrs,
}: {
  span: Span;
  trace: Trace;
  parent?: Span | undefined;
  attrs: Attrs;
}) {
  const document = attrs["graphql.document"];
  return (
    <>
      <SpanTitle span={span} trace={trace} parent={parent} />
      <Inside />
      <Raised attrs={span.attrs} />
      <Statement span={span} attrs={attrs} />
      {typeof document === "string" ? <GraphqlCode document={document} /> : null}
    </>
  );
}

function SpanDetails(props: DetailsProps<"span">) {
  if (props.node.served) return <HopDetails {...props} served={props.node.served} />;
  return props.node.span.parent_id === null ? <RootDetails {...props} /> : <CallDetails {...props} />;
}

/** The root span stands for the whole request: its details are the trace's own attributes, as its Request tab shows them. */
function RootDetails({ node: { span }, trace }: DetailsProps<"span">) {
  const attrs = { ...trace.attrs, ...span.attrs };
  return (
    <div className="grid gap-3 p-4">
      <SpanHead span={span} trace={trace} attrs={attrs} />
      <RootAttributes attrs={attrs} />
      <AsReceived span={span} />
    </div>
  );
}

/** Beside the tree, a span with no fields of its own says where it was: when, under what, how much of the record. */
function SpanPlace({
  span,
  trace,
  parent,
  bare,
}: {
  span: Span;
  trace: Trace;
  parent: Span | undefined;
  bare: boolean;
}) {
  const beside = useContext(KindWords) !== null;
  if (!(bare && beside)) return null;
  const share = (span.duration / Math.max(trace.duration, 1)) * 100;
  return (
    <Fields
      rows={[
        { name: "Started", value: `+${duration(Math.max(span.start - trace.start, 0))}` },
        { name: "Of the trace", value: `${share < 1 ? "<1" : Math.round(share)}% of ${duration(trace.duration)}` },
        ...(parent ? [{ name: "Under", value: parent.name }] : []),
      ]}
    />
  );
}

/** A call's own fields in words first (its topic, its URL, where in the code); every attribute after them. */
function CallDetails({ node: { span }, trace, onExplain }: DetailsProps<"span">) {
  const parent = trace.spans.find((each) => each.id === span.parent_id);
  const summary = summaryRows(span, true, parent);
  return (
    <div className="grid gap-3 p-4">
      <SpanHead span={span} trace={trace} parent={parent} attrs={withDocument(span.attrs)} />
      <NotTracedNote spanId={span.id} />
      {summary.length ? <Fields rows={summary} /> : null}
      <SpanPlace span={span} trace={trace} parent={parent} bare={summary.length === 0} />
      <QueryPlan span={span} onExplain={onExplain} />
      <SpanAttributes span={span} attrs={span.attrs} titled={summary.length > 0} />
      <AsReceived span={span} />
    </div>
  );
}

/**
 * A call merged with the trace served for it: the call (its URL, status, where it was called from, its attributes),
 * then what served it (that trace's name and findings, the ways to it and to its profile).
 */
function HopDetails({
  node: { span },
  served,
  trace,
  links,
  onTraceProfile,
}: DetailsProps<"span"> & { served: ServedRun }) {
  const parent = trace.spans.find((each) => each.id === span.parent_id);
  const summary = summaryRows(span, true, parent);
  return (
    <div className="grid gap-5 p-4">
      <section className="grid gap-3" aria-label="Call">
        <SectionHeading>Call</SectionHeading>
        <SpanHead span={span} trace={trace} parent={parent} attrs={withDocument(span.attrs, served.whole?.attrs)} />
        {summary.length ? <Fields rows={summary} /> : null}
        <SpanAttributes span={span} attrs={span.attrs} titled={summary.length > 0} />
        <AsReceived span={span} />
      </section>
      <ServedBy span={span} served={served} trace={trace} links={links} onTraceProfile={onTraceProfile} />
    </div>
  );
}

/**
 * A call's attributes with the GraphQL document it ran, wherever that was recorded (lib/graphql callDocument): its
 * details show it as the server's do.
 */
function withDocument(attrs: Attrs, served?: Attrs | undefined): Attrs {
  const document = callDocument(attrs, served);
  if (!document) return attrs;
  const shown: Attrs = { ...attrs };
  (shown as Record<string, unknown>)["graphql.document"] = document;
  return shown;
}

/** What served a merged call: its app, its trace's name and findings, the ways to it and to its profile. */
function ServedBy({
  span,
  served,
  trace,
  links,
  onTraceProfile,
}: {
  span: Span;
  served: ServedRun;
  trace: Trace;
  links: TraceLinks | undefined;
  onTraceProfile: TraceProfileOpener | undefined;
}) {
  const waterfall = useContext(KindWords) !== null;
  if (waterfall) {
    const [split, note] = hopTimes(span, served).split("\n");
    return (
      <section className="grid gap-3" aria-label={`Served by ${appName(served) ?? "another app"}`}>
        <ServedHeading served={served} />
        <p className="dt-map-details-title" title={note}>
          {split}
        </p>
        <ProfileLink open={servedProfile(served, onTraceProfile)} />
      </section>
    );
  }
  return (
    <section className="grid gap-3" aria-label={`Served by ${appName(served) ?? "another app"}`}>
      <ServedHeading served={served} />
      <p className="dt-map-details-title">
        started {duration(Math.max(served.run.start - trace.start, 0))} after this request · took{" "}
        {duration(served.run.duration)}
      </p>
      <PropTable dense rows={runRows(served.run, "Trace")} />
      <RunChips trace={served.run} />
      <OpenRun run={served.run} words={RUN_WORDS.call} links={links} remote={served.remote} whole={served.whole} />
      <ProfileLink open={servedProfile(served, onTraceProfile)} />
    </section>
  );
}

/** "Served by" and the app's chip, as the row has it. */
function ServedHeading({ served }: { served: ServedRun }) {
  const app = appName(served);
  return (
    <SectionHeading>
      Served by{app ? <AppChip name={app} runtime={traceRuntime(served.whole?.attrs ?? {})} compact /> : " another app"}
    </SectionHeading>
  );
}

/** Opens a call's trace's profile, when this agent has that trace whole with one. */
function servedProfile(served: ServedRun, open: TraceProfileOpener | undefined): (() => void) | undefined {
  const whole = served.remote ? undefined : served.whole;
  return whole?.profile && open ? () => open(whole.id) : undefined;
}

function ProfileLink({ open }: { open: (() => void) | undefined }) {
  return open ? (
    <button type="button" className="dt-map-open" onClick={open}>
      Open its profile →
    </button>
  ) : null;
}

/**
 * The trace's attributes on its request row, as its Request tab shows them: the same parts behind the same switch
 * (Headers, Query, Body, Cookies, Session, Response, Attributes), in the same rows, no box. The GraphQL document is
 * shown formatted above.
 */
function RootAttributes({ attrs }: { attrs: Attrs }) {
  const { "graphql.document": _, ...rest } = attrs;
  const others = attrsWhere(rest, (key) => !isRequestDetail(key));
  return <RequestParts parts={requestParts(rest, others)} look="plain" />;
}

/** A call's fields in words, in the rows of a trace's info tab: no box around them. */
function Fields({ rows }: { rows: readonly NameValue[] }) {
  return (
    <RowsLookContext value="plain">
      <NameValues rows={rows} />
    </RowsLookContext>
  );
}

/** Every attribute of a span; a template's context or an LLM call's conversation first, as rows of their own. */
function SpanAttributes({ span, attrs, titled }: { span: Span; attrs: Attrs; titled: boolean }) {
  const template = span.kind === "template";
  const llm = span.kind === "llm";
  const waterfall = useContext(KindWords) !== null;
  const rest = withoutMessages(withoutContext(attrs));
  // Beside the tree, as the record's own row has them: the same switch, the same groups.
  if (waterfall && !template && !llm) return <RootAttributes attrs={rest} />;
  return (
    <>
      {template ? <TemplateContext attrs={attrs} /> : null}
      {llm ? <LlmConversation attrs={attrs} /> : null}
      <AllAttributes attrs={withoutMessages(withoutContext(attrs))} titled={titled || template || llm} />
    </>
  );
}

const DETAILS: { [T in Node["type"]]: (props: DetailsProps<T>) => ReactNode } = {
  span: SpanDetails,
  group: GroupDetails,
  log: LogDetails,
  error: ErrorDetails,
  task: LinkedDetails,
  waiting: LinkedDetails,
};

export function Details(props: DetailsProps<Node["type"]>) {
  const Shown = DETAILS[props.node.type] as (props: DetailsProps<Node["type"]>) => ReactNode;
  return <Shown {...props} />;
}

/** A call's fields as rows; a list (a signal's receivers) one item a line. */
function summaryRows(span: Span, origin = true, parent?: Span | undefined): NameValue[] {
  const kind = isReceiver(span, parent) ? "receiver" : span.kind;
  return callFields({ kind, attrs: span.attrs }, origin).map(({ label, value }) => ({ name: label, value }));
}

/* ---------- side pane ---------- */
