import { useEffect, useRef } from "react";

/**
 * After "Show N queries" on an issue, the first highlighted row is scrolled to: the group may be last in a long list,
 * open below the fold. The list marks its highlighted rows with `data-focused`.
 */
export function useScrollToFocus<T extends HTMLElement>(focus: ReadonlySet<string> | undefined) {
  const list = useRef<T>(null);
  useEffect(() => {
    if (!focus || focus.size === 0) return;
    list.current?.querySelector("[data-focused]")?.scrollIntoView({ block: "start" });
  }, [focus]);
  return list;
}

/** Marks a highlighted row for useScrollToFocus. */
export function focusMark(focused: boolean): { "data-focused"?: "" } {
  return focused ? { "data-focused": "" } : {};
}
