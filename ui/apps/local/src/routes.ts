import type { TraceLinks } from "@tracepanel/ui";
import { useEffect, useState } from "react";

/** Where work comes in: each has an overview of its groups and a list of its calls. */
export type EntrySection = "endpoints" | "graphql" | "tasks" | "websockets" | "jobs" | "rpc" | "pages";
export const ENTRY_SECTIONS: EntrySection[] = ["endpoints", "graphql", "tasks", "websockets", "jobs", "rpc", "pages"];

/** A system's page of operations: `calls/sql`, `calls/redis`, `calls/mongodb`, `calls/neo4j`… one per system in the data. */
export type CallsSection = `calls/${string}`;

/** `traces` is search results (⌘K "search all"), not a menu item. */
export type Section =
  | EntrySection
  | "services"
  | CallsSection
  | "aws"
  | "mails"
  | "logs"
  | "errors"
  | "issues"
  | "traces";
const SECTIONS: Section[] = [...ENTRY_SECTIONS, "services", "aws", "mails", "logs", "errors", "issues", "traces"];

/** An entry point's list: every call (what a page opens on), or its groups. */
export type EntryView = "calls" | "overview";

// What `view=` says: every call, the groups, or Live on (an old link to Tasks' Live).
const VIEWS: Record<string, { view?: EntryView; live?: boolean }> = {
  calls: { view: "calls" },
  overview: { view: "overview" },
  live: { live: true },
};

/**
 * `#/<section>?q=…` a section, every call (`&view=overview` its groups), `#/group/<section>/<key>` one group of
 * an entry point (an endpoint, an operation, a task, a consumer, a job), `#/t/<id>?from=…&tab=…` a trace: one page wherever it is opened from,
 * with `from` (the hash it was opened from) for the way back and `part`/`range` the part of its time picked, `#/app/<service>` an app's settings and versions. `view=live` (Tasks' Live was a list of its own once)
 * opens the section with Live on (`live`): it is read, never written.
 */
export type Route =
  | { name: "home" }
  | { name: Section; q: string; view?: EntryView | undefined; open?: string | undefined; live?: boolean | undefined }
  | { name: "group"; section: EntrySection; key: string; q?: string | undefined }
  | {
      name: "trace";
      id: string;
      from?: string | undefined;
      tab?: string | undefined;
      span?: string | undefined;
      /** The part of the time picked in the call tree: kinds of calls (`sql view`), a stretch in ms (`12.4-18.9`). */
      part?: string | undefined;
      range?: string | undefined;
      /** `all`: every log record in the call tree, its info and debug ones too. */
      logs?: string | undefined;
    }
  | { name: "issue"; fingerprint: string; error?: boolean | undefined; q?: string | undefined }
  | { name: "app"; service: string };

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
  return { name: "issue", fingerprint, error: kind === "error", q: currentPeriod() || undefined };
}

const CALLS_SECTION = /^calls\/[\w.:-]+$/;

/** A system's page. */
export function callsSection(system: string): CallsSection {
  return `calls/${system}`;
}

/** The system a page lists the operations of, or null for any other page. */
export function systemOfSection(section: string): string | null {
  return CALLS_SECTION.test(section) ? section.slice("calls/".length) : null;
}

function sectionOf(path: string): Section | null {
  return (SECTIONS as string[]).includes(path) || CALLS_SECTION.test(path) ? (path as Section) : null;
}

export function isEntry(section: string): section is EntrySection {
  return (ENTRY_SECTIONS as string[]).includes(section);
}

/** `issue/<fingerprint>?in=errors&q=…`: an issue's page. */
function issueOf(path: string, params: URLSearchParams): Route | null {
  const issue = /^issue\/([0-9a-f]{16})$/.exec(path);
  if (!issue?.[1]) return null;
  return {
    name: "issue",
    fingerprint: issue[1],
    error: params.get("in") === "errors",
    q: params.get("q") || undefined,
  };
}

/** `app/<service>`: an app's page. */
function appOf(path: string): Route | null {
  const app = /^app\/(.+)$/.exec(path);
  return app?.[1] ? { name: "app", service: decodeURIComponent(app[1]) } : null;
}

// What a trace's address says besides its id: where it was opened from, its tab, its span, the part of its time.
const TRACE_PARAMS = ["from", "tab", "span", "part", "range", "logs"] as const;

/** `t/<id>?from=…&tab=…`: a trace's page. */
function traceOf(path: string, params: URLSearchParams): Route | null {
  // `traces/` is how the widget wrote it before; old links still open.
  const trace = /^(?:t|traces)\/(.+)$/.exec(path);
  if (!(trace?.[1] && TRACE_ID.test(trace[1]))) return null;
  const given = TRACE_PARAMS.flatMap((key) => {
    const value = params.get(key);
    return value === null ? [] : [[key, value] as const];
  });
  return { name: "trace", id: trace[1], ...Object.fromEntries(given) };
}

/** A trace's address: its id, then what it says besides. */
function traceAddress(route: Extract<Route, { name: "trace" }>): string {
  const params = new URLSearchParams();
  for (const key of TRACE_PARAMS) {
    const value = route[key];
    if (value) params.set(key, value);
  }
  return `#/t/${route.id}${params.size ? `?${params}` : ""}`;
}

export function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const q = params.get("q") ?? "";
  const named = issueOf(path, params) ?? appOf(path);
  if (named) return named;
  const trace = traceOf(path, params);
  if (trace) return trace;
  const group = /^group\/([a-z]+)\/(.+)$/.exec(path);
  if (group?.[1] && group[2] && isEntry(group[1])) {
    return { name: "group", section: group[1], key: decodeURIComponent(group[2]), q: q || undefined };
  }
  const section = sectionOf(path);
  if (section) {
    return { name: section, q, open: params.get("open") ?? undefined, ...VIEWS[params.get("view") ?? ""] };
  }
  return { name: "home" };
}

/** Errors and other issues share a page; `in` says which list it belongs to, for the crumbs and the menu. */
function issueHref(route: Extract<Route, { name: "issue" }>): string {
  const params = new URLSearchParams();
  if (route.error) params.set("in", "errors");
  if (route.q) params.set("q", route.q);
  return `#/issue/${route.fingerprint}${params.size ? `?${params}` : ""}`;
}

export function href(route: Route): string {
  if (route.name === "home") return "#/";
  if (route.name === "trace") return traceAddress(route);
  if (route.name === "issue") return issueHref(route);
  if (route.name === "app") return `#/app/${encodeURIComponent(route.service)}`;
  if (route.name === "group") {
    const query = route.q ? `?${new URLSearchParams({ q: route.q })}` : "";
    return `#/group/${route.section}/${encodeURIComponent(route.key)}${query}`;
  }
  const params = new URLSearchParams();
  if (route.q) params.set("q", route.q);
  // Every call is what a section opens on; its groups are named.
  if (route.view === "overview") params.set("view", "overview");
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

/** Where a trace's parts lead in the console: linked traces, issues, every request with a call, its logs. */
export function consoleLinks(prefix = "", newTab = false): TraceLinks {
  return {
    trace: (id) => `${prefix}${prefix ? href({ name: "trace", id }) : traceHref(id)}`,
    issue: (fingerprint, kind) => `${prefix}${href(issueRoute(fingerprint, kind))}`,
    call: (key) => `${prefix}${href({ name: "traces", q: `call:${key}` })}`,
    search: (q) => `${prefix}${href({ name: "traces", q })}`,
    logs: (traceId) => `${prefix}${href({ name: "logs", q: `trace:${traceId}` })}`,
    app: (service) => `${prefix}${href({ name: "app", service })}`,
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
