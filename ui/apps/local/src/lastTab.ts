// The tab last picked in a trace, kept in this browser: a trace opened fresh (from a list, Follow new, a search)
// opens on it when it has it, in the panel and in the console alike (NAVIGATION.md, rule 3).
import type { TabId } from "@tracepanel/ui";

// The panel's key from before the console shared it: a choice made then is still the one.
const KEY = "tracepanel:panel-tab";

/**
 * The tabs worth opening every trace on. Not App (about the app, not the trace), Profile (recorded only when asked
 * for) or Error (a failed trace opens on it anyway).
 */
const REMEMBERED = new Set<TabId>(["request", "tree", "issues", "sql", "cache", "http", "logs"]);

export function readLastTab(): TabId | undefined {
  try {
    const value = localStorage.getItem(KEY);
    return value && REMEMBERED.has(value as TabId) ? (value as TabId) : undefined;
  } catch {
    return undefined;
  }
}

/** A tab picked in a trace's tab bar: the one the next trace opens on. */
export function writeLastTab(tab: TabId): void {
  if (!REMEMBERED.has(tab)) return;
  try {
    localStorage.setItem(KEY, tab);
  } catch {
    // Storage can be blocked; the choice then lasts for this page only.
  }
}
