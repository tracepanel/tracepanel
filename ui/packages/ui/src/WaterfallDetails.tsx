// The waterfall's one details pane (redesign A, a prototype): the selected row's name, where its time went (the
// caller's wait, the app's time, the network), the issues in it as cards, its queries, then the row's own details.
import { ScanSearchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { appName } from "./CallRows";
import type { Node } from "./callTree";
import { duration } from "./format";
import { IssueList } from "./IssueList";
import { CloseIcon } from "./icons";
import { TraceBadge } from "./primitives";
import type { Issue, Span, Trace } from "./types";
import { crumbOf } from "./Waterfall";

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
  onZoom,
  onClose,
  onShow,
  children,
}: {
  node: Node;
  trace: Trace;
  onZoom: () => void;
  onClose: () => void;
  onShow: (key: string) => void;
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
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom to this row"
          title="Zoom to this row (z)"
          onClick={onZoom}
        >
          <ScanSearchIcon />
        </button>
        <button type="button" className="icon-button" aria-label="Close the details" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <HopSplit node={node} />
      {found.length > 0 ? (
        <section className="dt-wf-section">
          <h4>
            {found.length} {found.length === 1 ? "issue" : "issues"} in this call
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
