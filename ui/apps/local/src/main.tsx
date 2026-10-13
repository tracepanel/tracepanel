import "./index.css";
import { readSnapshot } from "@tracepanel/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SnapshotApp } from "./SnapshotApp";
import { watchTheme } from "./theme";

// Inside the widget the panel is the glass surface; the app itself stays transparent.
if (window.parent !== window) document.documentElement.dataset["embedded"] = "";

watchTheme();

const container = document.getElementById("root");
if (!container) throw new Error("tracepanel UI: missing #root");

// A snapshot file carries its data: the console reads it instead of an API.
const snapshot = readSnapshot();

createRoot(container).render(<StrictMode>{snapshot ? <SnapshotApp snapshot={snapshot} /> : <App />}</StrictMode>);
