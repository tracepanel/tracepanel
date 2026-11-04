// The panel's way back (NAVIGATION.md, rule 5). It lives in the app's page, in an iframe whose address the page's
// history never sees: a linked trace opened in it pushes the view on screen (its trace, tab, row, rows folded, the
// part of its time picked, its scroll) onto a stack of its own, and Back or Esc pops it, exactly as it was. Kept for
// the browser tab's session: the panel reloads (a user switched), the stack is still there.

import type { TabId, TraceAt, ViewMemory } from "@tracepanel/ui";
import { readJson, writeItem } from "@tracepanel/ui/lib/storage";
import { useSyncExternalStore } from "react";
import { go, type Route } from "./routes";

type TraceRoute = Extract<Route, { name: "trace" }>;

/** The view on screen, as Back puts it back. */
export interface PanelView {
  route: TraceRoute;
  /** The tab on screen: the route names one only where a link asked for it. */
  tab: TabId | undefined;
  memory: ViewMemory;
  /** The part of the time picked, as the address says it (`part`, `range`, `logs`). */
  slice: Readonly<Record<string, string>>;
  /** How far the trace was scrolled. */
  scroll: number;
}

/** A linked trace opened from a view: the way back to that view. */
interface Step {
  from: PanelView;
  /** The linked trace opened: the way back holds while it is on screen. */
  to: string;
}

const KEY = "tracepanel:panel-back";
/** How deep a chain of linked traces the stack keeps: the oldest steps go first. */
const DEPTH = 20;

function load(): Step[] {
  const saved = readJson(KEY, "sessionStorage");
  return Array.isArray(saved) ? (saved as Step[]).filter((step) => step?.from?.route?.id && step.to) : [];
}

let steps: Step[] = load();
const listeners = new Set<() => void>();

function save(next: Step[]): void {
  steps = next.slice(-DEPTH);
  writeItem(KEY, JSON.stringify(steps), "sessionStorage");
  for (const listener of listeners) listener();
}

/** The view on screen, as the panel reads it when a linked trace opens. */
let current: () => PanelView | null = () => null;

export function setCurrentView(read: () => PanelView | null): void {
  current = read;
}

/** The view Back is putting back: the trace's view opens with it, the panel scrolls to where it was. */
let restoring: PanelView | null = null;

export function restoringFor(id: string | null): PanelView | null {
  return restoring && restoring.route.id === id ? restoring : null;
}

/** Opens a linked trace in the panel, where the link lands (`at`), with the way back to the view on screen. */
export function openLinked(id: string, at: TraceAt | undefined): void {
  const from = current();
  restoring = null;
  if (from) save([...steps, { from, to: id }]);
  go({ name: "trace", id, tab: at?.tab, span: at?.span, at: at?.stretch });
}

/** Where Back goes: the view the trace on screen was opened from, when it was. */
function backStep(id: string | null): PanelView | null {
  const top = steps.at(-1);
  return top && top.to === id ? top.from : null;
}

/** Back to the view the trace on screen was opened from, as it was. False when there is none. */
export function goBackInPanel(id: string | null): boolean {
  const view = backStep(id);
  if (!view) return false;
  restoring = view;
  save(steps.slice(0, -1));
  go({ ...view.route, tab: view.tab, ...view.slice, span: view.memory["span"], at: view.memory["at"] });
  return true;
}

/** The trace on screen came another way (the list, Follow new, a search): the way back is gone. */
export function forgetUnless(id: string | null): void {
  if (restoring && restoring.route.id !== id) restoring = null;
  const top = steps.at(-1);
  if (top && top.to !== id) save([]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where Back goes from the trace on screen, followed as the stack changes. */
export function useBackStep(id: string | null): PanelView | null {
  const top = useSyncExternalStore(subscribe, () => steps.at(-1));
  return top && top.to === id ? top.from : null;
}
