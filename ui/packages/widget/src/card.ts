// The pill's hover card: the request at a glance (where its time went, what to fix first, what the page asked
// for after it loaded) before opening the panel.
import { duration } from "@tracepanel/ui/format";
import { breakdown, categoryLabel } from "@tracepanel/ui/lib/breakdown";
import { clockOf, cutNote, NO_ANSWER, PENDING, runningLabel, runningTime } from "@tracepanel/ui/lib/live";
import { percent } from "@tracepanel/ui/lib/percent";
import { plural } from "@tracepanel/ui/lib/plural";
import { WAITED_SHARE, withWaiting } from "@tracepanel/ui/lib/waitingShare";
import type { Issue, Trace } from "@tracepanel/ui/types";
import type { Counted, Flight, TraceInfo } from "./index";
import type { ChainFacts } from "./viewChain";

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
  "migration-risk": "Migration risk",
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
  /* A call no trace answered, as the panel's list says it: muted, beside its name. */
  .card-not-traced { margin-left: 8px; color: var(--dt-text-3); font: italic 11.5px "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif; }
  .card-more {
    margin: 4px 0 0; padding: 2px 0; border: 0; background: none; color: var(--dt-accent);
    font: 500 12px "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif; cursor: pointer;
  }
  .card-more:hover, .card-more:focus-visible { color: var(--dt-float-link-hover); text-decoration: underline; outline: none; }
  .card-wait { display: flex; align-items: center; gap: 6px; margin: 10px 0 0; color: var(--dt-text-3); font-size: 12px; }
  .card-facts { margin: 8px 0 0; color: var(--dt-text-3); font-size: 12px; }
  .card-facts b { color: var(--dt-float-text); font-weight: 600; }
  .card-running { display: inline-flex; align-items: center; gap: 5px; }
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
  /* The code's waits: neutral and hatched, as the console's strip draws them. */
  [data-category="waiting"] {
    --k: color-mix(in srgb, var(--dt-text-3) 50%, transparent);
    background-image: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--dt-text-3) 45%, transparent) 0 2px, transparent 2px 5px);
  }
  .card-most[data-category="waiting"] { background-image: none; }
  .card-most[data-category="waiting"] i { background-image: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--dt-text-3) 45%, transparent) 0 2px, transparent 2px 5px); }
  .panel[data-open] ~ .card { display: none; }
  /* A card out of sight shimmers no more, still loading or not. */
  .card:not([data-open]) .card-skeleton { animation: none; }
  @media (prefers-reduced-motion: reduce) { .card { transition: none; } .card-skeleton { animation: none; } }
`;

/** The page's view in the browser (an SPA's route), and what its chain says once counted. */
export interface CardView {
  view: { name: string; start: number; duration: number; open: boolean; status: "ok" | "error" };
  facts: ChainFacts | null;
  /** Open, its calls all answered: where its time stops until it ends (epoch µs). */
  until?: number | undefined;
}

/**
 * One of the page's calls no trace answered (a gateway's, a service's that sends none), or that got no answer at all
 * (`failed`): the panel's list has its row, the pill counts it, and so does the card.
 */
export interface UntracedCall {
  /** Its name, status (none when it failed) and time, as the browser saw the call. */
  info: TraceInfo;
  /** The view or action that made it: its call tree has the call. */
  parent: string;
  failed: boolean;
}

export interface CardSource {
  /** This page's requests, oldest first: the page (unless cleared) and its AJAX calls. The last is the pill's. */
  requests(): readonly TraceInfo[];
  /** Its calls no trace answered or that got no answer, oldest first: counted and listed with the others. */
  untraced(): readonly UntracedCall[];
  /** Its requests still in flight, oldest first: the newest is the pill's while there is one (lib/live). */
  flights(): readonly Flight[];
  /** Its view, when the browser recording has one: the card's head before any request. */
  view(): CardView | null;
  /** A request's numbers as the pill says them: its chain's, pending until counted. */
  counted(info: TraceInfo): Counted;
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
function requestLabel(info: TraceInfo, isPage: boolean, issues: number): HTMLElement {
  const { method, path } = requestName(info);
  const name = element("span", "card-path", `${method} ${path}`);
  if (isPage) name.append(element("span", "card-tag", "page"));
  // What makes a fast 200 worth opening.
  if (issues) name.append(element("span", "card-kind card-issues", plural(issues, "issue", "issues")));
  return name;
}

/** A view's time in its card's head: running while it is open, stopped at `until`. */
function viewTime(view: CardView["view"], until: number | undefined): HTMLElement {
  return view.open
    ? runningCell(view.start / 1000, "card-time", until)
    : element("span", "card-time", duration(view.duration));
}

/** Under a view's head, when its trace went out with a call unanswered: "no answer yet". */
function cutLine(cut: number | null): HTMLElement[] {
  if (cut === null) return [];
  const wait = element("p", "card-wait");
  wait.append(noAnswerMark(cut), "a call hadn't answered when its trace went out");
  return [wait];
}

/** What a view's calls did down its chain, pending until counted; while it is open, that it is. */
function factsLine(open: boolean, facts: ChainFacts | null): HTMLElement {
  const line = element("p", "card-facts");
  if (open) line.append("Still open: its trace is sent once it ends.");
  else if (!facts?.counts) line.append(`Down its calls: ${PENDING}`);
  else line.append("Down its calls: ", ...countsOf(facts.counts));
  return line;
}

/** "3 queries · 19 HTTP calls · 2 issues", each number bold. */
function countsOf({ queries, calls, issues }: NonNullable<ChainFacts["counts"]>): (HTMLElement | string)[] {
  const parts = [plural(queries, "query", "queries"), plural(calls, "HTTP call", "HTTP calls")];
  if (issues) parts.push(plural(issues, "issue", "issues"));
  return parts.flatMap((part, index) => [...(index ? [" · "] : []), element("b", undefined, part)]);
}

/** In flight: the ring and the time so far (from `start`, epoch ms), as the pill says it; stopped at `until` (µs). */
function runningCell(start: number, className: string, until?: number): HTMLElement {
  const cell = element("span", `${className} card-running`);
  const ring = element("span", "running");
  ring.setAttribute("aria-hidden", "true");
  const now = clockOf(until);
  cell.append(ring, runningTime(start * 1000, now));
  cell.title = runningLabel(start * 1000, now);
  return cell;
}

/** The hourglass and "no answer yet", as the pill's. */
function noAnswerMark(at: number | null): HTMLElement {
  const mark = element("span", "no-answer");
  mark.dataset["state"] = "cut";
  mark.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>';
  mark.append(NO_ANSWER);
  mark.title = cutNote(at);
  return mark;
}

/** Its time, amber or red when slow. */
function timeCell(info: TraceInfo): HTMLElement {
  const total = info.totalMs ?? 0;
  const time = element("span", "card-ms", duration(total * 1000));
  const speed = speedOf(total);
  if (speed) time.dataset["speed"] = speed;
  return time;
}

/** "Most time: Your code 4.6 ms · 78%": the bar's biggest part in words. */
function mostLine(label: string, category: string, value: number, total: number): HTMLElement {
  const line = element("p", "card-most");
  line.dataset["category"] = category;
  line.append(
    element("i"),
    `Most time: ${label} `,
    element("b", undefined, duration(value)),
    ` · ${percent(value, total)}`,
  );
  return line;
}

/**
 * One of the page's other requests in the card: a traced one, or a call no trace answered (`call`), with what ranks
 * it: failed, its findings.
 */
type Other = { info: TraceInfo; call?: UntracedCall | undefined; failed: boolean; issues: number };

/** Worst first: failed, then with issues, then slowest. */
function worstFirst(others: readonly Other[]): Other[] {
  const rank = (other: Other) => (other.failed ? 2 : other.issues ? 1 : 0);
  return [...others].sort((a, b) => rank(b) - rank(a) || (b.info.totalMs ?? 0) - (a.info.totalMs ?? 0));
}

/** Where a call no trace answered has its status: "failed" in red for one that got no answer. */
function callStatus(call: UntracedCall): HTMLElement {
  if (!call.failed) return statusChip(call.info.status) ?? element("span");
  const chip = element("span", "status", "failed");
  chip.dataset["tone"] = "server";
  return chip;
}

/** A call no trace answered, in its tooltip: what it is, and that a click opens the call tree that has it. */
function callTitle(call: UntracedCall, name: string): string {
  const what = call.failed ? "failed, no answer came" : "not traced, its server sent no trace for this call";
  return `${name}: ${what}\nClick to open the call tree that has it`;
}

/**
 * A request answered before its app had written its trace: the card open on it asks again this often, this many times
 * (about 15 s, as long as a view's trace may take), until it is stored. Then it fills in, no hover needed.
 */
const RETRY_MS = 500;
const RETRIES = 30;

/** The narrowest the card gets: its findings and bar need the room, a short pill ("Waiting") or not. */
const MIN_CARD_WIDTH = 320;

/** The card over the pill, its edges on the pill's: as wide as the pill and right where it is. */
function alignWith(card: HTMLElement, badge: HTMLElement): void {
  const box = badge.getBoundingClientRect();
  card.style.right = `${Math.round(window.innerWidth - box.right)}px`;
  card.style.width = `${Math.round(Math.max(box.width, MIN_CARD_WIDTH))}px`;
}

export function mountCard(
  root: ShadowRoot,
  badge: HTMLElement,
  source: CardSource,
): { hide: () => void; refresh: () => void } {
  const card = element("div", "card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "This request at a glance");
  root.append(card);
  // One fetch per stored trace: hovering again shows it at once.
  const traces = new Map<string, Promise<Trace | null>>();
  // Those loaded, for drawing again as the pill changes while the card is open.
  const resolved = new Map<string, Trace | null>();
  let showTimer: number | undefined;
  let hideTimer: number | undefined;
  // A trace not stored yet, asked for again while the card stays open on it: its id, the timer, how many times so far.
  let retry: { id: string; timer: number | undefined; count: number } | null = null;

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
      void found.then((trace) => {
        if (trace) return;
        traces.delete(id);
        resolved.delete(id);
      });
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
    // The pill's number, said as the panel's list says it (0.5 ms): the three never disagree.
    row.append(element("span", "card-time", duration((info.totalMs ?? (trace?.duration ?? 0) / 1000) * 1000)));
    return row;
  }

  /** The bar of where the time went, and in words only the biggest part. */
  function timing(info: TraceInfo, trace: Trace): HTMLElement[] {
    // The code's waits split out of its own time, as the console's legend has them.
    const parts = withWaiting(trace, breakdown(trace));
    const labelOf = (category: (typeof parts)[number][0]) =>
      category === WAITED_SHARE ? "Waiting" : categoryLabel(category, trace);
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
      piece.title = `${labelOf(category)} ${duration(value)}`;
      bar.append(piece);
    }
    const [top] = [...parts].sort((a, b) => b[1] - a[1]);
    if (!top) return [bar];
    const [category, value] = top;
    const label = labelOf(category);
    bar.setAttribute("aria-label", `Most time: ${label}, ${duration(value)}`);
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

  /**
   * The page's other requests, worst first, those still in flight on top (their time ticking): the count in the
   * caption is the rows below it (and "+N more" the rest). Each row says why it matters: its status, its time in
   * amber or red when slow.
   */
  function otherRequests(later: readonly TraceInfo[], flying: readonly Flight[]): HTMLElement | null {
    const page = source.page();
    const others: Other[] = [
      ...later.map((info) => ({ info, failed: failed(info), issues: source.counted(info).issues })),
      ...source
        .untraced()
        .map((call) => ({ info: call.info, call, failed: call.failed || failed(call.info), issues: 0 })),
    ];
    const count = others.length + flying.length;
    if (count === 0) return null;
    const sorted = worstFirst(others);
    const section = element("section", "card-section");
    section.append(element("p", "card-caption", `Other requests on this page · ${count}`));
    const flights = [...flying].reverse().slice(0, OTHERS);
    for (const flight of flights) section.append(flightRow(flight));
    for (const { info, call } of sorted.slice(0, OTHERS - flights.length)) {
      section.append(call ? callRow(call) : requestRow(info, info === page));
    }
    // The panel lists them all; it opens on the first one not shown here.
    const shown = Math.min(count, OTHERS);
    const next = sorted[OTHERS - flights.length];
    const hash = next?.call ? `#/t/${next.call.parent}` : next?.info.trace ? `#/t/${next.info.trace}` : "#/";
    if (count > shown) section.append(moreLink(count - shown, hash));
    return section;
  }

  /** One of the page's requests still in flight: its name, the ring and its time so far. */
  function flightRow(flight: Flight): HTMLElement {
    const row = element("button", "card-row");
    row.type = "button";
    const info = { name: flight.name, method: flight.method, url: flight.url };
    const { method, path } = requestName(info);
    row.append(
      element("span"),
      element("span", "card-path flying", `${method} ${path}`),
      runningCell(flight.start, "card-ms"),
    );
    row.title = `${method} ${path}: ${runningLabel(flight.start * 1000)}`;
    row.addEventListener("click", () => {
      hide(true);
      source.open("#/");
    });
    return row;
  }

  /** One of the page's other requests: status, name, time; a click opens it in the panel. */
  function requestRow(info: TraceInfo, isPage: boolean): HTMLElement {
    const row = element("button", "card-row");
    row.type = "button";
    row.append(
      statusChip(info.status) ?? element("span"),
      requestLabel(info, isPage, source.counted(info).issues),
      timeCell(info),
    );
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

  /**
   * A call no trace answered, as the panel's list has it: its status, its name, "not traced" muted beside it (its
   * reason in the tooltip), its time; one that got no answer says "failed" in red where its status would be. A click
   * opens the call tree of the view that made it, which has the call.
   */
  function callRow(call: UntracedCall): HTMLElement {
    const row = element("button", "card-row");
    row.type = "button";
    row.dataset["call"] = call.failed ? "failed" : "untraced";
    const { method, path } = requestName(call.info);
    const name = element("span", "card-path", `${method} ${path}`);
    if (!call.failed) name.append(element("span", "card-not-traced", "not traced"));
    row.append(callStatus(call), name, timeCell(call.info));
    row.title = callTitle(call, `${method} ${path}`);
    row.addEventListener("click", () => {
      hide(true);
      source.open(`#/t/${call.parent}`);
    });
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
    const after = otherRequests(later, source.flights());
    if (after) card.append(after);
  }

  /** A request still in flight: its name, its time so far; it says it waits for its answer. */
  function renderFlight(flight: Flight, later: readonly TraceInfo[], flying: readonly Flight[]): void {
    card.textContent = "";
    const row = element("div", "card-head");
    const { method, path } = requestName({ name: flight.name, method: flight.method, url: flight.url });
    const name = element("span", "card-name");
    name.append(...nameWithMethod(`${method} ${path}`));
    name.title = `${method} ${path}`;
    row.append(name, runningCell(flight.start, "card-time"));
    const wait = element("p", "card-wait");
    wait.append("Waiting for its answer: its trace opens in the panel once its app has written it.");
    card.append(row, wait);
    const after = otherRequests(later, flying);
    if (after) card.append(after);
  }

  /** The page's view, before any request: running while open, its time, "no answer yet" when cut, its chain's numbers. */
  function renderView({ view, facts, until }: CardView): void {
    card.textContent = "";
    const row = element("div", "card-head");
    const name = element("span", "card-name");
    name.append(...nameWithMethod(`VIEW ${view.name}`));
    row.append(name, viewTime(view, until));
    card.append(row, ...cutLine(facts?.cut ?? null), factsLine(view.open, facts));
  }

  /** The request the pill shows (the newest in flight, else the latest), and the page's others. */
  function current(): { info: TraceInfo | undefined; rest: readonly TraceInfo[] } {
    const all = source.requests();
    return { info: all.at(-1), rest: all.slice(0, -1) };
  }

  /** Draws what the pill shows now: a request in flight, else the latest done, else the page's view. */
  function draw(): void {
    const flying = source.flights();
    const flight = flying.at(-1);
    if (flight) renderFlight(flight, source.requests(), flying.slice(0, -1));
    else if (current().info) drawRequest();
    else drawView();
  }

  function drawView(): void {
    const view = source.view();
    if (view) renderView(view);
  }

  /** The latest request done; with its stored trace once loaded, drawn again then if it is still the card's. */
  function drawRequest(): void {
    const { info, rest } = current();
    if (info) drawDone(info, rest);
  }

  function drawDone(info: TraceInfo, rest: readonly TraceInfo[]): void {
    const id = info.trace ?? "";
    const known = resolved.get(id);
    const loading = known === undefined && canLoad(id);
    render(info, rest, known ?? null, loading);
    if (loading) void load(id).then((trace) => landed(id, trace));
  }

  /** Whether a request's stored trace can be asked for: it has one, and there is a console to ask. */
  function canLoad(id: string): boolean {
    return id !== "" && source.api !== null;
  }

  /**
   * A trace loaded: kept, and drawn if the card is still open on its request. One not stored yet (the request
   * answered before its app wrote it) is asked again while the card stays open on it: it fills in once stored.
   */
  function landed(id: string, trace: Trace | null): void {
    if (!trace) {
      if (stillOn(id)) askAgain(id);
      return;
    }
    resolved.set(id, trace);
    if (retry?.id === id) {
      window.clearTimeout(retry.timer);
      retry = null;
    }
    if (stillOn(id)) draw();
  }

  /** The card open on a request whose trace isn't stored yet: drawn again (and so asked again) in a moment. */
  function askAgain(id: string): void {
    const count = retry?.id === id ? retry.count + 1 : 1;
    window.clearTimeout(retry?.timer);
    if (count > RETRIES) {
      resolved.set(id, null);
      retry = null;
      draw();
      return;
    }
    retry = {
      id,
      count,
      timer: window.setTimeout(() => {
        if (retry) retry.timer = undefined;
        if (stillOn(id)) draw();
      }, RETRY_MS),
    };
  }

  /** Whether the card is still open on the request `id`, none in flight in front of it. */
  function stillOn(id: string): boolean {
    return card.hasAttribute("data-open") && current().info?.trace === id && source.flights().length === 0;
  }

  function show(): void {
    window.clearTimeout(hideTimer);
    if (source.panelOpen()) return;
    if (!source.requests().length && !source.flights().length && !source.view()) return;
    // A trace given up on while the card was open is asked for again on this hover.
    const id = current().info?.trace;
    if (id && resolved.get(id) === null) resolved.delete(id);
    draw();
    alignWith(card, badge);
    card.toggleAttribute("data-open", true);
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
  return {
    hide: () => hide(true),
    // The pill drew again (a request took off or landed, a time ticked, a count came): the open card follows it.
    refresh: () => {
      if (card.hasAttribute("data-open")) {
        draw();
        alignWith(card, badge);
      }
    },
  };
}
