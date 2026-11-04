// The waterfall's one details pane (redesign A, a prototype): the selected row's name, where its time went (the
// caller's wait, the app's time, the network), the issues in it as cards, its queries, then the row's own details.
import type { ReactNode } from "react";
import { appName } from "./CallRows";
import type { Node } from "./callTree";
import { duration } from "./format";
import { IssueList } from "./IssueList";
import { CloseIcon } from "./icons";
import type { Windows } from "./lib/slice";
import { splitOf } from "./lib/split";
import { TraceBadge } from "./primitives";
import type { Issue, Span, Trace } from "./types";
import { crumbOf, type WaterfallFacts } from "./Waterfall";

/** Every span under a row, in its trace and in the traces served for its calls. */
function spansUnder(node: Node, trace: Trace): Span[] {
  if (node.type === "span") {
    const ids = new Set([node.span.id]);
    const out: Span[] = [node.span];
    for (const span of trace.spans) {
      if (span.parent_id && ids.has(span.parent_id)) {
        ids.add(span.id);
        out.push(span);
      }
    }
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

/** The row's queries, by statement: how many, how long all told. */
function queriesOf(spans: readonly Span[]): { name: string; count: number; us: number }[] {
  const by = new Map<string, { name: string; count: number; us: number }>();
  for (const span of spans) {
    if (span.kind !== "sql") continue;
    const entry = by.get(span.name) ?? { name: span.name, count: 0, us: 0 };
    entry.count += 1;
    entry.us += span.duration;
    by.set(span.name, entry);
  }
  return [...by.values()].sort((a, b) => b.us - a.us);
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
  return (
    <div className="dt-wf-split">
      <p>
        <b>{duration(waited)}</b> the caller waited · <b>{duration(server)}</b> in {app} · <b>{duration(network)}</b>{" "}
        network · queue
      </p>
      <span className="dt-wf-split-bar" aria-hidden="true">
        <span style={{ left: `${lead}%`, width: `${share * 100}%` }} />
      </span>
    </div>
  );
}

export function WaterfallDetails({
  node,
  trace,
  onClose,
  onShow,
  totals,
  children,
}: {
  node: Node;
  trace: Trace;
  onClose: () => void;
  onShow: (key: string) => void;
  /** A trace's root row: its totals, said here once (the toolbar has none). */
  totals?: WaterfallFacts | undefined;
  children: ReactNode;
}) {
  const crumb = crumbOf(node);
  const spans = spansUnder(node, trace);
  const found = issuesUnder(node, trace, spans);
  const queries = queriesOf(spans);
  const queryTime = queries.reduce((all, query) => all + query.us, 0);
  const longest = Math.max(...queries.map((query) => query.us), 1);
  return (
    <div className="dt-wf-details">
      <header className="dt-wf-details-head">
        <TraceBadge word={crumb.badge} />
        <h3 title={crumb.label}>{crumb.label}</h3>
        <button type="button" className="icon-button" aria-label="Close the details" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <HopSplit node={node} />
      {totals ? <Totals facts={totals} /> : null}
      {found.length > 0 ? (
        <section className="dt-wf-section">
          <h4>
            {found.length} {found.length === 1 ? "issue" : "issues"} under this span
          </h4>
          <IssueList issues={found} onShowSpans={(ids) => ids[0] && onShow(String(ids[0]))} />
        </section>
      ) : null}
      {queries.length > 0 ? (
        <section className="dt-wf-section">
          <h4>
            {queries.reduce((all, query) => all + query.count, 0)} queries · {duration(queryTime)}
          </h4>
          <ul className="dt-wf-queries">
            {queries.slice(0, 8).map((query) => (
              <li key={query.name}>
                <span className="dt-wf-query-name" title={query.name}>
                  {query.name}
                  {query.count > 1 ? <span className="text-muted-foreground"> ×{query.count}</span> : null}
                </span>
                <span className="dt-wf-query-bar" aria-hidden="true">
                  <span style={{ width: `${(query.us / longest) * 100}%` }} />
                </span>
                <span className="dt-wf-query-time">{duration(query.us)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="dt-wf-own">{children}</section>
    </div>
  );
}

/** A trace's totals, in its root row's details: its queries and HTTP calls with their time, its records, its issues. */
function Totals({ facts }: { facts: WaterfallFacts }) {
  const rows: [string, string][] = [
    ["Issues", String(facts.issues)],
    ["Queries", facts.db.count ? `${facts.db.count}${facts.db.time ? ` · ${facts.db.time}` : ""}` : "0"],
    ["HTTP calls", facts.http.count ? `${facts.http.count}${facts.http.time ? ` · ${facts.http.time}` : ""}` : "0"],
    ["Log records", String(facts.logs)],
  ];
  return (
    <section className="dt-wf-section">
      <h4>In this trace</h4>
      <dl className="dt-wf-totals">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
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
        <h4 className="normal-case tracking-normal">
          {split.of} · {split.time}
        </h4>
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
            {[...byKind].map(([kind, count]) => `${count} ${kind}`).join(" · ")}
          </p>
        </section>
      ) : null}
    </div>
  );
}
