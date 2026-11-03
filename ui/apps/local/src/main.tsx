import "./index.css";
import { readSnapshot } from "@tracepanel/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SnapshotApp } from "./SnapshotApp";
import { defaultTheme, watchTheme } from "./theme";

// Inside the widget the panel is the glass surface; the app itself stays transparent.
if (window.parent !== window) {
  document.documentElement.dataset["embedded"] = "";
  // The widget says when it closes the panel and opens it again: out of sight, nothing in it moves (app.css).
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (event.source !== window.parent || typeof data !== "object" || data === null) return;
    if ("type" in data && data.type === "tracepanel:shown" && "shown" in data) {
      document.documentElement.toggleAttribute("data-hidden", data.shown !== true);
    }
  });
}

// A snapshot file carries its data: the console reads it instead of an API.
const snapshot = readSnapshot();

// A snapshot is opened by someone else, anywhere: unless they chose one, the theme their OS has.
if (snapshot) defaultTheme("system");
watchTheme();

const container = document.getElementById("root");
if (!container) throw new Error("tracepanel UI: missing #root");

createRoot(container).render(<StrictMode>{snapshot ? <SnapshotApp snapshot={snapshot} /> : <App />}</StrictMode>);
