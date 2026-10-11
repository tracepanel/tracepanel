import type { TraceLinks } from "@tracepanel/ui";
import { useEffect, useState } from "react";

/** Where work comes in: each has an overview of its groups and a list of its calls. */
export type EntrySection = "endpoints" | "graphql" | "tasks" | "websockets" | "jobs";
export const ENTRY_SECTIONS: EntrySection[] = ["endpoints", "graphql", "tasks", "websockets", "jobs"];

/** `traces` is search results (⌘K "search all"), not a menu item. */
export type Section = EntrySection | "services" | "queries" | "mails" | "logs" | "errors" | "issues" | "traces";
export const SECTIONS: Section[] = [
  ...ENTRY_SECTIONS,
  "services",
  "queries",
  "mails",
  "logs",
  "errors",
  "issues",
  "traces",
];

export type EntryView = "overview" | "calls";

/**
 * `#/<section>?q=…&view=calls` a section, `#/group/<section>/<key>` one group of an entry point (an endpoint, an
 * operation, a task, a consumer, a job), `#/t/<id>?from=…&tab=…` a trace: one page wherever it is opened from,
 * with `from` (the hash it was opened from) for the way back.
 */
export type Route =
  | { name: "home" }
  | { name: Section; q: string; view?: EntryView | undefined; open?: string | undefined }
  | { name: "group"; section: EntrySection; key: string; q?: string | undefined }
  | { name: "trace"; id: string; from?: string | undefined; tab?: string | undefined; span?: string | undefined }
  | { name: "issue"; fingerprint: string; error?: boolean | undefined };

/** A trace id: a ULID, in Crockford's alphabet (no I, L, O or U). */
export const TRACE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// A search's period: its since:/until: terms, which every list of the same traces can take.
const PERIOD_TERM = /^(?:since|until):\S+$/;

export function periodOf(q: string): string {
  return q
    .split(/\s+/)
    .filter((term) => PERIOD_TERM.test(term))
    .join(" ");
}

/** `q` looking at `period` instead of its own. */
export function withPeriod(q: string, period: string): string {
  const rest = q.split(/\s+/).filter((term) => term && !PERIOD_TERM.test(term));
  return [...rest, ...period.split(/\s+/).filter(Boolean)].join(" ");
}

/** The period of the page on screen: a link into a group or a list keeps looking at it. */
export function currentPeriod(): string {
  const route = parse(location.hash);
  return "q" in route && route.q ? periodOf(route.q) : "";
}

/** One group's page, over the period the page it is opened from looks at. */
export function groupRoute(section: EntrySection, key: string): Route {
  return { name: "group", section, key, q: currentPeriod() || undefined };
}

/** One endpoint's group: its key is "METHOD route", the way the agent's issue endpoints write it too. */
export function endpointGroup(method: string, route: string): Route {
  return groupRoute("endpoints", `${method} ${route}`);
}

/** An issue's page, remembering whether it is an error (listed under Errors) or another finding. */
export function issueRoute(fingerprint: string, kind: string): Route {
  return { name: "issue", fingerprint, error: kind === "error" };
}

export function isEntry(section: string): section is EntrySection {
  return (ENTRY_SECTIONS as string[]).includes(section);
}

export function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const q = params.get("q") ?? "";
  const issue = /^issue\/([0-9a-f]{16})$/.exec(path);
  if (issue?.[1]) return { name: "issue", fingerprint: issue[1], error: params.get("in") === "errors" };
  // `traces/` is how the widget wrote it before; old links still open.
  const trace = /^(?:t|traces)\/(.+)$/.exec(path);
  if (trace?.[1] && TRACE_ID.test(trace[1])) {
    return {
      name: "trace",
      id: trace[1],
      from: params.get("from") ?? undefined,
      tab: params.get("tab") ?? undefined,
      span: params.get("span") ?? undefined,
    };
  }
  const group = /^group\/([a-z]+)\/(.+)$/.exec(path);
  if (group?.[1] && group[2] && isEntry(group[1])) {
    return { name: "group", section: group[1], key: decodeURIComponent(group[2]), q: q || undefined };
  }
  if ((SECTIONS as string[]).includes(path)) {
    const view = params.get("view") === "calls" ? "calls" : undefined;
    return { name: path as Section, q, view, open: params.get("open") ?? undefined };
  }
  return { name: "home" };
}

export function href(route: Route): string {
  if (route.name === "home") return "#/";
  if (route.name === "trace") {
    const params = new URLSearchParams();
    if (route.from) params.set("from", route.from);
    if (route.tab) params.set("tab", route.tab);
    if (route.span) params.set("span", route.span);
    const query = params.size ? `?${params}` : "";
    return `#/t/${route.id}${query}`;
  }
  // Errors and other issues share a page; `in` says which list it belongs to, for the crumbs and the menu.
  if (route.name === "issue") return `#/issue/${route.fingerprint}${route.error ? "?in=errors" : ""}`;
  if (route.name === "group") {
    const query = route.q ? `?${new URLSearchParams({ q: route.q })}` : "";
    return `#/group/${route.section}/${encodeURIComponent(route.key)}${query}`;
  }
  const params = new URLSearchParams();
  if (route.q) params.set("q", route.q);
  if (route.view === "calls") params.set("view", "calls");
  // The row a list has open (a statement, a log record, an email): it is still open after Back.
  if (route.open) params.set("open", route.open);
  return `#/${route.name}${params.size ? `?${params}` : ""}`;
}

// In the widget's iframe a new entry would land in the page's own history: Back would step through the panel.
const EMBEDDED = window.parent !== window;

/** Go to a console address (`#/…`), as a link in the console would. */
export function follow(target: string, replace = false): void {
  if (replace || EMBEDDED) {
    // The entry's own state (its scroll, see scroll.ts) stays with it.
    history.replaceState(history.state, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = target;
  }
}

export function go(route: Route, replace = false): void {
  follow(href(route), replace);
}

/** Open a console address in a new tab, as Cmd-click or a middle click on a link would. */
export function openInNewTab(target: string): void {
  window.open(`${location.href.split("#")[0]}${target}`, "_blank", "noopener");
}

/** Where a trace opens from here: its page, remembering this one as the way back. */
export function traceHref(id: string, tab?: string, span?: string): string {
  const from = location.hash.startsWith("#/t/") ? parse(location.hash) : null;
  // From one trace to a linked one: keep the original way back.
  const back = from?.name === "trace" ? from.from : location.hash;
  return href({ name: "trace", id, from: back || undefined, tab, span });
}

/** Where a trace's parts lead in the console: linked traces, issues, every request with a statement, its logs. */
export function consoleLinks(prefix = "", newTab = false): TraceLinks {
  return {
    trace: (id) => `${prefix}${prefix ? href({ name: "trace", id }) : traceHref(id)}`,
    issue: (fingerprint, kind) => `${prefix}${href(issueRoute(fingerprint, kind))}`,
    query: (key) => `${prefix}${href({ name: "traces", q: `query:${key}` })}`,
    logs: (traceId) => `${prefix}${href({ name: "logs", q: `trace:${traceId}` })}`,
    newTab,
  };
}

/** Open a trace on its page, remembering where from: every list in the console opens traces this way. */
export function openTrace(id: string, tab?: string): void {
  follow(traceHref(id, tab));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", onChange);
    // Child effects run first: a redirect made before this listener existed (home → HTTP) must still count.
    onChange();
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
