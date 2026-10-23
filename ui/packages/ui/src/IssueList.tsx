import { Button } from "./components/ui/button";
import { IssueIcon } from "./icons";
import { issueTitle } from "./labels";
import { linkProps, type TraceLinks } from "./links";
import { DetailsFooter, IssueChip, RichText } from "./primitives";
import type { Issue } from "./types";

export { ISSUE_LABELS } from "./labels";

export interface IssueListProps {
  issues: readonly Issue[];
  /** Show the spans an issue points at (e.g. switch to the SQL tab with them highlighted). */
  onShowSpans?: ((spanIds: readonly string[]) => void) | undefined;
  /** What an issue's spans are called ("queries", "HTTP calls"); queries when not given. */
  spansNoun?: ((issue: Issue) => string) | undefined;
  links?: TraceLinks | undefined;
}

const queries = (issue: Issue) => (issue.count === 1 ? "query" : "queries");

export function IssueList({ issues, onShowSpans, spansNoun = queries, links }: IssueListProps) {
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
            {issue.culprit ? <code className="dt-issue-where">{issue.culprit}</code> : null}
            {issue.hint ? (
              <p className="dt-issue-hint">
                <RichText text={issue.hint} />
              </p>
            ) : null}
            {/* The one footer of actions every finding and open row has. */}
            <DetailsFooter
              rule={false}
              open={
                links?.issue
                  ? { label: "All occurrences", link: linkProps(links, links.issue(issue.fingerprint, issue.kind)) }
                  : undefined
              }
            >
              {onShowSpans && issue.kind !== "error" && issue.span_ids.length > 0 ? (
                <Button variant="outline" size="sm" onClick={() => onShowSpans(issue.span_ids)}>
                  Show {issue.count} {spansNoun(issue)}
                </Button>
              ) : null}
            </DetailsFooter>
          </div>
        </article>
      ))}
    </div>
  );
}
