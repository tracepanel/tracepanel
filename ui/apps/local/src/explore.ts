import type { ExploreItem, Trace } from "@tracepanel/ui";
import { issueRoute, type Route } from "./routes";
import { ENTRY, groupOf } from "./sections";
import { isoWithOffset } from "./time";

/** Logs from every process this long before and after a trace: what else was going on. */
const AROUND_US = 30_000_000;
const ISSUES_SHOWN = 3;

/**
 * What a trace page links to that it doesn't show itself: every call of its group (an endpoint, an operation,
 * a task…), its issues across all calls, and the logs of every process around it.
 */
export function exploreFor(trace: Trace, address: (route: Route) => string): ExploreItem[] {
  const items: ExploreItem[] = [];
  const group = groupOf(trace);
  if (group) {
    items.push({
      label: `${ENTRY[group.section].calls === "Requests" ? "All requests to" : "All calls of"} ${group.label}`,
      hint: "Latency, errors and issues across every call",
      icon: "group",
      href: address({ name: "group", section: group.section, key: group.key }),
    });
  }
  for (const issue of trace.issues.slice(0, ISSUES_SHOWN)) {
    items.push({
      label: issue.title,
      hint: "How often it happens, and where",
      icon: "issue",
      href: address(issueRoute(issue.fingerprint, issue.kind)),
    });
  }
  const since = isoWithOffset(trace.start - AROUND_US);
  const until = isoWithOffset(trace.start + trace.duration + AROUND_US);
  items.push({
    label: "Logs around this moment",
    hint: "Every request, task and job, 30 s before and after",
    icon: "logs",
    href: address({ name: "logs", q: `since:${since} until:${until}` }),
  });
  return items;
}
