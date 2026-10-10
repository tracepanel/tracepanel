import { defineConfig } from "vite";

// widget.min.js (IIFE, with its source map) for <script> from the SDKs and the agent; widget.mjs for apps that bundle it.
export default defineConfig({
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
