import { ago } from "./format";
import { IssueIcon } from "./icons";
import { ISSUE_LABELS } from "./labels";
import type { IssueGroup } from "./types";

export interface IssueGroupListProps {
  issues: readonly IssueGroup[];
  /** Called with the issue: hosts open its page, or its latest trace. */
  onSelect: (issue: IssueGroup) => void;
}

export function IssueGroupList({ issues, onSelect }: IssueGroupListProps) {
  return (
    <ul className="dt-requests">
      {issues.map((issue) => (
        <li key={issue.fingerprint}>
          <button
            type="button"
            className="dt-request-row dt-issue-row"
            data-tone={issue.kind === "error" ? "error" : "warn"}
            onClick={() => onSelect(issue)}
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
          </button>
        </li>
      ))}
    </ul>
  );
}
