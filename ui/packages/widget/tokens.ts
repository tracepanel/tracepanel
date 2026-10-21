// The widget's palette, from the design tokens: the --dt-* tokens its styles name, copied at build time from
// @tracepanel/ui's styles.css (dark on :root, light on :root[data-theme="light"]) onto its Shadow DOM's :host. A
// token changed there changes the console, the panel and the widget alike; the widget keeps no colour of its own.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

const MODULE = "virtual:tracepanel-tokens";
const RESOLVED = `\0${MODULE}`;
const TOKEN = /--dt-[a-z0-9-]+/g;
/** styles.css' theme blocks, and where each goes in the widget's shadow root. */
const BLOCKS = new Map([
  [":root", ":host"],
  [':root[data-theme="light"]', ':host([data-theme="light"])'],
]);

/** A token's declaration in a theme block: its name and its value, which may run over several lines. */
const DECLARATION = /(--dt-[a-z0-9-]+)\s*:\s*([^;]+);/g;

/** A theme block's --dt-* declarations, by name, from styles.css without its comments. */
function declarations(css: string, selector: string): Map<string, string> {
  const head = `\n${selector} {`;
  const start = css.indexOf(head);
  if (start < 0) throw new Error(`styles.css has no ${selector} block`);
  const body = css.slice(start + head.length, css.indexOf("}", start));
  return new Map(
    [...body.matchAll(DECLARATION)].map(([, name, value]) => [String(name), String(value).replace(/\s+/g, " ").trim()]),
  );
}

/** A token's value in the dark (default) block: every token is declared there. */
function definition(name: string, dark: Map<string, string>): string {
  const value = dark.get(name);
  if (value === undefined) throw new Error(`the widget names ${name}, which styles.css doesn't define`);
  return value;
}

/** The tokens `names` need: those, and the tokens their values name in turn. */
function closure(names: Iterable<string>, dark: Map<string, string>, need = new Set<string>()): Set<string> {
  for (const name of names) {
    if (need.has(name)) continue;
    need.add(name);
    closure(definition(name, dark).match(TOKEN) ?? [], dark, need);
  }
  return need;
}

/** The token sheet: each theme block's tokens that `names` need, on the widget's :host. */
function tokenSheet(css: string, names: Iterable<string>): string {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...BLOCKS].map(([selector, host]) => [host, declarations(plain, selector)] as const);
  const need = closure(names, blocks[0]?.[1] ?? new Map());
  return blocks
    .map(([host, tokens]) => {
      const lines = [...tokens].filter(([name]) => need.has(name)).map(([name, value]) => `${name}: ${value};`);
      return `${host} { ${lines.join(" ")} }`;
    })
    .join("\n");
}

/** The --dt-* tokens the widget's sources name. */
function named(dir: string): Set<string> {
  const sources = readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => readFileSync(`${dir}/${file}`, "utf8"));
  return new Set(sources.join("\n").match(TOKEN));
}

/** `import TOKENS from "virtual:tracepanel-tokens"`: the token sheet, as CSS text. */
export function tokens(): Plugin {
  const styles = createRequire(import.meta.url).resolve("@tracepanel/ui/styles.css");
  const src = new URL("./src", import.meta.url).pathname;
  return {
    name: "tracepanel-tokens",
    resolveId: (id) => (id === MODULE ? RESOLVED : null),
    load(id) {
      if (id !== RESOLVED) return null;
      this.addWatchFile(styles);
      return `export default ${JSON.stringify(tokenSheet(readFileSync(styles, "utf8"), named(src)))};`;
    },
  };
}
