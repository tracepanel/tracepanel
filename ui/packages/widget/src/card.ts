// The pill's hover card: the request at a glance (where its time went, what to fix first, what the page asked
// for after it loaded) before opening the panel.
import { breakdown, categoryLabel } from "@tracepanel/ui/lib/breakdown";
import { percent } from "@tracepanel/ui/lib/percent";
import { plural } from "@tracepanel/ui/lib/plural";
import type { Issue, Trace } from "@tracepanel/ui/types";
import type { TraceInfo } from "./index";

/** How long the pointer rests on the pill before the card shows, and how long it may leave before it hides. */
const SHOW_MS = 250;
const HIDE_MS = 180;
const FINDINGS = 2;
/** The page's other requests listed in the card; the panel has the rest. */
const OTHERS = 4;
/** As on the pill: from here a request's time is amber, from a second red. */
const SLOW_MS = 300;
const VERY_SLOW_MS = 1000;

const KIND_LABELS: Record<Issue["kind"], string> = {
  "n+1": "N+1",
  duplicates: "Duplicates",
  "slow-sql": "Slow query",
  "slow-http": "Slow HTTP call",
  "slow-call": "Slow call",
  "long-transaction": "Long transaction",
  "in-transaction": "Before commit",
  htmx: "htmx",
  "queue-wait": "Queue wait",
  "blocking-call": "Blocking call",
  "large-result": "Large result",
  error: "Error",
};

export const CARD_STYLE = `
  .card {
    position: fixed; right: 16px; bottom: 68px; z-index: 2147483647; box-sizing: border-box;
    width: 380px; max-width: calc(100vw - 32px); padding: 14px 16px 12px;
    border: 1px solid var(--dt-float-border); border-radius: 14px; background: var(--dt-float); color: var(--dt-float-text);
    box-shadow: var(--dt-float-card-shadow);
    font: 400 13px/1.45 "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums; text-align: left;
    opacity: 0; visibility: hidden; transform: translateY(4px); pointer-events: none;
    transition: opacity 120ms ease-out, transform 120ms ease-out, visibility 0s 120ms;
  }
  .card[data-open] { opacity: 1; visibility: visible; transform: none; pointer-events: auto; transition: opacity 120ms ease-out, transform 120ms ease-out; }
  .card * { box-sizing: border-box; }
  .card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .card-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 13px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; }
  /* A request's method as the console's lists show it (.dt-method): its colour in a tint in dark, the colour alone in
     light. The pill's name and the card's head share it. */
  .method {
    display: inline-block; margin-right: 2px; padding: 1px 5px; border-radius: 4px;
    font: 600 11.5px/16px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: 0.02em; color: var(--dt-get); background: rgb(from var(--dt-get) r g b / 0.12);
  }
  .method[data-method="POST"] { color: var(--dt-post); background: rgb(from var(--dt-post) r g b / 0.12); }
  .method:is([data-method="PUT"], [data-method="PATCH"]) { color: var(--dt-put); background: rgb(from var(--dt-put) r g b / 0.14); }
  .method[data-method="DELETE"] { color: var(--dt-delete); background: rgb(from var(--dt-delete) r g b / 0.12); }
  :host([data-theme="light"]) .method { padding-inline: 0; background: none; }
  .card-head .status { flex: none; margin-left: auto; }
  .card-time { flex: none; color: var(--dt-text-2); }
  .card-bar { display: flex; gap: 2px; height: 6px; margin: 12px 0 7px; }
  .card-bar span { min-width: 3px; border-radius: 3px; background: var(--k); }
  .card-most { display: flex; align-items: center; gap: 5px; margin: 0; color: var(--dt-text-3); font-size: 12px; }
  .card-most i { width: 7px; height: 7px; border-radius: 2px; background: var(--k); }
  .card-most b { color: var(--dt-float-text); font-weight: 600; }
  .card-section { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dt-float-rule); }
  .card-caption { margin: 0 0 4px; color: var(--dt-text-3); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
  .card-row {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: baseline; gap: 1px 8px;
    width: calc(100% + 16px); margin: 0 -8px; padding: 6px 8px; border: 0; border-radius: 8px;
    background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  .card-row:hover, .card-row:focus-visible { background: var(--dt-float-hover); outline: none; }
  .card-kind { padding: 1px 7px; border-radius: 999px; background: var(--tint-warn); color: var(--dt-warn); font-size: 11.5px; font-weight: 600; white-space: nowrap; }
  .card-kind[data-tone="error"] { background: var(--tint-error); color: var(--dt-error); }
  .card-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-hint { grid-column: 2 / -1; overflow: hidden; color: var(--dt-text-3); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .card-count { color: var(--dt-text-3); font-size: 12px; }
  .card-code { color: var(--dt-ok); font: 12px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; }
  .card-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12.5px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; }
  .card-ms { color: var(--dt-text-2); font-size: 12px; }
  .card-issues { margin-left: 8px; font-family: "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif; font-size: 11px; }
  .card-ms[data-speed="slow"] { color: var(--dt-warn); font-weight: 600; }
  .card-ms[data-speed="very-slow"] { color: var(--dt-error); font-weight: 600; }
  .card-tag { margin-left: 8px; padding: 0 6px; border-radius: 999px; background: var(--tint-violet); color: var(--dt-accent); font: 600 11px "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif; }
  .card-more {
    margin: 4px 0 0; padding: 2px 0; border: 0; background: none; color: var(--dt-accent);
    font: 500 12px "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif; cursor: pointer;
  }
  .card-more:hover, .card-more:focus-visible { color: var(--dt-float-link-hover); text-decoration: underline; outline: none; }
  .card-skeleton { height: 10px; margin: 8px 0; border-radius: 5px; background: linear-gradient(90deg, var(--dt-float-shimmer), var(--dt-float-shimmer-peak), var(--dt-float-shimmer)); background-size: 200% 100%; animation: card-shimmer 1.2s linear infinite; }
  @keyframes card-shimmer { to { background-position: -200% 0; } }
  /* Where the time went, in the console's span colours. */
  [data-category="django"] { --k: var(--k-django); }
  [data-category="code"] { --k: var(--dt-k-view); }
  [data-category="template"] { --k: var(--dt-k-template); }
  [data-category="sql"] { --k: var(--dt-k-sql); }
  [data-category="cache"] { --k: var(--dt-k-cache); }
  [data-category="http"] { --k: var(--dt-k-http); }
  [data-category="redis"] { --k: var(--dt-k-redis); }
  [data-category="datastore"] { --k: var(--dt-k-datastore); }
  [data-category="messaging"] { --k: var(--dt-k-messaging); }
  [data-category="storage"] { --k: var(--dt-k-storage); }
  [data-category="llm"] { --k: var(--dt-k-llm); }
  [data-category="mail"] { --k: var(--dt-k-mail); }
  [data-category="signal"] { --k: var(--dt-k-signal); }
  .panel[data-open] ~ .card { display: none; }
  @media (prefers-reduced-motion: reduce) { .card { transition: none; } .card-skeleton { animation: none; } }
`;

export interface CardSource {
  /** This page's requests, oldest first: the page (unless cleared) and its AJAX calls. The last is the pill's. */
  requests(): readonly TraceInfo[];
  /** The page's own request among them (null once cleared): tagged "page" in the list. */
  page(): TraceInfo | null;
  /** The panel's API base, for the stored trace; null without one (only the headers are known). */
  api: URL | null;
  /** Whether the panel is open: the card stays away then. */
  panelOpen(): boolean;
  /** Open the panel on a screen, e.g. "#/t/<id>?tab=issues". */
  open(hash: string): void;
  fetch: typeof window.fetch;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ms(microseconds: number): string {
  const value = microseconds / 1000;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  return value >= 10 ? `${Math.round(value)} ms` : `${value.toFixed(1).replace(/\.0$/, "")} ms`;
}

/** As the pill shows time: whole milliseconds, seconds from one. */
function pillMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

function statusChip(status: number | null | undefined): HTMLElement | null {
  if (status === null || status === undefined) return null;
  const chip = element("span", "status", String(status));
  if (status >= 500) chip.dataset["tone"] = "server";
  else if (status >= 400) chip.dataset["tone"] = "client";
  else if (status >= 300) chip.dataset["tone"] = "redirect";
  return chip;
}

function requestName(info: TraceInfo): { method: string; path: string } {
  if (info.name) {
    const [method = "", ...rest] = info.name.split(" ");
    return { method, path: rest.join(" ") };
  }
  const path = info.url ? new URL(info.url, location.href).pathname : location.pathname;
  return { method: info.method ?? "GET", path };
}

/**
 * The fix in a line: the code to add (the hint's last `code`) and where (the culprit), else the hint or the culprit as
 * they are. The full text is the row's tooltip.
 */
function fixLine(issue: Issue): HTMLElement | null {
  const line = element("span", "card-hint");
  const where = issue.culprit?.split(" (")[0];
  // The fix is the hint's last code (`select_related()`); its first may be the place, the culprit's (a template).
  const codes = [...(issue.hint ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
  const code = codes.reverse().find((text) => text !== where);
  if (code) {
    line.append("→ ", element("code", "card-code", code));
    if (where) line.append(` · ${where}`);
  } else if (issue.hint ?? where) {
    line.textContent = issue.hint ?? where ?? "";
  } else {
    return null;
  }
  return line;
}

/** Errors first, then the rest as the agent ordered them. */
function ranked(issues: readonly Issue[]): Issue[] {
  return [...issues].sort((a, b) => Number(b.kind === "error") - Number(a.kind === "error"));
}

function failed(info: TraceInfo): boolean {
  return (info.status ?? 200) >= 500;
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** A request's name with its method in the console's badge ("GET /books"); a name without one (a GraphQL operation) as it is. */
export function nameWithMethod(name: string): (HTMLElement | string)[] {
  const [method = "", ...rest] = name.split(" ");
  return METHODS.has(method) && rest.length ? [methodBadge(method), ` ${rest.join(" ")}`] : [name];
}

/** A request's method in the console's badge: the pill's name and the card's head. */
function methodBadge(method: string): HTMLElement {
  const badge = element("span", "method", method.toUpperCase());
  badge.dataset["method"] = method.toUpperCase();
  return badge;
}

/** As on the pill: a request's time is amber from 300 ms, red from a second. */
function speedOf(total: number): "slow" | "very-slow" | undefined {
  if (total >= VERY_SLOW_MS) return "very-slow";
  return total >= SLOW_MS ? "slow" : undefined;
}

/** A request's row name: method and path, "page" on the page itself, and its findings as an amber chip. */
function requestLabel(info: TraceInfo, isPage: boolean): HTMLElement {
  const { method, path } = requestName(info);
  const name = element("span", "card-path", `${method} ${path}`);
  if (isPage) name.append(element("span", "card-tag", "page"));
  // What makes a fast 200 worth opening.
  if (info.issues) name.append(element("span", "card-kind card-issues", plural(info.issues, "issue", "issues")));
  return name;
}

/** Its time, amber or red when slow. */
function timeCell(info: TraceInfo): HTMLElement {
  const total = info.totalMs ?? 0;
  const time = element("span", "card-ms", pillMs(total));
  const speed = speedOf(total);
  if (speed) time.dataset["speed"] = speed;
  return time;
}

/** "Most time: Your code 4.6 ms · 78%": the bar's biggest part in words. */
function mostLine(label: string, category: string, value: number, total: number): HTMLElement {
  const line = element("p", "card-most");
  line.dataset["category"] = category;
  line.append(element("i"), `Most time: ${label} `, element("b", undefined, ms(value)), ` · ${percent(value, total)}`);
  return line;
}

/** Worst first: failed, then with issues, then slowest. */
function worstFirst(requests: readonly TraceInfo[]): TraceInfo[] {
  const rank = (info: TraceInfo) => (failed(info) ? 2 : info.issues ? 1 : 0);
  return [...requests].sort((a, b) => rank(b) - rank(a) || (b.totalMs ?? 0) - (a.totalMs ?? 0));
}

/** The narrowest the card gets: its findings and bar need the room, a short pill ("Waiting") or not. */
const MIN_CARD_WIDTH = 320;

/** The card over the pill, its edges on the pill's: as wide as the pill and right where it is. */
function alignWith(card: HTMLElement, badge: HTMLElement): void {
  const box = badge.getBoundingClientRect();
  card.style.right = `${Math.round(window.innerWidth - box.right)}px`;
  card.style.width = `${Math.round(Math.max(box.width, MIN_CARD_WIDTH))}px`;
}

export function mountCard(root: ShadowRoot, badge: HTMLElement, source: CardSource): { hide: () => void } {
  const card = element("div", "card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "This request at a glance");
  root.append(card);
  // One fetch per stored trace: hovering again shows it at once.
  const traces = new Map<string, Promise<Trace | null>>();
  let showTimer: number | undefined;
  let hideTimer: number | undefined;

  function load(id: string): Promise<Trace | null> {
    let found = traces.get(id);
    if (!found) {
      found = source.api
        ? source
            .fetch(new URL(`api/traces/${encodeURIComponent(id)}`, source.api), { credentials: "same-origin" })
            .then((response) => (response.ok ? (response.json() as Promise<Trace>) : null))
            .catch(() => null)
        : Promise.resolve(null);
      traces.set(id, found);
      // A trace not stored yet (the agent is still writing it) is asked again on the next hover.
      void found.then((trace) => trace ?? traces.delete(id));
    }
    return found;
  }

  function head(info: TraceInfo, trace: Trace | null): HTMLElement {
    const row = element("div", "card-head");
    const { method, path } = requestName(info);
    const name = element("span", "card-name");
    name.append(...nameWithMethod(`${method} ${path}`));
    name.title = `${method} ${path}`;
    row.append(name);
    const chip = statusChip(info.status);
    if (chip) row.append(chip);
    // The pill's number, rounded the pill's way: the two never disagree.
    row.append(element("span", "card-time", pillMs(info.totalMs ?? (trace?.duration ?? 0) / 1000)));
    return row;
  }

  /** The bar of where the time went, and in words only the biggest part. */
  function timing(info: TraceInfo, trace: Trace): HTMLElement[] {
    const parts = breakdown(trace);
    const total = Math.max(
      parts.reduce((sum, [, value]) => sum + value, 0),
      1,
    );
    const bar = element("div", "card-bar");
    bar.setAttribute("role", "img");
    for (const [category, value] of parts) {
      const piece = element("span");
      piece.dataset["category"] = category;
      piece.style.flex = `${value / total} 1 0`;
      piece.title = `${categoryLabel(category, trace)} ${ms(value)}`;
      bar.append(piece);
    }
    const [top] = [...parts].sort((a, b) => b[1] - a[1]);
    if (!top) return [bar];
    const [category, value] = top;
    const label = categoryLabel(category, trace);
    bar.setAttribute("aria-label", `Most time: ${label}, ${ms(value)}`);
    // A failed request's story is its error (under Fix first), not where its time went.
    return failed(info) ? [bar] : [bar, mostLine(label, category, value, total)];
  }

  function findings(info: TraceInfo, trace: Trace): HTMLElement | null {
    if (!info.trace || trace.issues.length === 0) return null;
    const traceId = info.trace;
    const section = element("section", "card-section");
    section.append(element("p", "card-caption", "Fix first"));
    const issues = ranked(trace.issues);
    for (const issue of issues.slice(0, FINDINGS)) {
      const row = element("button", "card-row");
      row.type = "button";
      const label = KIND_LABELS[issue.kind];
      const kind = element("span", "card-kind", label);
      if (issue.kind === "error") kind.dataset["tone"] = "error";
      // The chip already says the kind ("N+1: 50 similar queries…"), and a count already in the title isn't repeated.
      // "N+1: 50 similar queries …", "Duplicate queries: 10 identical …": the chip says what comes before the colon.
      const title = issue.title.replace(/^[^:]{1,40}: /, "");
      const count = issue.count > 1 && !title.includes(String(issue.count)) ? `×${issue.count}` : "";
      row.append(kind, element("span", "card-title", title), element("span", "card-count", count));
      const hint = fixLine(issue);
      if (hint) row.append(hint);
      row.title = [issue.title, issue.culprit, issue.hint, "Click to open it in the panel"].filter(Boolean).join("\n");
      row.addEventListener("click", () => {
        hide(true);
        source.open(`#/t/${traceId}?tab=${issue.kind === "error" ? "error" : "issues"}`);
      });
      section.append(row);
    }
    if (issues.length > FINDINGS) section.append(moreLink(issues.length - FINDINGS, `#/t/${traceId}?tab=issues`));
    return section;
  }

  /** What its task runs found, apart from its own: a click opens its call tree, where they hang under it. */
  function taskFindings(info: TraceInfo): HTMLElement[] {
    const traceId = info.trace;
    if (!(info.taskIssues && traceId)) return [];
    const section = element("section", "card-section");
    section.append(element("p", "card-caption", "In its tasks"));
    const row = element("button", "card-row");
    row.type = "button";
    const label = plural(info.taskIssues, "issue", "issues");
    row.append(
      element("span", "card-kind", label),
      element("span", "card-title", "found by the tasks it enqueued"),
      element("span", "card-count"),
    );
    row.title = `${label} in its tasks\nClick to open its call tree in the panel`;
    row.addEventListener("click", () => {
      hide(true);
      source.open(`#/t/${traceId}?tab=tree`);
    });
    section.append(row);
    return [section];
  }

  function otherRequests(later: readonly TraceInfo[]): HTMLElement | null {
    const page = source.page();
    if (later.length === 0) return null;
    // Every one of them, worst first, so the count in the caption is the rows below it (and "+N more" the rest);
    // each row says why it matters: its status, its time in amber or red when slow.
    const sorted = worstFirst(later);
    const section = element("section", "card-section");
    section.append(element("p", "card-caption", `Other requests on this page · ${later.length}`));
    for (const info of sorted.slice(0, OTHERS)) section.append(requestRow(info, info === page));
    // The panel lists them all; it opens on the first one not shown here.
    const next = sorted[OTHERS]?.trace;
    if (next) section.append(moreLink(sorted.length - OTHERS, `#/t/${next}`));
    return section;
  }

  /** One of the page's other requests: status, name, time; a click opens it in the panel. */
  function requestRow(info: TraceInfo, isPage: boolean): HTMLElement {
    const row = element("button", "card-row");
    row.type = "button";
    row.append(statusChip(info.status) ?? element("span"), requestLabel(info, isPage), timeCell(info));
    const { method, path } = requestName(info);
    row.title = `${method} ${path}\nClick to open it in the panel`;
    const trace = info.trace;
    if (trace) {
      row.addEventListener("click", () => {
        hide(true);
        source.open(`#/t/${trace}`);
      });
    }
    return row;
  }

  /** "+2 more →": opens the panel where the rest are. */
  function moreLink(count: number, hash: string): HTMLElement {
    const link = element("button", "card-more", `+${count} more in the panel →`);
    link.type = "button";
    link.addEventListener("click", () => {
      hide(true);
      source.open(hash);
    });
    return link;
  }

  function render(info: TraceInfo, later: readonly TraceInfo[], trace: Trace | null, loading: boolean): void {
    card.textContent = "";
    card.append(head(info, trace));
    if (trace) card.append(...timing(info, trace));
    else if (loading) card.append(element("div", "card-skeleton"), element("div", "card-skeleton"));
    const fixes = trace ? findings(info, trace) : null;
    if (fixes) card.append(fixes);
    card.append(...taskFindings(info));
    const after = otherRequests(later);
    if (after) card.append(after);
  }

  /** The request the pill shows (the latest), and the page's others. */
  function current(): { info: TraceInfo | undefined; rest: readonly TraceInfo[] } {
    const all = source.requests();
    return { info: all.at(-1), rest: all.slice(0, -1) };
  }

  function show(): void {
    window.clearTimeout(hideTimer);
    if (source.panelOpen()) return;
    const { info, rest } = current();
    if (!info) return;
    const id = info.trace;
    render(info, rest, null, Boolean(id && source.api));
    alignWith(card, badge);
    card.toggleAttribute("data-open", true);
    if (!id) return;
    void load(id).then((trace) => {
      const now = current();
      // Still open on the same request (a boosted link may have moved on): draw it with its trace.
      if (card.hasAttribute("data-open") && now.info?.trace === id) render(now.info, now.rest, trace, false);
    });
  }

  function hide(now = false): void {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    if (now) card.removeAttribute("data-open");
    else hideTimer = window.setTimeout(() => card.removeAttribute("data-open"), HIDE_MS);
  }

  const enter = (event: PointerEvent) => {
    // A touch has no hover: a tap opens the panel as before.
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(hideTimer);
    if (!card.hasAttribute("data-open")) showTimer = window.setTimeout(show, SHOW_MS);
  };
  const leave = (event: PointerEvent) => event.pointerType === "mouse" && hide();
  badge.addEventListener("pointerenter", enter);
  badge.addEventListener("pointerleave", leave);
  card.addEventListener("pointerenter", () => window.clearTimeout(hideTimer));
  card.addEventListener("pointerleave", leave);
  // From the keyboard: the card comes with the pill's focus ring and goes when focus leaves both.
  badge.addEventListener("focus", () => badge.matches(":focus-visible") && show());
  badge.addEventListener("click", () => hide(true));
  const blur = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node && (card.contains(event.relatedTarget) || badge === event.relatedTarget)))
      hide();
  };
  badge.addEventListener("blur", blur);
  card.addEventListener("focusout", blur);
  return { hide: () => hide(true) };
}
