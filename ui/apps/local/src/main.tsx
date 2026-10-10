import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { watchTheme } from "./theme";

// Inside the widget the panel is the glass surface; the app itself stays transparent.
if (window.parent !== window) document.documentElement.dataset["embedded"] = "";

watchTheme();

const container = document.getElementById("root");
if (!container) throw new Error("tracepanel UI: missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
