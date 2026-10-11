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
  | { name: Section; q: string; view?: EntryView | undefined }
  | { name: "group"; section: EntrySection; key: string }
  | { name: "trace"; id: string; from?: string | undefined; tab?: string | undefined }
  | { name: "issue"; fingerprint: string };

export function isEntry(section: string): section is EntrySection {
  return (ENTRY_SECTIONS as string[]).includes(section);
}

export function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const q = params.get("q") ?? "";
  const issue = /^issue\/([0-9a-f]{16})$/.exec(path);
  if (issue?.[1]) return { name: "issue", fingerprint: issue[1] };
  const trace = /^(?:t|traces)\/([0-9A-Z]{26})$/.exec(path);
  if (trace?.[1]) {
    return { name: "trace", id: trace[1], from: params.get("from") ?? undefined, tab: params.get("tab") ?? undefined };
  }
  const group = /^group\/([a-z]+)\/(.+)$/.exec(path);
  if (group?.[1] && group[2] && isEntry(group[1])) {
    return { name: "group", section: group[1], key: decodeURIComponent(group[2]) };
  }
  // Older links: one endpoint.
  if (path === "endpoint") {
    const key = `${params.get("method") ?? "GET"} ${params.get("route") ?? "/"}`;
    return { name: "group", section: "endpoints", key };
  }
  if ((SECTIONS as string[]).includes(path)) {
    const view = params.get("view") === "calls" ? "calls" : undefined;
    return { name: path as Section, q, view };
  }
  return { name: "home" };
}

export function href(route: Route): string {
  if (route.name === "home") return "#/";
  if (route.name === "trace") {
    const params = new URLSearchParams();
    if (route.from) params.set("from", route.from);
    if (route.tab) params.set("tab", route.tab);
    const query = params.size ? `?${params}` : "";
    return `#/t/${route.id}${query}`;
  }
  if (route.name === "issue") return `#/issue/${route.fingerprint}`;
  if (route.name === "group") return `#/group/${route.section}/${encodeURIComponent(route.key)}`;
  const params = new URLSearchParams();
  if (route.q) params.set("q", route.q);
  if (route.view === "calls") params.set("view", "calls");
  return `#/${route.name}${params.size ? `?${params}` : ""}`;
}

// In the widget's iframe a new entry would land in the page's own history: Back would step through the panel.
const EMBEDDED = window.parent !== window;

/** Go to a console address (`#/…`), as a link in the console would. */
export function follow(target: string, replace = false): void {
  if (replace || EMBEDDED) {
    history.replaceState(null, "", target);
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
export function traceHref(id: string, tab?: string): string {
  const from = location.hash.startsWith("#/t/") ? parse(location.hash) : null;
  // From one trace to a linked one: keep the original way back.
  const back = from?.name === "trace" ? from.from : location.hash;
  return href({ name: "trace", id, from: back || undefined, tab });
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
