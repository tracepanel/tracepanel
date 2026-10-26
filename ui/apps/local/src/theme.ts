import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "tracepanel:theme";
const DARK = "(prefers-color-scheme: dark)";

function read(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "system" ? value : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Sets html[data-theme] from the stored choice (dark when there is none), or from the OS when the choice is "system".
 * index.html's first script does the same before the first paint.
 */
export function applyTheme(choice: ThemeChoice = read()): void {
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
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private mode: the choice lasts until reload.
    }
    setChoice(next);
  };
  return [choice, set];
}
