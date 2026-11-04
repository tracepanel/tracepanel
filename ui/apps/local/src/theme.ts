import { readItem, writeItem } from "@tracepanel/ui/lib/storage";
import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "tracepanel:theme";
const DARK = "(prefers-color-scheme: dark)";

/** The theme with no choice stored: the console's dark; a snapshot file follows the OS of whoever opens it. */
let fallback: ThemeChoice = "dark";

/** What the theme is with no choice stored (a snapshot: "system"). Set before the first applyTheme. */
export function defaultTheme(choice: ThemeChoice): void {
  fallback = choice;
}

function read(): ThemeChoice {
  const value = readItem(KEY);
  return value === "light" || value === "system" || value === "dark" ? value : fallback;
}

/**
 * Sets html[data-theme] from the stored choice (dark when there is none), or from the OS when the choice is "system".
 * index.html's first script does the same before the first paint.
 */
function applyTheme(choice: ThemeChoice = read()): void {
  const dark = choice === "dark" || (choice === "system" && window.matchMedia(DARK).matches);
  document.documentElement.dataset["theme"] = dark ? "dark" : "light";
  if (window.parent !== window) {
    // The panel's page may be on another origin (the console's own port): its storage is not the badge's, so the
    // widget is told.
    window.parent.postMessage({ type: "tracepanel:theme", theme: choice }, "*");
  }
}

/** Keeps the theme in sync with the OS and with other tracepanel tabs (the panel follows the console). */
export function watchTheme(): void {
  applyTheme();
  window.matchMedia(DARK).addEventListener("change", () => applyTheme());
  window.addEventListener("storage", (event) => event.key === KEY && applyTheme());
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState(read);
  useEffect(() => applyTheme(choice), [choice]);
  const set = (next: ThemeChoice) => {
    writeItem(KEY, next);
    setChoice(next);
  };
  return [choice, set];
}
