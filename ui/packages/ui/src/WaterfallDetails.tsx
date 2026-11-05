// The waterfall's one details pane (redesign A, a prototype): what the selected span is, by its kind (see
// WaterfallDetails), and what a stretch of time dragged across the bars holds (RangeDetails).
import { type ReactNode, useState } from "react";
import { hopText, SHORT_KINDS } from "./CallRowParts";
import { appName } from "./CallRows";
import type { Node } from "./callTree";
import { ErrorView } from "./ErrorView";
import { duration } from "./format";
import { IssueList } from "./IssueList";
import { CloseIcon } from "./icons";
import { groupNoun } from "./lib/calls";
import { spanKindLabel } from "./lib/handler";
import { plural } from "./lib/plural";
import type { Windows } from "./lib/slice";
import { splitOf } from "./lib/split";
import { KindBadge, StatusBadge } from "./primitives";
import type { Issue, Span, Trace } from "./types";
import { crumbOf } from "./Waterfall";

/** Every span under a row, in its trace and in the traces served for its calls. */
function spansUnder(node: Node, trace: Trace): Span[] {
  if (node.type === "span") {
    // Walked from the span down by its children, whatever order the trace lists its spans in.
    const children = new Map<string, Span[]>();
    for (const span of trace.spans) {
      if (!span.parent_id) continue;
      const list = children.get(span.parent_id) ?? [];
      list.push(span);
      children.set(span.parent_id, list);
    }
    const out: Span[] = [node.span];
    for (let at = 0; at < out.length; at += 1) out.push(...(children.get(out[at]?.id ?? "") ?? []));
    if (node.served?.whole) out.push(...node.served.whole.spans);
    for (const child of node.children) if (child.type !== "span") out.push(...spansUnder(child, trace));
    return out;
  }
  if (node.type === "group") return node.members.flatMap((member) => spansUnder(member, trace));
  if (node.type === "task") return node.whole?.spans ?? [];
  return [];
}

/** The issues whose spans are under the row: this trace's and those of the traces served for its calls. */
function issuesUnder(node: Node, trace: Trace, spans: readonly Span[]): Issue[] {
  const ids = new Set(spans.map((span) => span.id));
  const pool = [...trace.issues, ...servedIssues(node)];
  const seen = new Set<string>();
  return pool.filter((issue) => {
    if (issue.kind === "error" || seen.has(issue.fingerprint)) return false;
    if (!issue.span_ids.some((id) => ids.has(String(id)))) return false;
    seen.add(issue.fingerprint);
    return true;
  });
}

function servedIssues(node: Node): Issue[] {
  if (node.type === "span") return [...(node.served?.whole?.issues ?? []), ...node.children.flatMap(servedIssues)];
  if (node.type === "group") return node.members.flatMap(servedIssues);
  if (node.type === "task") return node.whole?.issues ?? [];
  return [];
}

/** A call another app served: the caller's wait, the app's own time, the rest the network and queues. */
function HopSplit({ node }: { node: Node }) {
  if (node.type !== "span" || !node.served) return null;
  const waited = node.span.duration;
  const server = node.served.run.duration;
  const network = Math.max(waited - server, 0);
  const app = appName(node.served) ?? "the app";
  const share = waited > 0 ? Math.min(server / waited, 1) : 0;
  const lead = waited > 0 ? (network / 2 / waited) * 100 : 0;
  // The caller's span only mirrors the served trace (it has no time of its own): there is no wait to say.
  const mirrored = Math.abs(waited - server) < 1000;
  return (
    <div className="dt-wf-split">
      <p>
        {mirrored ? null : (
          <>
            <b>{duration(waited)}</b> the caller waited ·{" "}
          </>
        )}
        <b>{duration(server)}</b> in {app}
        {/* No network time to say (the clocks disagree, or it was nothing): not "0 µs". */}
        {network >= 1000 ? (
          <>
            {" "}
            · <b>{duration(network)}</b> network · queue
          </>
        ) : null}
      </p>
      <span className="dt-wf-split-bar" aria-hidden="true">
        <span style={{ left: `${lead}%`, width: `${share * 100}%` }} />
      </span>
    </div>
  );
}

/** The row's headline: its kind, its name, how it was answered, how long it took. */
/** The row's name, as its row says it; a call's without the method its badge says. */
function headName(node: Node, fallback: string): string {
  if (node.type === "error") {
    // A bare "Error" says nothing the badge doesn't: its message then.
    const type = node.error.type.replace(/^builtins\./, "");
    return type === "Error" ? `Error: ${node.error.message}` : type;
  }
  if (node.type === "log") return node.log.logger || node.log.level;
  if (node.type !== "span") return fallback;
  if (node.served || node.span.kind === "http.client") return hopText(node.span).replace(/^[A-Z]+ /, "");
  if (node.span.parent_id === null && /^[A-Z]+ \//.test(node.span.name)) return node.span.name;
  return fallback;
}

/** The row's badge word, as its row says it: a call's method, a span's kind in short, a record's level. */
function badgeWord(node: Node, trace: Trace): string {
  if (node.type === "log") return node.log.level;
  if (node.type === "error") return "error";
  if (node.type === "task") return "task";
  if (node.type === "waiting") return "task";
  const span = node.type === "group" ? node.spans[0] : node.span;
  if (!span) return "";
  if (span.kind === "http.client" || (node.type === "span" && node.served)) {
    const method = span.attrs["http.request.method"] ?? span.attrs["http.method"];
    return typeof method === "string" ? method : (span.name.split(" ")[0] ?? "");
  }
  if (span.kind === "page") return crumbOf(node).badge;
  const kind = spanKindLabel(span.kind, trace.attrs);
  return SHORT_KINDS[kind] ?? kind;
}

function Headline({ node, trace, onClose }: { node: Node; trace: Trace; onClose: () => void }) {
  const crumb = crumbOf(node);
  const status = statusOf(node, trace);
  const time =
    node.type === "span"
      ? node.span.duration
      : node.type === "task"
        ? node.run.duration
        : node.type === "group"
          ? node.end - node.start
          : null;
  return (
    <header className="dt-wf-details-head">
      <KindBadge kind={badgeWord(node, trace)} muted={true} className="dt-map-kind" />
      <h3 title={headName(node, crumb.label)}>
        {headName(node, crumb.label)}
        {node.type === "group" ? <span className="dt-wf-head-count"> ×{node.spans.length}</span> : null}
      </h3>
      <StatusBadge status={status} />
      {time !== null ? <span className="dt-wf-head-time">{duration(time)}</span> : null}
      <button type="button" className="icon-button" aria-label="Close the details" onClick={onClose}>
        <CloseIcon />
      </button>
    </header>
  );
}

function statusOf(node: Node, trace: Trace): number | null {
  if (node.type === "task") return node.run.http_status;
  if (node.type !== "span") return null;
  if (node.served) return node.served.run.http_status;
  const own = node.span.parent_id === null ? trace.attrs["http.status_code"] : node.span.attrs["http.status_code"];
  return typeof own === "number" ? own : null;
}

/** Where a request's time went, from split.ts: one bar of its shares, their times and percents under it. */
function SplitBar({ trace }: { trace: Trace }) {
  const split = splitOf(trace);
  if (split.shares.length === 0) return null;
  return (
    <section className="dt-wf-section">
      <span className="dt-wf-split-stack" aria-hidden="true">
        {split.shares.map((share) => (
          <span
            key={share.share}
            style={{
              width: share.percent.startsWith("<") ? "0.5%" : share.percent,
              background: shareColor(share.share),
            }}
          />
        ))}
      </span>
      <ul className="dt-wf-split-legend">
        {split.shares.map((share) => (
          <li key={share.share}>
            <i style={{ background: shareColor(share.share) }} />
            {share.label} <b>{share.time}</b> <span>{share.percent}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function shareColor(share: string): string {
  return `var(--dt-k-${share}, var(--dt-k-request))`;
}

/**
 * The selected row's details, by what it is: its headline; a request's split (one bar) or a call's wait, network and
 * app time; its issues as cards with their fix; a request's non-zero totals; a call's way into its callee's spans; the
 * profile where there is one; then what only this row has (a statement and its plan, a template's context, a record,
 * a request's headers and body), as the old call tree's details said it. Never a zero, never the row's facts twice.
 */
export function WaterfallDetails({
  node,
  trace,
  onClose,
  onShow,
  profile,
  profileScope,
  explainable,
  isRoot,
  children,
}: {
  node: Node;
  trace: Trace;
  onClose: () => void;
  onShow: (key: string) => void;
  /** The row's trace's profile, where it has one: its bar and flame. */
  profile?: ReactNode;
  /** What the profile is of: "the whole trace", "this call (library-api)". */
  profileScope?: string | undefined;
  /** Whether the row's app runs EXPLAIN (its query's details then have it). */
  explainable?: boolean | undefined;
  /** The row is its trace's root (its parent, if any, in another app). */
  isRoot?: boolean | undefined;
  children: ReactNode;
}) {
  const spans = spansUnder(node, trace);
  const found = issuesUnder(node, trace, spans);
  // The trace's own root (a remote parent or not): its request's issues, queries and split.
  const root = isRoot ?? (node.type === "span" && node.span.parent_id === null);
  const queries = requestish(node) || root ? queriesOf(spans) : [];
  const errors = errorsOf(node, trace);
  const main = mainLabel(node);
  // The row's categories, the non-empty ones: tabs where there are several, the one shown as is.
  const categories: { id: string; label: string; count?: number; body: ReactNode }[] = [
    ...(errors.length ? [{ id: "error", label: "Error", body: <ErrorView errors={errors} /> }] : []),
    ...(found.length
      ? [
          {
            id: "issues",
            label: "Issues",
            count: found.length,
            body: (
              <div className="dt-wf-issues">
                <IssueList
                  issues={found}
                  // "Show 4 HTTP calls", "Show 1 query": by the kind of the spans an issue points at.
                  spansNoun={(issue) => groupNoun(spanById(trace, node, String(issue.span_ids[0])), issue.count)}
                  // The spans an issue points at are this row or right under it: no link to what is on screen.
                  onShowSpans={pointsHere(node) ? undefined : (ids) => ids[0] && onShow(String(ids[0]))}
                />
              </div>
            ),
          },
        ]
      : []),
    ...(queries.length
      ? [
          {
            id: "queries",
            label: "Queries",
            count: queries.reduce((all, query) => all + query.count, 0),
            body: <QueryList queries={queries} onShow={onShow} />,
          },
        ]
      : []),
    ...(profile
      ? [
          {
            id: "profile",
            label: "Profile",
            body: <ProfileSection profile={profile} scope={profileScope} />,
          },
        ]
      : []),
    // An error record's own details are its Error tab; a group's are its issues and its rows.
    ...(node.type === "error" || node.type === "group"
      ? []
      : [
          {
            id: "main",
            label: main,
            body: (
              <>
                <section className="dt-wf-own">{children}</section>
                {isQuery(node) && !explainable ? (
                  <p className="dt-wf-note">
                    Explain: not available here. The app that ran this query runs EXPLAIN on its database when it is
                    connected to this agent.
                  </p>
                ) : null}
              </>
            ),
          },
        ]),
  ];
  const kind = badgeWord(node, trace);
  const [tab, setTab] = useCategory(kind, categories);
  const shown = categories.find((each) => each.id === tab) ?? categories[0];
  return (
    <div className="dt-wf-details">
      <Headline node={node} trace={trace} onClose={onClose} />
      {/* The profile tab says the split itself: the head's then gives way. */}
      {root ? profile ? null : <SplitBar trace={trace} /> : <HopSplit node={node} />}
      {categories.length > 1 ? (
        <div className="dt-wf-tabs" role="tablist" aria-label="Details">
          {categories.map((each) => (
            <button
              key={each.id}
              type="button"
              role="tab"
              aria-selected={each.id === shown?.id}
              tabIndex={each.id === shown?.id ? 0 : -1}
              onClick={() => setTab(each.id)}
              onKeyDown={(event) => {
                const ids = categories.map((one) => one.id);
                const at = ids.indexOf(shown?.id ?? "");
                const by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!by) return;
                event.preventDefault();
                const next = ids[(at + by + ids.length) % ids.length];
                if (next) setTab(next);
                const list = event.currentTarget.parentElement;
                requestAnimationFrame(() => list?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
              }}
            >
              {each.label}
              {each.count ? <span className="dt-wf-tab-count">{each.count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div role={categories.length > 1 ? "tabpanel" : undefined}>{shown?.body}</div>
    </div>
  );
}

/** The tab each kind of span was last looked at on: kept while moving between spans of that kind. */
const CATEGORY_OF = new Map<string, string>();

/** Opens the next details of a span of this kind on this tab: a code row opens its span's Profile. */
export function preferCategory(_kind: string, id: string): void {
  NEXT_TAB.id = id;
}

/** The tab the next details open on, once (a code row's click: its span's Profile). */
const NEXT_TAB: { id: string | null } = { id: null };

/** A span's badge word, as its row says it (a span's kind in short). */
export function spanWord(span: Span, trace: Trace): string {
  const kind = spanKindLabel(span.kind, trace.attrs);
  return SHORT_KINDS[kind] ?? kind;
}

function useCategory(kind: string, categories: readonly { id: string }[]): [string, (id: string) => void] {
  const [, redraw] = useState(0);
  const ids = categories.map((each) => each.id);
  // Asked for once (a code row opened its span on Profile): kept for that kind from then on.
  const asked = NEXT_TAB.id;
  if (asked && ids.includes(asked)) {
    NEXT_TAB.id = null;
    CATEGORY_OF.set(kind, asked);
  }
  const kept = CATEGORY_OF.get(kind);
  // The most useful by default: what broke, then its issues, then what the span is.
  const best = ["error", "issues", "main"].find((id) => ids.includes(id)) ?? ids[0] ?? "main";
  const tab = kept && ids.includes(kept) ? kept : best;
  return [
    tab,
    (id) => {
      CATEGORY_OF.set(kind, id);
      redraw((count) => count + 1);
    },
  ];
}

/** What a row's main tab is called, by its kind: what the span is. */
function mainLabel(node: Node): string {
  if (node.type === "log") return "Record";
  if (node.type === "task") return "Task";
  if (node.type === "waiting") return "Task";
  const span = node.type === "group" ? node.spans[0] : node.type === "span" ? node.span : undefined;
  if (!span) return "Details";
  if (span.kind === "sql") return "Query";
  if (node.type === "span" && node.served) return "Call";
  if (span.kind === "http.client") return "Call";
  if (span.kind === "template") return "Context";
  if (span.parent_id === null) return String(span.kind).startsWith("task") ? "Task" : "Request";
  return "Span";
}

function errorsOf(node: Node, trace: Trace) {
  if (node.type === "error") return [node.error];
  if (node.type === "span" && node.served?.whole) return node.served.whole.errors;
  if (node.type === "span" && node.span.parent_id === null) return trace.errors;
  return [];
}

/** A span by its id, in the row's trace or the trace served for its call. */
function spanById(trace: Trace, node: Node, id: string): Span | undefined {
  const served = node.type === "span" ? node.served?.whole : undefined;
  return trace.spans.find((span) => span.id === id) ?? served?.spans.find((span) => span.id === id);
}

/** A request: a call another app served, or a trace's own root. */
function requestish(node: Node): boolean {
  return node.type === "span" && (node.served !== undefined || node.span.parent_id === null);
}

/** The row's queries, by statement: how many, how long all told. */
function queriesOf(spans: readonly Span[]): { name: string; count: number; us: number; first: string }[] {
  const by = new Map<string, { name: string; count: number; us: number; first: string }>();
  for (const span of spans) {
    if (span.kind !== "sql") continue;
    const entry = by.get(span.name) ?? { name: span.name, count: 0, us: 0, first: span.id };
    entry.count += 1;
    entry.us += span.duration;
    by.set(span.name, entry);
  }
  return [...by.values()].sort((a, b) => b.us - a.us);
}

function QueryList({
  queries,
  onShow,
}: {
  queries: readonly { name: string; count: number; us: number; first: string }[];
  onShow: (key: string) => void;
}) {
  const longest = Math.max(...queries.map((query) => query.us), 1);
  return (
    <ul className="dt-wf-queries dt-wf-section">
      {queries.map((query) => (
        <li key={query.name}>
          <button type="button" className="dt-wf-query-name" title={query.name} onClick={() => onShow(query.first)}>
            {query.name}
            {query.count > 1 ? <span className="text-muted-foreground"> ×{query.count}</span> : null}
          </button>
          <span className="dt-wf-query-bar" aria-hidden="true">
            <span style={{ width: `${(query.us / longest) * 100}%` }} />
          </span>
          <span className="dt-wf-query-time">{duration(query.us)}</span>
        </li>
      ))}
    </ul>
  );
}

function ProfileSection({ profile, scope }: { profile: ReactNode; scope: string | undefined }) {
  return (
    <section className="dt-wf-section dt-wf-profile">
      <header className="flex items-center justify-between">
        <h4>Profile of {scope ?? "the whole trace"}</h4>
        <button
          type="button"
          className="dt-wf-link"
          aria-pressed={false}
          onClick={(event) => {
            const wide = event.currentTarget.closest(".wf-main")?.toggleAttribute("data-wide") ?? false;
            event.currentTarget.setAttribute("aria-pressed", String(wide));
            event.currentTarget.textContent = wide ? "Back to the spans" : "Full width";
          }}
        >
          Full width
        </button>
      </header>
      {profile}
    </section>
  );
}

function isQuery(node: Node): boolean {
  if (node.type === "group") return node.spans[0]?.kind === "sql";
  return node.type === "span" && node.span.kind === "sql";
}

/** What a stretch dragged across the bars holds, of one trace: where its time went (split.ts), and its calls. */
export function RangeDetails({ trace, windows }: { trace: Trace; windows: Windows }) {
  const split = splitOf(trace, windows);
  const [[from, to] = [0, 0]] = windows;
  const calls = trace.spans.filter(
    (span) =>
      span.parent_id !== null && span.start - trace.start <= to && span.start + span.duration - trace.start >= from,
  );
  const byKind = new Map<string, number>();
  for (const span of calls) byKind.set(span.kind, (byKind.get(span.kind) ?? 0) + 1);
  return (
    <div className="dt-wf-details">
      <header className="dt-wf-details-head">
        <h3 title={trace.name}>{trace.name}</h3>
      </header>
      <section className="dt-wf-section">
        <h4>Where its {split.time} went</h4>
        <ul className="dt-wf-queries">
          {split.shares.map((share) => (
            <li key={share.share}>
              <span className="dt-wf-query-name">{share.label}</span>
              <span className="dt-wf-query-bar" aria-hidden="true">
                <span style={{ width: share.percent.startsWith("<") ? "1%" : share.percent }} />
              </span>
              <span className="dt-wf-query-time">{share.time}</span>
            </li>
          ))}
        </ul>
      </section>
      {byKind.size ? (
        <section className="dt-wf-section">
          <h4>
            {calls.length} {calls.length === 1 ? "span" : "spans"} in this stretch
          </h4>
          <p className="text-sm text-muted-foreground">
            {[...byKind].map(([kind, count]) => kindCount(kind, count)).join(" · ")}
          </p>
        </section>
      ) : null}
    </div>
  );
}

/** A query or a group of them: its issue's spans are the row itself and its repeats. */
function pointsHere(node: Node): boolean {
  return node.type === "group" || (node.type === "span" && node.span.kind === "sql");
}

const KIND_NOUNS: Record<string, [string, string]> = {
  sql: ["query", "queries"],
  "http.client": ["HTTP call", "HTTP calls"],
  function: ["function", "functions"],
  graphql: ["GraphQL step", "GraphQL steps"],
  view: ["handler", "handlers"],
  template: ["template", "templates"],
  redis: ["Redis command", "Redis commands"],
  cache: ["cache call", "cache calls"],
  "task.enqueue": ["task enqueued", "tasks enqueued"],
};

/** "33 HTTP calls", "1 query": a kind of spans counted in words. */
function kindCount(kind: string, count: number): string {
  const [one, many] = KIND_NOUNS[kind] ?? [kind, kind];
  return plural(count, one, many);
}
