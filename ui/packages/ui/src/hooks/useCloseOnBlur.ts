import { useEffect } from "react";

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
