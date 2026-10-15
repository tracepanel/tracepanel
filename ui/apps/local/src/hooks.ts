import type { Capabilities, DataSource } from "@tracepanel/ui";
import { useEffect, useState } from "react";

export interface EntrySummary {
  name: string;
  status: number | null;
  start: number;
  duration: number;
  queries: number;
  issues: number;
  /** Which findings, once the widget has asked the agent: the row names them before its trace loads. */
  kinds?: string[] | undefined;
  /** Sent by htmx: the element that sent it, where the answer went, whether it loaded a page. */
  htmx?: { trigger?: string | undefined; target?: string | undefined; boosted?: boolean | undefined } | undefined;
  /** A view or an action recorded in the browser (tracepanel-js), not a request: its requests come under it. */
  kind?: "page" | undefined;
  failed?: boolean | undefined;
}

export interface TabEntry {
  id: string;
  parent: string | null;
  summary?: EntrySummary | undefined;
}

function isSummary(value: unknown): value is EntrySummary {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    "duration" in value &&
    typeof value.duration === "number" &&
    "queries" in value &&
    typeof value.queries === "number" &&
    "issues" in value &&
    typeof value.issues === "number" &&
    "status" in value &&
    (value.status === null || typeof value.status === "number")
  );
}

export interface TabHistory {
  entries: readonly TabEntry[];
  /** Trace of the page currently open in the tab. */
  current: string | null;
  /** What served the page ("Python 3.12 · Django 6.0"), as its script tag says. */
  runtime: string | null;
}

function isEntry(value: unknown): value is TabEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "parent" in value &&
    (value.parent === null || typeof value.parent === "string") &&
    (!("summary" in value) || value.summary === undefined || isSummary(value.summary))
  );
}

/** Requests made in the browser tab hosting the widget, sent by widget.min.js via postMessage. */
export function useTabHistory(): TabHistory | null {
  const [history, setHistory] = useState<TabHistory | null>(null);
  useEffect(() => {
    if (window.parent === window) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "tracepanel:tab") return;
      const entries = "entries" in data && Array.isArray(data.entries) ? data.entries.filter(isEntry) : [];
      const current = "current" in data && typeof data.current === "string" ? data.current : null;
      const runtime = "runtime" in data && typeof data.runtime === "string" ? data.runtime : null;
      setHistory({ entries, current, runtime });
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "tracepanel:ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return history;
}

/**
 * Calls `load` now and every `intervalMs` while the page is visible; returns the latest result.
 * Pass a `useCallback`-stable `load`: a new function restarts polling.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs = 2000): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let cancelled = false;
    const fetchNow = () => {
      load().then(
        (result) => {
          if (!cancelled) setValue(result);
        },
        () => undefined,
      );
    };
    // Always load once; background tabs skip the periodic refresh and catch up when shown again.
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchNow();
    };
    fetchNow();
    const timer = window.setInterval(onVisible, intervalMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, intervalMs]);
  return value;
}

const CAPABILITIES = new WeakMap<DataSource, Promise<Capabilities>>();

/** Whether the console's backend runs EXPLAIN or switches users: asked once per source; no until it answers. */
export function useCapability(source: DataSource, name: keyof Capabilities): boolean {
  return useCapabilities(source)?.[name] === true;
}

function useCapabilities(source: DataSource): Capabilities | undefined {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  useEffect(() => {
    let asked = CAPABILITIES.get(source);
    if (!asked) {
      asked = source.capabilities().catch(() => ({ explain: false, users: false }));
      CAPABILITIES.set(source, asked);
    }
    let current = true;
    asked.then((answer) => current && setCapabilities(answer));
    return () => {
      current = false;
    };
  }, [source]);
  return capabilities;
}
