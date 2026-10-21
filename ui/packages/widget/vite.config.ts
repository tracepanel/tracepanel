import { copyFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { tokens } from "./tokens";

/** Under `pnpm watch`, each new widget.min.js goes straight into the agent's ui-dist/ too. */
function toAgent(out: string | undefined): Plugin {
  return {
    name: "tracepanel-widget-to-agent",
    closeBundle() {
      if (out) copyFileSync("dist/widget.min.js", `${out}/widget.min.js`);
    },
  };
}

// widget.min.js (IIFE, with its source map) for <script> from the SDKs and the agent; widget.mjs for apps that bundle it.
export default defineConfig({
  plugins: [tokens(), toAgent(process.env.TRACEPANEL_UI_OUT)],
  build: {
    // Maps next to the files, without a sourceMappingURL in them: the agent embeds the minified files only.
    sourcemap: "hidden",
    lib: {
      entry: "src/index.ts",
      name: "tracepanel",
      formats: ["iife", "es"],
      fileName: (format) => (format === "es" ? "widget.mjs" : "widget.min.js"),
    },
  },
});
