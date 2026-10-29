// The agent the tests run against: this checkout's build, on a port of its own, a store of its own (.store/).
import { fileURLToPath } from "node:url";

export const AGENT =
  process.env["TRACEPANEL_AGENT_BIN"] ?? fileURLToPath(new URL("../../target/debug/tracepanel-agent", import.meta.url));
export const PORT = Number(process.env["E2E_PORT"] ?? 8790);
export const CONSOLE = `http://127.0.0.1:${PORT}/`;
export const STORE = fileURLToPath(new URL("./.store", import.meta.url));
/** The environment variable the seed sets to when the run started, for every worker (chain.ts). */
export const RUN_STARTED = "E2E_RUN_STARTED";
