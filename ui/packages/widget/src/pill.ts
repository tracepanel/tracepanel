import { duration } from "@tracepanel/ui/format";
import { chainScope } from "@tracepanel/ui/lib/chainCounts";
import { clockOf, cutNote, NO_ANSWER, PENDING, runningLabel, runningTime } from "@tracepanel/ui/lib/live";
import { plural } from "@tracepanel/ui/lib/plural";
import { nameWithMethod } from "./card";
import type { TraceInfo } from "./index";
import type { Flight } from "./network";

/** The request as people know it: the GraphQL operation, else the method and the actual path. */
export function title(info: TraceInfo): string {
  if (info.name) return info.name;
  const path = info.url ? new URL(info.url, location.href).pathname : location.pathname;
  return `${info.method ?? "GET"} ${path}`;
}

/** " · 5 failed, 2 issues in its tasks", or nothing when its tasks all went well. */
export function tasksPart(info: TraceInfo): string {
  const parts = [
    info.taskFailed ? `${info.taskFailed} failed` : "",
    info.taskIssues ? plural(info.taskIssues, "issue", "issues") : "",
  ].filter(Boolean);
  return parts.length ? ` · ${parts.join(", ")} in its tasks` : "";
}

function line(info: TraceInfo, counted: Counted): string {
  const issues = counted.issues ? ` · ${counted.issues} issue${counted.issues === 1 ? "" : "s"}` : "";
  const queries = counted.queries === null ? "queries not known yet" : `${counted.queries} q`;
  return `${title(info)} → ${info.status ?? "?"} · ${duration((info.totalMs ?? 0) * 1000)} · ${queries}${issues}${tasksPart(info)}`;
}

/** Its own findings, or its tasks': either wants a look. */
function wantsLook(info: TraceInfo): boolean {
  return Boolean(info.issues || info.taskIssues);
}

/** A finding in its tasks wants a look too: the ring is amber, the request's own count stays its own. */
function state(info: TraceInfo): "ok" | "warn" | "error" {
  if (broke(info)) return "error";
  return wantsLook(info) ? "warn" : "ok";
}

/** It failed, or one of its tasks did. */
function broke(info: TraceInfo): boolean {
  return (info.status ?? 200) >= 500 || Boolean(info.taskFailed);
}

const SEVERITY = { ok: 0, warn: 1, error: 2 } as const;

const ICONS = {
  db: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  // The sidebar's Tasks icon (lucide list-checks).
  tasks:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 5h8M13 12h8M13 19h8M3 17l2 2 4-4M3 7l2 2 4-4"/></svg>',
  layers:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>',
  failed:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v4M12 17.5h.01"/></svg>',
  // The panel's HTTP calls tab's (lucide arrow-up-right).
  calls:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>',
  // Something with no answer yet (lucide hourglass), as the panel's.
  hourglass:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>',
  // The corner its task runs hang from in the panel's list.
  below:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>',
} as const;

export function segment(parent: HTMLElement): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "seg";
  parent.append(span);
  return span;
}

function addStatus(parent: HTMLElement, status: number | null | undefined): void {
  if (status === null || status === undefined) return;
  const chip = document.createElement("span");
  chip.className = "status";
  chip.textContent = String(status);
  if (status >= 500) chip.dataset["tone"] = "server";
  else if (status >= 400) chip.dataset["tone"] = "client";
  else if (status >= 300) chip.dataset["tone"] = "redirect";
  segment(parent).append(chip);
}

/**
 * Time, colored by how it feels in development: under 300 ms fine, under 1 s slow, beyond very slow. A time where a
 * trace was cut (`cut`) isn't how slow it was: never colored.
 */
export function addTime(parent: HTMLElement, ms: number, cut = false): void {
  const seg = segment(parent);
  const speed = cut ? undefined : speedOf(ms);
  if (speed) seg.dataset["speed"] = speed;
  seg.innerHTML = ICONS.clock;
  seg.append(...timeParts(ms));
}

/** As on the panel's list: under 300 ms fine, under a second slow, beyond very slow. */
function speedOf(ms: number): "slow" | "very-slow" | undefined {
  if (ms >= 1000) return "very-slow";
  return ms >= 300 ? "slow" : undefined;
}

/** A time as the panel's list and the card say it ("0.5 ms", "88 ms", "1.2 s"): its number bold, its unit after. */
function timeParts(ms: number): HTMLElement[] {
  const [number = "", word = ""] = duration(ms * 1000).split(" ");
  const value = document.createElement("b");
  value.textContent = number;
  const unit = document.createElement("span");
  unit.className = "unit";
  unit.textContent = word;
  return [value, unit];
}

/**
 * A running thing's time so far (from `start`, epoch ms) as the pill writes a time: PENDING on its first frame;
 * stopped at `until` (epoch µs: lib/live clockOf).
 */
function runningParts(start: number, until: number | undefined): HTMLElement[] {
  const now = clockOf(until);
  const time = runningTime(start * 1000, now);
  if (time !== PENDING) return timeParts(Math.max(0, now - start));
  const value = document.createElement("b");
  value.textContent = PENDING;
  return [value];
}

/** In flight: the ring and the time so far (from `start`, epoch ms), ticking as the pill draws again, up to `until`. */
export function addRunning(parent: HTMLElement, start: number, until?: number): void {
  const seg = segment(parent);
  seg.dataset["state"] = "running";
  const ring = document.createElement("span");
  ring.className = "running";
  ring.setAttribute("aria-hidden", "true");
  seg.append(ring, ...runningParts(start, until));
  seg.title = runningLabel(start * 1000, clockOf(until));
}

/** Cut with a call unanswered: the hourglass and "no answer yet", its note in the tooltip. */
export function addNoAnswer(parent: HTMLElement, at: number | null): void {
  const seg = segment(parent);
  seg.append(noAnswer(at));
}

/** The hourglass and "no answer yet": the pill's and the card's. */
export function noAnswer(at: number | null): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "no-answer";
  mark.dataset["state"] = "cut";
  mark.innerHTML = ICONS.hourglass;
  mark.append(NO_ANSWER);
  mark.title = cutNote(at);
  return mark;
}

/** Its queries, "…" while they aren't known (its chain not counted yet). */
export function addQueries(parent: HTMLElement, queries: number | null): void {
  const seg = segment(parent);
  seg.innerHTML = ICONS.db;
  const value = document.createElement("b");
  if (queries === null) {
    value.className = "pending";
    value.textContent = PENDING;
    seg.append(value);
    seg.title = "SQL queries: not known yet";
    return;
  }
  value.textContent = String(queries);
  seg.append(value);
  seg.title = `${queries} SQL ${queries === 1 ? "query" : "queries"}`;
}

/** A view's calls down its chain: the panel's HTTP calls tab's count, under its icon; its own among them in its title. */
export function addCalls(parent: HTMLElement, calls: number, own: number): void {
  const seg = segment(parent);
  seg.innerHTML = ICONS.calls;
  const value = document.createElement("b");
  value.textContent = String(calls);
  seg.append(value);
  seg.title = chainScope("http", calls, own, "this view");
}

export function addIssues(parent: HTMLElement, issues: number, tone: "warn" | "error"): void {
  const pill = document.createElement("span");
  pill.className = "issues";
  pill.dataset["tone"] = tone;
  pill.innerHTML = ICONS.alert;
  pill.append(`${issues} ${issues === 1 ? "issue" : "issues"}`);
  segment(parent).append(pill);
}

/**
 * What its tasks ran into, apart from its own: the Tasks icon, as each segment has its own, then the chips its own
 * failures and issues have, red ones first. The tooltip says whose they are.
 */
function addTaskIssues(parent: HTMLElement, info: TraceInfo): void {
  const chips = [
    info.taskFailed ? chip("failed", ICONS.failed, `${info.taskFailed} failed`) : null,
    info.taskIssues ? chip("issues", ICONS.alert, plural(info.taskIssues, "issue", "issues")) : null,
  ].filter((item) => item !== null);
  if (!chips.length) return;
  const seg = segment(parent);
  seg.className = "seg tasks";
  seg.innerHTML = ICONS.tasks;
  seg.append(...chips);
  seg.title = `${tasksPart(info).slice(3)}, the ones this request enqueued: open the panel to see them`;
}

function chip(className: string, icon: string, text: string): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  element.innerHTML = icon;
  element.append(text);
  return element;
}

/**
 * The rest of the page, after the latest request's numbers: how many requests it made (`count`, as the panel's list
 * has them: traced, untraced and in flight), in the same neutral style as the other numbers, and how many of the
 * others failed in red, as their own chip, so "16" never reads as 16 failures. No tooltip: the hover card lists them.
 */
export function addPage(parent: HTMLElement, all: readonly TraceInfo[], count: number): void {
  const failed = othersFailed(all);
  const more = isFailure(all.at(-1));
  const seg = segment(parent);
  seg.className = "seg page";
  seg.innerHTML = ICONS.layers;
  const value = document.createElement("b");
  value.textContent = String(count);
  const unit = document.createElement("span");
  unit.className = "unit";
  unit.textContent = "requests";
  seg.append(value, unit);
  if (failed) {
    const chip = document.createElement("span");
    chip.className = "failed";
    chip.innerHTML = ICONS.failed;
    // Next to a red status: "1 more failed", so it isn't read as that one again.
    chip.append(more ? `${failed} more failed` : `${failed} failed`);
    seg.append(chip);
  }
}

function isFailure(info: TraceInfo | undefined): boolean {
  return (info?.status ?? 200) >= 500;
}

/** The shown (latest) request's failure is already its status: the page count names the others' failures. */
function othersFailed(all: readonly TraceInfo[]): number {
  return all.slice(0, -1).filter(isFailure).length;
}

/** "5 requests on this page, 1 other one failed", or nothing for a page alone. */
function pageLine(all: readonly TraceInfo[], count: number, flights: number): string[] {
  if (count < 2) return [];
  const failed = othersFailed(all);
  return [
    `${count} requests on this page${flights ? `, ${flights} in flight` : ""}${failed ? `, ${plural(failed, "other one", "other ones")} failed` : ""}`,
  ];
}

/** The pill read aloud: the shown request (one in flight first), the page's count, the runtime. */
export function pillLabel(
  all: readonly TraceInfo[],
  flights: readonly Flight[],
  count: number,
  runtime: string | undefined,
  counted: (info: TraceInfo) => Counted,
): string {
  const flight = flights.at(-1);
  const shown = all.at(-1) ?? {};
  const head = flight
    ? `${title(flightInfo(flight))}, ${runningLabel(flight.start * 1000)}`
    : line(shown, counted(shown));
  const summary = [head, ...pageLine(all, count, flights.length), ...(runtime ? [`Served by ${runtime}`] : [])];
  return `tracepanel: ${summary.join(". ")}`;
}

/** The worst state of the page's requests: an error, else a finding, else ok. */
export function verdict(all: readonly TraceInfo[], counted: (info: TraceInfo) => Counted): "ok" | "warn" | "error" {
  return all
    .map((info) => state({ ...info, issues: counted(info).issues }))
    .reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "ok");
}

/**
 * A request's numbers as the pill says them, the panel's list's: its whole chain's once counted (a BFF's request ran no
 * query itself, the services it called did), its own where it called no app; queries null while not known yet.
 */
export interface Counted {
  queries: number | null;
  issues: number;
}

/** One request's segments: its name, status, time, queries and findings. */
export function addRequest(parent: HTMLElement, shown: TraceInfo, pulse: boolean, counted: Counted): void {
  addName(parent, shown, pulse);
  addStatus(parent, shown.status);
  addTime(parent, shown.totalMs ?? 0);
  addQueries(parent, counted.queries);
  // Findings are amber whatever else happened: a failure says so in its status, and in the page's count.
  if (counted.issues) addIssues(parent, counted.issues, "warn");
  addTaskIssues(parent, shown);
}

/** A request still in flight: its name, the ring and its time so far; no status, its numbers pending. */
export function addFlight(parent: HTMLElement, flight: Flight): void {
  addName(parent, flightInfo(flight), false);
  addRunning(parent, flight.start);
  addQueries(parent, null);
}

/** A request in flight as a request is named: its GraphQL operation, else its method and path. */
export function flightInfo(flight: Flight): TraceInfo {
  return { name: flight.name, method: flight.method, url: flight.url };
}

export function addName(parent: HTMLElement, info: TraceInfo, pulse: boolean): void {
  const name = document.createElement("span");
  name.className = "name";
  // A request's method in its badge, as in the console's lists; a GraphQL operation by its name.
  name.append(...nameWithMethod(title(info)));
  name.title = title(info);
  if (pulse) name.dataset["pulse"] = "";
  segment(parent).append(name);
}
