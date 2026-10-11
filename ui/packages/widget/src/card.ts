// The pill's hover card: the request at a glance (where its time went, what to fix first, what the page asked
// for after it loaded) before opening the panel.
import { breakdown, CATEGORY_LABELS, type Category } from "@tracepanel/ui/lib/breakdown";
import type { Issue, Trace } from "@tracepanel/ui/types";
import type { TraceInfo } from "./index";

/** How long the pointer rests on the pill before the card shows, and how long it may leave before it hides. */
const SHOW_MS = 250;
const HIDE_MS = 180;
const FINDINGS = 2;
const LATER = 3;
/** A later request this slow is worth a row of its own; faster ones that went fine are only counted. */
const SLOW_MS = 300;

const KIND_LABELS: Record<Issue["kind"], string> = {
  "n+1": "N+1",
  duplicates: "Duplicates",
  "slow-sql": "Slow query",
  "long-transaction": "Long transaction",
  "in-transaction": "Before commit",
  htmx: "htmx",
  error: "Error",
};

export const CARD_STYLE = `
  .card {
    position: fixed; right: 16px; bottom: 68px; z-index: 2147483647; box-sizing: border-box;
    width: 380px; max-width: calc(100vw - 32px); padding: 14px 16px 12px;
    border: 1px solid rgb(255 255 255 / 0.09); border-radius: 14px; background: #0e1117; color: #e7e9ef;
    box-shadow: 0 18px 48px rgb(10 12 17 / 0.42), 0 2px 6px rgb(10 12 17 / 0.2), inset 0 1px rgb(255 255 255 / 0.05);
    font: 400 13px/1.45 "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums; text-align: left;
    opacity: 0; visibility: hidden; transform: translateY(4px); pointer-events: none;
    transition: opacity 120ms ease-out, transform 120ms ease-out, visibility 0s 120ms;
  }
  .card[data-open] { opacity: 1; visibility: visible; transform: none; pointer-events: auto; transition: opacity 120ms ease-out, transform 120ms ease-out; }
  .card * { box-sizing: border-box; }
  .card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .card-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 13px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; }
  .card-method { color: #bc9cff; }
  .card-head .status { flex: none; margin-left: auto; }
  .card-time { flex: none; color: #b9bfcd; }
  .card-bar { display: flex; gap: 2px; height: 6px; margin: 12px 0 7px; }
  .card-bar span { min-width: 3px; border-radius: 3px; background: var(--k); }
  .card-most { display: flex; align-items: center; gap: 5px; margin: 0; color: #8c93a6; font-size: 12px; }
  .card-most i { width: 7px; height: 7px; border-radius: 2px; background: var(--k); }
  .card-most b { color: #e7e9ef; font-weight: 600; }
  .card-section { margin-top: 12px; padding-top: 10px; border-top: 1px solid rgb(255 255 255 / 0.07); }
  .card-caption { margin: 0 0 4px; color: #8c93a6; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
  .card-row {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: baseline; gap: 1px 8px;
    width: calc(100% + 16px); margin: 0 -8px; padding: 6px 8px; border: 0; border-radius: 8px;
    background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  .card-row:hover, .card-row:focus-visible { background: rgb(255 255 255 / 0.06); outline: none; }
  .card-kind { padding: 1px 7px; border-radius: 999px; background: rgb(245 181 68 / 0.15); color: #f5b544; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
  .card-kind[data-tone="error"] { background: rgb(255 107 94 / 0.16); color: #ff8a7a; }
  .card-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-hint { grid-column: 2 / -1; overflow: hidden; color: #8c93a6; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .card-count { color: #8c93a6; font-size: 12px; }
  .card-code { color: #b8f25c; font: 12px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; }
  .card-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12.5px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; }
  .card-ms { color: #b9bfcd; font-size: 12px; }
  .card-tag { margin-left: 8px; padding: 0 6px; border-radius: 999px; background: rgb(165 135 255 / 0.16); color: #bc9cff; font: 600 11px "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif; }
  .card-more { margin: 4px 0 0; color: #8c93a6; font-size: 12px; }
  .card-skeleton { height: 10px; margin: 8px 0; border-radius: 5px; background: linear-gradient(90deg, rgb(255 255 255 / 0.05), rgb(255 255 255 / 0.11), rgb(255 255 255 / 0.05)); background-size: 200% 100%; animation: card-shimmer 1.2s linear infinite; }
  @keyframes card-shimmer { to { background-position: -200% 0; } }
  [data-category="django"] { --k: rgb(140 147 166 / 0.4); }
  [data-category="view"], [data-category="code"] { --k: #a587ff; }
  [data-category="template"] { --k: #2dd4bf; }
  [data-category="sql"] { --k: #9db2ff; }
  [data-category="cache"] { --k: #f5b544; }
  [data-category="mail"] { --k: #f472b6; }
  :host([data-theme="light"]) .card {
    border-color: #e2e2dc; background: #ffffff; color: #16181d;
    box-shadow: 0 18px 44px rgb(22 24 29 / 0.14), 0 1px 3px rgb(22 24 29 / 0.08);
  }
  :host([data-theme="light"]) .card-method { color: #6d3fe0; }
  :host([data-theme="light"]) .card-time, :host([data-theme="light"]) .card-ms { color: #3a3e47; }
  :host([data-theme="light"]) .card-most, :host([data-theme="light"]) .card-hint, :host([data-theme="light"]) .card-count,
  :host([data-theme="light"]) .card-caption, :host([data-theme="light"]) .card-more { color: #5f6470; }
  :host([data-theme="light"]) .card-most b { color: #16181d; }
  :host([data-theme="light"]) .card-section { border-top-color: #ecece7; }
  :host([data-theme="light"]) .card-row:hover, :host([data-theme="light"]) .card-row:focus-visible { background: #f5f5f2; }
  :host([data-theme="light"]) .card-kind { background: rgb(217 119 6 / 0.1); color: #b45309; }
  :host([data-theme="light"]) .card-kind[data-tone="error"] { background: rgb(208 52 44 / 0.09); color: #d0342c; }
  :host([data-theme="light"]) .card-code { color: #3d7a0c; }
  :host([data-theme="light"]) .card-tag { background: rgb(109 63 224 / 0.1); color: #6d3fe0; }
  :host([data-theme="light"]) [data-category="django"] { --k: rgb(95 100 112 / 0.3); }
  :host([data-theme="light"]) [data-category="view"], :host([data-theme="light"]) [data-category="code"] { --k: #7c4ff0; }
  :host([data-theme="light"]) [data-category="template"] { --k: #0d9488; }
  :host([data-theme="light"]) [data-category="sql"] { --k: #3456d6; }
  :host([data-theme="light"]) [data-category="cache"] { --k: #d97706; }
  :host([data-theme="light"]) [data-category="mail"] { --k: #db2777; }
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
 * The fix in a line: the code to add (the hint's `code`) and where (the culprit), else the hint or the culprit as
 * they are. The full text is the row's tooltip.
 */
function fixLine(issue: Issue): HTMLElement | null {
  const line = element("span", "card-hint");
  const code = issue.hint?.match(/`([^`]+)`/)?.[1];
  const where = issue.culprit?.split(" (")[0];
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

/** Worst first: failed, then with issues, then slowest. */
function worstFirst(requests: readonly TraceInfo[]): TraceInfo[] {
  const rank = (info: TraceInfo) => ((info.status ?? 200) >= 500 ? 2 : info.issues ? 1 : 0);
  return [...requests].sort((a, b) => rank(b) - rank(a) || (b.totalMs ?? 0) - (a.totalMs ?? 0));
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
    name.append(element("span", "card-method", method), ` ${path}`);
    name.title = `${method} ${path}`;
    row.append(name);
    const chip = statusChip(info.status);
    if (chip) row.append(chip);
    // The pill's number, rounded the pill's way: the two never disagree.
    row.append(element("span", "card-time", pillMs(info.totalMs ?? (trace?.duration ?? 0) / 1000)));
    return row;
  }

  /** The bar of where the time went, and in words only the biggest part. */
  function timing(trace: Trace): HTMLElement[] {
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
      piece.title = `${CATEGORY_LABELS[category as Category]} ${ms(value)}`;
      bar.append(piece);
    }
    const [top] = [...parts].sort((a, b) => b[1] - a[1]);
    if (!top) return [bar];
    const [category, value] = top;
    const label = `Most time: ${CATEGORY_LABELS[category as Category]}`;
    bar.setAttribute("aria-label", `${label}, ${ms(value)}`);
    const line = element("p", "card-most");
    line.dataset["category"] = category;
    line.append(
      element("i"),
      `${label} `,
      element("b", undefined, ms(value)),
      ` · ${Math.round((value / total) * 100)}%`,
    );
    return [bar, line];
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
    if (issues.length > FINDINGS)
      section.append(element("p", "card-more", `+${issues.length - FINDINGS} more in the panel`));
    return section;
  }

  function otherRequests(later: readonly TraceInfo[]): HTMLElement | null {
    const page = source.page();
    if (later.length === 0) return null;
    const failed = later.filter((info) => (info.status ?? 200) >= 500).length;
    // Only the ones worth a look get a row: failed, with issues, or slow. The rest are a count.
    const worth = worstFirst(later).filter(
      (info) => (info.status ?? 200) >= 500 || Boolean(info.issues) || (info.totalMs ?? 0) >= SLOW_MS,
    );
    const section = element("section", "card-section");
    // The page's other requests (the page itself, its other AJAX calls): the pill's "N req".
    const count = `Other requests on this page · ${later.length}`;
    section.append(
      element(
        "p",
        "card-caption",
        failed ? `${count} · ${failed} failed` : worth.length ? count : `${count} · all fine`,
      ),
    );
    for (const info of worth.slice(0, LATER)) {
      const row = element("button", "card-row");
      row.type = "button";
      const { method, path } = requestName(info);
      const chip = statusChip(info.status) ?? element("span");
      const name = element("span", "card-path", `${method} ${path}`);
      if (info === page) name.append(element("span", "card-tag", "page"));
      row.append(chip, name, element("span", "card-ms", pillMs(info.totalMs ?? 0)));
      row.title = `${method} ${path}\nClick to open it in the panel`;
      const trace = info.trace;
      if (trace) {
        row.addEventListener("click", () => {
          hide(true);
          source.open(`#/t/${trace}`);
        });
      }
      section.append(row);
    }
    if (worth.length > LATER) section.append(element("p", "card-more", `+${worth.length - LATER} more in the panel`));
    return section;
  }

  function render(info: TraceInfo, later: readonly TraceInfo[], trace: Trace | null, loading: boolean): void {
    card.textContent = "";
    card.append(head(info, trace));
    if (trace) card.append(...timing(trace));
    else if (loading) card.append(element("div", "card-skeleton"), element("div", "card-skeleton"));
    const fixes = trace ? findings(info, trace) : null;
    if (fixes) card.append(fixes);
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
