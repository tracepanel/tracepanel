import { ago } from "./format";
import { IssueIcon } from "./icons";
import { issueTitle } from "./labels";
import { IssueChip } from "./primitives";
import type { IssueGroup } from "./types";

export interface IssueGroupListProps {
  issues: readonly IssueGroup[];
  /** Where an issue opens (its page, or its latest trace), as a link the host's router follows. */
  hrefFor: (issue: IssueGroup) => string;
}

export function IssueGroupList({ issues, hrefFor }: IssueGroupListProps) {
  return (
    <ul className="tp-requests">
      {issues.map((issue) => (
        <li key={issue.fingerprint}>
          <a
            href={hrefFor(issue)}
            className="tp-request-row tp-issue-row"
            data-tone={issue.kind === "error" ? "error" : "warn"}
          >
            <span className="tp-request-main">
              <span className="tp-issue-row-icon" data-kind={issue.kind}>
                <IssueIcon kind={issue.kind} />
              </span>
              <span className="tp-request-path tp-issue-row-title">{issueTitle(issue.title)}</span>
            </span>
            <span className="tp-request-meta">
              <IssueChip kind={issue.kind} />
              {issue.culprit ? <code className="tp-issue-row-where">{issue.culprit}</code> : null}
              <span>
                {issue.occurrences} {issue.occurrences === 1 ? "request" : "requests"}
              </span>
              <span className="tp-request-time">last {ago(issue.last_seen)}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
