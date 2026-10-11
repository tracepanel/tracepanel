import { isTyping } from "@tracepanel/ui";
import { useEffect } from "react";

// The rows a list opens: table rows that are links, and the issue lists' anchors.
const ROWS = '[data-scroll] tr[role="link"], [data-scroll] a.dt-request-row';

/** j and k move along the list's rows, as in mail and code review tools; Enter opens the one focused. */
export function useRowKeys(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== "j" && event.key !== "k") || isTyping(event)) return;
      const rows = [...document.querySelectorAll<HTMLElement>(ROWS)];
      if (rows.length === 0) return;
      event.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? 0 : Math.min(Math.max(at + (event.key === "j" ? 1 : -1), 0), rows.length - 1);
      rows[next]?.focus();
      rows[next]?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Esc goes back where the page was opened from, unless something open on it (a menu, a dialog) takes it first. */
export function useEscapeTo(target: string | undefined, go: (target: string) => void): void {
  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isTyping(event)) return;
      go(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, go]);
}
