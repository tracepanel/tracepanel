import { createHash } from "node:crypto";
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const require = createRequire(import.meta.url);

/** The page loads `tracepanel.min.js?v=<hash>`: the file keeps its name, a new build is still a new URL. */
function versioned(): Plugin {
  return {
    name: "tracepanel-versioned",
    // After Vite writes index.html into the bundle.
    enforce: "post",
    generateBundle(_, bundle) {
      const page = bundle["index.html"];
      if (page?.type !== "asset") return;
      let html = String(page.source);
      for (const file of Object.values(bundle)) {
        if (file.fileName.endsWith(".map")) continue;
        const content = file.type === "chunk" ? file.code : file.source;
        const version = createHash("sha256").update(content).digest("hex").slice(0, 10);
        html = html.replaceAll(`./${file.fileName}"`, `./${file.fileName}?v=${version}"`);
      }
      page.source = html;
    },
  };
}

/** widget.min.js and its source map from @tracepanel/widget, next to the console. */
function widget(): Plugin {
  return {
    name: "tracepanel-widget",
    closeBundle() {
      const dist = require.resolve("@tracepanel/widget").replace(/widget\.mjs$/, "");
      for (const name of ["widget.min.js", "widget.min.js.map"]) copyFileSync(`${dist}${name}`, `dist/${name}`);
    },
  };
}

// dist/ is the UI bundle tracepanel-agent embeds (scripts/ui.sh there): index.html, tracepanel.min.js and .css,
// widget.min.js, the fonts in assets/; and the source maps (*.map), to read and debug the minified code.
export default defineConfig({
  // Relative asset URLs: the same build works under /__tracepanel__/ and at the agent's root.
  base: "./",
  plugins: [react(), tailwindcss(), versioned(), widget()],
  build: {
    // Maps next to the files, without a sourceMappingURL in them: the agent embeds the minified files only.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        // One file of code: no chunk with a hashed name to version.
        inlineDynamicImports: true,
        entryFileNames: "tracepanel.min.js",
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css")) ? "tracepanel.min.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
  server: { proxy: { "/api": "http://localhost:7700" } },
});
