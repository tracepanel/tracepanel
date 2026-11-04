// The waterfall's one details pane (redesign A, a prototype): what the selected span is, by its kind (see
// WaterfallDetails), and what a stretch of time dragged across the bars holds (RangeDetails).
import type { ReactNode } from "react";
import { appName } from "./CallRows";
import type { Node } from "./callTree";
import { duration } from "./format";
import { IssueList } from "./IssueList";
import { CloseIcon } from "./icons";
import { plural } from "./lib/plural";
import type { Windows } from "./lib/slice";
import { splitOf } from "./lib/split";
import { StatusBadge, TraceBadge } from "./primitives";
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

/** The row's headline: its kind, its name, how it was answered, how long it took. */
function Headline({ node, trace, onClose }: { node: Node; trace: Trace; onClose: () => void }) {
  const crumb = crumbOf(node);
  const status = statusOf(node, trace);
  const time =
    node.type === "span"
      ? node.span.duration
      : node.type === "task"
        ? node.run.duration
        : node.type === "group"
          ? node.spans.reduce((all, span) => all + span.duration, 0)
          : null;
  return (
    <header className="dt-wf-details-head">
      <TraceBadge word={crumb.badge} />
      <h3 title={crumb.label}>
        {crumb.label}
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

/** A request's totals in one line, the non-zero ones only: "74 queries · 54 ms · 2 HTTP calls · 1 log record". */
function TotalsLine({ facts }: { facts: WaterfallFacts }) {
  const parts = [
    facts.db.count ? `${plural(facts.db.count, "query", "queries")}${facts.db.time ? ` · ${facts.db.time}` : ""}` : "",
    facts.http.count
      ? `${plural(facts.http.count, "HTTP call", "HTTP calls")}${facts.http.time ? ` · ${facts.http.time}` : ""}`
      : "",
    facts.logs ? plural(facts.logs, "log record", "log records") : "",
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <p className="dt-wf-totals-line">{parts.join(" · ")}</p>;
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
  totals,
  profile,
  profileScope,
  onOpen,
  children,
}: {
  node: Node;
  trace: Trace;
  onClose: () => void;
  onShow: (key: string) => void;
  /** A trace's root row: its totals. */
  totals?: WaterfallFacts | undefined;
  /** The row's trace's profile, where it has one: its bar and flame. */
  profile?: ReactNode;
  /** What the profile is of: "the whole trace", "this call (library-api)". */
  profileScope?: string | undefined;
  /** A call whose callee's spans are folded: opens them under its row. */
  onOpen?: (() => void) | undefined;
  children: ReactNode;
}) {
  const spans = spansUnder(node, trace);
  const found = issuesUnder(node, trace, spans);
  const root = node.type === "span" && node.span.parent_id === null;
  return (
    <div className="dt-wf-details">
      <Headline node={node} trace={trace} onClose={onClose} />
      {/* The profile says the split itself (its bar and legend): not twice. */}
      {root ? profile ? null : <SplitBar trace={trace} /> : <HopSplit node={node} />}
      {found.length > 0 ? (
        <section className="dt-wf-section">
          <IssueList issues={found} onShowSpans={(ids) => ids[0] && onShow(String(ids[0]))} />
        </section>
      ) : null}
      {totals ? <TotalsLine facts={totals} /> : null}
      {onOpen ? (
        <p className="dt-wf-totals-line">
          <button type="button" className="dt-wf-link" onClick={onOpen}>
            Show its spans
          </button>
        </p>
      ) : null}
      {profile ? (
        <section className="dt-wf-section dt-wf-profile">
          <header className="flex items-center justify-between">
            <h4>Profile · {profileScope ?? "the whole trace"}</h4>
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
      ) : null}
      <section className="dt-wf-own">{children}</section>
    </div>
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
