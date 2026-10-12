import { IssueIcon } from "./icons";
import { ISSUE_LABELS, issueTitle } from "./labels";
import { linkProps, type TraceLinks } from "./links";
import { RichText } from "./primitives";
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
            <p className="dt-issue-kind">{ISSUE_LABELS[issue.kind]}</p>
            <h3 className="dt-issue-title">{issueTitle(issue.title)}</h3>
            {issue.culprit ? <code className="dt-issue-where">{issue.culprit}</code> : null}
            {issue.hint ? (
              <p className="dt-issue-hint">
                <RichText text={issue.hint} />
              </p>
            ) : null}
            <p className="dt-issue-actions">
              {onShowSpans && issue.kind !== "error" && issue.span_ids.length > 0 ? (
                <button type="button" className="dt-button dt-button-small" onClick={() => onShowSpans(issue.span_ids)}>
                  Show {issue.count} {spansNoun(issue)}
                </button>
              ) : null}
              {links?.issue ? (
                <a className="dt-issue-link" {...linkProps(links, links.issue(issue.fingerprint, issue.kind))}>
                  All occurrences →
                </a>
              ) : null}
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}
