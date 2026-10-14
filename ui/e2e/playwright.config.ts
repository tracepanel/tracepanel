// The console in a browser against a real agent: the one this checkout builds (target/debug, or
// TRACEPANEL_AGENT_BIN), with the UI it embeds (ui-dist/), a store of its own, and traces as the SDKs send them
// (seed.ts). Build the agent first: `cargo build`.
import { defineConfig, devices } from "@playwright/test";
import { AGENT, CONSOLE, PORT, STORE } from "./agent.ts";

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./seed.ts",
  use: {
    // biome-ignore lint/style/useNamingConvention: Playwright's option name.
    baseURL: CONSOLE,
    trace: "retain-on-failure",
    // The lists and charts move on their own clock: the tests read them still.
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // A fresh store each run: the seed is all it holds.
    command: `rm -rf "${STORE}" && "${AGENT}" --dir "${STORE}" --serve 127.0.0.1:${PORT}`,
    url: `${CONSOLE}api/counts`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
