import type { ReactNode } from "react";
import { Button } from "./components/ui/button";
import { IssueIcon } from "./icons";
import { issueTitle } from "./labels";
import { linkProps, type TraceLinks } from "./links";
import { DetailsFooter, IssueChip, RichText } from "./primitives";
import type { Issue } from "./types";

export interface IssueListProps {
  issues: readonly Issue[];
  /** Show the spans an issue points at (e.g. switch to the SQL tab with them highlighted). */
  onShowSpans?: ((spanIds: readonly string[]) => void) | undefined;
  /** What an issue's spans are called ("queries", "HTTP calls"); queries when not given. */
  spansNoun?: ((issue: Issue) => string) | undefined;
  links?: TraceLinks | undefined;
  /** Where an issue is across a chain of calls: its apps, how many traces have it (a trace's scope). */
  reach?: ((issue: Issue) => ReactNode) | undefined;
  /** What its Show button says, when not "Show 3 queries". */
  showLabel?: ((issue: Issue) => string) | undefined;
}

/** The chain's own issue (an N+1 across apps) has no page of its own: the store keeps the traces' issues. */
function isChains(issue: Issue): boolean {
  return (issue as Issue & { chain?: boolean }).chain === true;
}

const queries = (issue: Issue) => (issue.count === 1 ? "query" : "queries");

/** Every occurrence of an issue, on its page: one the store keeps (not a chain's). */
function occurrences(issue: Issue, links: TraceLinks | undefined) {
  if (!links?.issue || isChains(issue)) return undefined;
  return { label: "All occurrences", link: linkProps(links, links.issue(issue.fingerprint, issue.kind)) };
}

/** "Show 3 queries": what the Show button says by default. */
function showCount(spansNoun: (issue: Issue) => string): (issue: Issue) => string {
  return (issue) => `Show ${issue.count} ${spansNoun(issue)}`;
}

/** The way to an issue's spans, where it has any and they are not an error's. */
function ShowSpans({
  issue,
  onShowSpans,
  label,
}: {
  issue: Issue;
  onShowSpans: ((spanIds: readonly string[]) => void) | undefined;
  label: (issue: Issue) => string;
}) {
  if (!onShowSpans || issue.kind === "error" || issue.span_ids.length === 0) return null;
  return (
    <Button variant="outline" size="sm" onClick={() => onShowSpans(issue.span_ids)}>
      {label(issue)}
    </Button>
  );
}

export function IssueList({ issues, onShowSpans, spansNoun = queries, links, reach, showLabel }: IssueListProps) {
  return (
    <div className="dt-issue-cards">
      {issues.map((issue) => (
        <article key={issue.fingerprint} className="dt-issue-card" data-kind={issue.kind}>
          <div className="dt-issue-icon">
            <IssueIcon kind={issue.kind} />
          </div>
          <div className="dt-issue-body">
            {/* The kind in its chip, then the title without it: as the Issues list and the issue's page say it. */}
            <h3 className="dt-issue-title">
              <IssueChip kind={issue.kind} />
              <span>{issueTitle(issue.title)}</span>
            </h3>
            {reach?.(issue)}
            {issue.culprit ? <code className="dt-issue-where">{issue.culprit}</code> : null}
            {issue.hint ? (
              <p className="dt-issue-hint">
                <RichText text={issue.hint} />
              </p>
            ) : null}
            {/* The one footer of actions every finding and open row has. */}
            <DetailsFooter rule={false} open={occurrences(issue, links)}>
              <ShowSpans issue={issue} onShowSpans={onShowSpans} label={showLabel ?? showCount(spansNoun)} />
            </DetailsFooter>
          </div>
        </article>
      ))}
    </div>
  );
}
