import { ago } from "./format";
import { IssueIcon } from "./icons";
import { ISSUE_LABELS } from "./labels";
import type { IssueGroup } from "./types";

export interface IssueGroupListProps {
  issues: readonly IssueGroup[];
  /** Where an issue opens (its page, or its latest trace), as a link the host's router follows. */
  hrefFor: (issue: IssueGroup) => string;
}

export function IssueGroupList({ issues, hrefFor }: IssueGroupListProps) {
  return (
    <ul className="dt-requests">
      {issues.map((issue) => (
        <li key={issue.fingerprint}>
          <a
            href={hrefFor(issue)}
            className="dt-request-row dt-issue-row"
            data-tone={issue.kind === "error" ? "error" : "warn"}
          >
            <span className="dt-request-main">
              <span className="dt-issue-row-icon" data-kind={issue.kind}>
                <IssueIcon kind={issue.kind} />
              </span>
              <span className="dt-request-path dt-issue-row-title">
                {issue.title.replace(/^(N\+1|Duplicate queries|Slow query): /, "")}
              </span>
            </span>
            <span className="dt-request-meta">
              <span className="dt-chip" data-kind={issue.kind}>
                {ISSUE_LABELS[issue.kind]}
              </span>
              {issue.culprit ? <code className="dt-issue-row-where">{issue.culprit}</code> : null}
              <span>
                {issue.occurrences} {issue.occurrences === 1 ? "request" : "requests"}
              </span>
              <span className="dt-request-time">last {ago(issue.last_seen)}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
