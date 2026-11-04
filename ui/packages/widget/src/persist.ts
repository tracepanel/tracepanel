import { readItem, readJson, writeItem } from "@tracepanel/ui/lib/storage";
import type { TabEntry } from "@tracepanel/ui/lib/tabEntry";

const PANEL_KEY = "tracepanel:panel";

/** Where the panel sits, like browser devtools: along the bottom (the default) or along the right edge. */
export type Dock = "right" | "bottom";

export interface PanelState {
  open: boolean;
  dock: Dock;
  /** Width in px chosen by dragging the panel edge (docked right). */
  width?: number | undefined;
  /** Height in px chosen by dragging the panel edge (docked at the bottom). */
  height?: number | undefined;
}

export const DEFAULT_WIDTH = 600;

export const MIN_WIDTH = 360;

export const DEFAULT_HEIGHT = 360;

export const MIN_HEIGHT = 200;

/** Panel state survives navigations within the browser tab. */
export function loadPanel(): PanelState {
  const parsed = readJson(PANEL_KEY, "sessionStorage");
  if (typeof parsed !== "object" || parsed === null) return { open: false, dock: "bottom" };
  return {
    open: "open" in parsed && parsed.open === true,
    dock: "dock" in parsed && parsed.dock === "right" ? "right" : "bottom",
    width: "width" in parsed && typeof parsed.width === "number" ? parsed.width : undefined,
    height: "height" in parsed && typeof parsed.height === "number" ? parsed.height : undefined,
  };
}

export function savePanel(state: PanelState): void {
  writeItem(PANEL_KEY, JSON.stringify(state), "sessionStorage");
}

/** How long a just-finished fetch/XHR stays on the badge. */

const TAB_KEY = "tracepanel:tab";

const TAB_LIMIT = 200;

function isEntry(value: unknown): value is TabEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { id?: unknown; parent?: unknown };
  return typeof entry.id === "string" && (entry.parent === null || typeof entry.parent === "string");
}

const RUNTIME_KEY = "tracepanel:runtime";

/**
 * What served the page: as its server says, else what answered this tab's calls, learned from the first one's trace
 * (an SPA) and kept for the tab, so a reload shows the mark before its first request.
 */
export function learnedRuntime(given: string | undefined): string | undefined {
  return given || (readItem(RUNTIME_KEY, "sessionStorage") ?? undefined);
}

export function learnRuntime(label: string | undefined): void {
  if (label) writeItem(RUNTIME_KEY, label, "sessionStorage");
}

/** Tab history lives in sessionStorage: per browser tab, survives navigations, gone when the tab closes. */
// The requests that answered with a redirect on the way to this page (a form's POST, then 302): the app names them in
// this cookie, as the page they led to is the first this widget sees.
const REDIRECTS = "tracepanel_redirect";

/** The ids the redirect cookie names, the cookie gone once read: each request shows once. */
function takeRedirects(): string[] {
  const pair = document.cookie.split("; ").find((item) => item.startsWith(`${REDIRECTS}=`));
  if (!pair) return [];
  document.cookie = `${REDIRECTS}=; Max-Age=0; Path=/; SameSite=Lax`;
  return decodeURIComponent(pair.slice(REDIRECTS.length + 1))
    .split(",")
    .filter((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id));
}

/** The tab's requests with those that redirected to this page, in the order they came, before it. */
export function withRedirects(entries: TabEntry[]): TabEntry[] {
  const known = new Set(entries.map((entry) => entry.id));
  const added = takeRedirects().filter((id) => !known.has(id));
  if (!added.length) return entries;
  const next = [...entries, ...added.map((id) => ({ id, parent: null }))];
  saveTab(next);
  return next;
}

export function loadTab(): TabEntry[] {
  const parsed = readJson(TAB_KEY, "sessionStorage");
  return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
}

export function saveTab(entries: readonly TabEntry[]): void {
  writeItem(TAB_KEY, JSON.stringify(entries.slice(-TAB_LIMIT)), "sessionStorage");
}
