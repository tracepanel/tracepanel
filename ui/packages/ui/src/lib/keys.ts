import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Whether a key press belongs to a field being typed in, not to the page's shortcuts. */
export function isTyping(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** As in any tree: → opens a closed row's children, ← closes an open one's; nothing for a row with none (undefined). */
export function foldKeys(open: boolean | undefined, toggle: () => void): (event: ReactKeyboardEvent) => void {
  const key = open ? "ArrowLeft" : "ArrowRight";
  return (event) => {
    if (open === undefined || event.key !== key) return;
    event.preventDefault();
    toggle();
  };
}
