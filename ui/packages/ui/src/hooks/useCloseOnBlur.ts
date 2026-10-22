import { useCallback, useEffect, useState } from "react";

/**
 * Closes a menu when its window loses focus. In the panel (an iframe on the app's page) a click on the page never
 * reaches the menu as a click outside; the frame losing focus is what it sees.
 */
export function useCloseOnBlur(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [open, close]);
}

/** A menu's open state, closed when its window loses focus (useCloseOnBlur). */
export function useMenuOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnBlur(open, close);
  return [open, setOpen];
}
