#!/usr/bin/env node
// Generate ui/DESIGN.md from the --dt-* tokens in packages/ui/src/styles.css.
// The front matter is derived from the token file, so the two cannot drift. The
// prose carries the rationale (it is stored here, in the generator).
// Docs on the format: https://github.com/google-labs-code/design.md
// Run from ui/: `pnpm design-md`.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const here = path.dirname(new URL(import.meta.url).pathname);
const uiRoot = path.resolve(here, "..");
const stylesPath = path.join(uiRoot, "packages", "ui", "src", "styles.css");
const outPath = path.join(uiRoot, "DESIGN.md");

const styles = fs.readFileSync(stylesPath, "utf8");

function tokensFrom(block) {
  const map = new Map();
  for (const [, name, value] of block.matchAll(/(--dt-[a-z0-9-]+):\s*([^;]+);/g)) {
    map.set(name, value.trim());
  }
  return map;
}

const rootStart = styles.indexOf(":root {");
const rootEnd = styles.indexOf("\n}", rootStart);
if (rootStart < 0 || rootEnd < 0) fail("the first :root block was not found");
const dark = tokensFrom(styles.slice(rootStart, rootEnd));

const need = [
  "--dt-bg",
  "--dt-surface",
  "--dt-chrome",
  "--dt-chrome-strong",
  "--dt-panel",
  "--dt-popover",
  "--dt-card",
  "--dt-faint",
  "--dt-field",
  "--dt-border",
  "--dt-border-strong",
  "--dt-text",
  "--dt-text-2",
  "--dt-text-3",
  "--dt-ink",
  "--dt-accent",
  "--dt-accent-strong",
  "--dt-lime",
  "--dt-ok",
  "--dt-warn",
  "--dt-error",
  "--dt-info",
  "--dt-radius",
  "--dt-radius-sm",
  "--dt-shadow",
  "--dt-popover-shadow",
  "--dt-font",
  "--dt-mono",
  "--dt-size-2xs",
  "--dt-size-xs",
  "--dt-size-sm",
  "--dt-size-base",
  "--dt-size-md",
  "--dt-size-lg",
  "--dt-size-xl",
  "--dt-size-2xl",
  "--dt-size-3xl",
  "--dt-size-4xl",
];
for (const token of need) {
  if (!dark.get(token)) fail(`styles.css no longer declares ${token}`);
}

function fontFamily(token) {
  // The stack starts with the real face: keep only the first name, unquoted.
  return dark.get(token)?.split(",")[0]?.trim().replace(/["']/g, "") ?? "";
}

const yaml = [
  "---",
  `name: Tracepanel`,
  "omitted: [spacing, components]",
  "colors:",
  `  background: "${dark.get("--dt-bg")}"`,
  `  surface: "${dark.get("--dt-surface")}"`,
  `  chrome: "${dark.get("--dt-chrome")}"`,
  `  chrome-strong: "${dark.get("--dt-chrome-strong")}"`,
  `  panel: "${dark.get("--dt-panel")}"`,
  `  popover: "${dark.get("--dt-popover")}"`,
  `  card: "${dark.get("--dt-card")}"`,
  `  field: "${dark.get("--dt-field")}"`,
  `  faint: "${dark.get("--dt-faint")}"`,
  `  border: "${dark.get("--dt-border")}"`,
  `  border-strong: "${dark.get("--dt-border-strong")}"`,
  `  text: "${dark.get("--dt-text")}"`,
  `  text-2: "${dark.get("--dt-text-2")}"`,
  `  text-3: "${dark.get("--dt-text-3")}"`,
  `  accent: "${dark.get("--dt-accent")}"`,
  `  accent-strong: "${dark.get("--dt-accent-strong")}"`,
  `  primary: "${dark.get("--dt-accent-strong")}"`,
  `  on-primary: "#ffffff"`,
  `  lime: "${dark.get("--dt-lime")}"`,
  `  ok: "${dark.get("--dt-ok")}"`,
  `  warn: "${dark.get("--dt-warn")}"`,
  `  error: "${dark.get("--dt-error")}"`,
  `  info: "${dark.get("--dt-info")}"`,
  "typography:",
  "  display:",
  `    fontFamily: ${fontFamily("--dt-font")}`,
  `    fontSize: ${dark.get("--dt-size-4xl")}`,
  "  heading:",
  `    fontFamily: ${fontFamily("--dt-font")}`,
  `    fontSize: ${dark.get("--dt-size-2xl")}`,
  "  title:",
  `    fontFamily: ${fontFamily("--dt-font")}`,
  `    fontSize: ${dark.get("--dt-size-xl")}`,
  "  body:",
  `    fontFamily: ${fontFamily("--dt-font")}`,
  `    fontSize: ${dark.get("--dt-size-base")}`,
  "  label:",
  `    fontFamily: ${fontFamily("--dt-font")}`,
  `    fontSize: ${dark.get("--dt-size-sm")}`,
  "  caption:",
  `    fontFamily: ${fontFamily("--dt-font")}`,
  `    fontSize: ${dark.get("--dt-size-xs")}`,
  "  code:",
  `    fontFamily: ${fontFamily("--dt-mono")}`,
  `    fontSize: ${dark.get("--dt-size-sm")}`,
  "rounded:",
  `  sm: ${dark.get("--dt-radius-sm")}`,
  `  md: ${dark.get("--dt-radius")}`,
  "---",
];

const prose = [
  ...yaml,
  "",
  "## Overview",
  "",
  "A dense request inspector, dark first. Neutral inks carry the surface and the",
  "text, one violet accent carries interaction and brand, and state colors are",
  "reserved for meaning: lime for success, amber for warnings, coral for errors",
  "and pale blue for information. Nothing else on the screen carries color.",
  "",
  "## Colors",
  "",
  "- Backgrounds run from the page (`background`) through chrome strips",
  "  (`chrome`, `chrome-strong`) to floating layers (`panel`, `card`,",
  "  `popover`, `field`, `faint`).",
  "- Text uses the ramp `text`, `text-2`, `text-3`; never a hardcoded gray.",
  "- `accent` (violet) marks interaction: focus rings, selection, brand. Use",
  "  `accent-strong` only where the accent has to survive on light fills.",
  "  `accent-strong` is also the format's `primary` (it fills primary buttons),",
  "  with `on-primary` as its foreground.",
  "- State colors `ok`, `warn`, `error`, `info` come with soft backgrounds in",
  "  styles.css. They may not double as decoration.",
  "- Component code never holds a raw hex. Utilities come from the `@theme",
  "  inline` mapping in theme.css (`bg-brand-soft`, `text-ok`, `text-3`, and so",
  '  on). The light theme is `:root[data-theme="light"]` in styles.css.',
  "",
  "## Typography",
  "",
  "Geist Variable for text, Geist Mono Variable for code for everything that",
  "reads as a value (durations, rows counts, SQL). The scale is the `--dt-size-*`",
  "set, exposed as the Tailwind text utilities `text-2xs` through `text-4xl`",
  "with their own line heights. Sizes outside the scale do not exist.",
  "",
  "## Layout",
  "",
  "Density is a knob: `html { font-size: 71.25% }`, one line in the app CSS.",
  "Every size and spacing value sits on rem, and the whole UI scales from that",
  "one line. The shell offers a sidebar in `chrome`, a list rail and a detail",
  "panel. Generous popovers read at their own size; they do not shrink content.",
  "",
  "## Elevation & Depth",
  "",
  "Structure comes from hairline borders (`border`, `border-strong`), not from",
  "shadow. Two shadows exist: `--dt-shadow`, a soft inset lift for panels, and",
  "`--dt-popover-shadow` for the floating layer. No other shadow is permitted.",
  "",
  "## Shapes",
  "",
  "Radii are `--dt-radius` (panels, cards) and `--dt-radius-sm` (small controls,",
  "inputs, badges). Chips and pills use `999px`. Corners stay on the radii the",
  "two tokens think about; nothing is square except hairline borders.",
  "",
  "## Components",
  "",
  "The shared system is the shadcn/ui wrappers in `@tracepanel/ui` (button,",
  "badge, card, checkbox, command, dialog, dropdown-menu, input, popover,",
  "separator, table, tabs, tooltip). Variants are declared with cva and tokens",
  "apply through cn(). A local escape carries its reason next to the code as a",
  "`// dt-exception: <reason>` comment. Doubts about system coverage go to",
  "`ui/design-system/gaps.md` once the design-system craft PR lands; logging",
  "does not authorize the repair.",
  "",
  "## Do's and Don'ts",
  "",
  "- Do use the semantic tokens and the `@theme inline` utilities. Don't type a",
  "  hex, a px size or a font stack into component code.",
  "- Don't add color, size or spacing tokens without a use in the same PR that",
  "  defines their rule. A token is a contract, not a constant.",
  "- Do keep class lists short and in the canonical order. Don't rebuild",
  "  system components with `className` payloads where a variant exists.",
  "- Don't let the widget carry a second palette: it must consume the tokens.",
  "",
  "## Intent and shared rules",
  "",
  "The console answers one end-user task: find one request among observed",
  "traffic, then read its story without leaving the page. The visual character",
  "is dense, dark-first and quiet: neutral inks, one accent, hairline",
  "structure. Required rules live in the sections above and in the contracts;",
  "the craft/use split of the design-system skill governs who may change",
  "them. Local escapes carry a `// dt-exception: <reason>` comment next to",
  "the code and a gap entry when the reason is a system gap.",
  "",
  "## Design-system sources",
  "",
  "- Components: [index](design-system/COMPONENTS.md)",
  "- Layouts: [index](design-system/LAYOUTS.md)",
  "- Patterns: [index](design-system/PATTERNS.md)",
  "- Tokens: `packages/ui/src/styles.css` (the `--dt-*` set, dark default,",
  '  light overrides under `:root[data-theme="light"]`).',
  "- Theme bridge: `packages/ui/src/theme.css` maps tokens to Tailwind and the",
  "  shadcn variables.",
  "",
  "UI indexes route to contracts; the token file is the single source of",
  "values. Layout and pattern contracts do not exist yet; empty indexes are",
  "valid until the craft workflow defines them.",
  "",
  "## Contracts and public use",
  "",
  "Component contracts live in `design-system/components/` with their",
  "uppercase index. Public imports resolve through the `@tracepanel/ui`",
  "exports map: `@tracepanel/ui/components/ui/*`, `@tracepanel/ui/lib/utils`,",
  "`@tracepanel/ui/hooks/*`. The app (`apps/local`) consumes those imports;",
  "`packages/widget` consumes the components for its build. Any import that",
  "does not resolve through the exports map is a violation, not a",
  "convenience.",
  "",
  "Craft follows the project process for design-only CSS, markup and public",
  "settings; product screens compose through the public APIs. Component",
  "internals and business logic remain project-owned.",
  "",
  "## Verification",
  "",
  "- `pnpm lint` (biome + typecheck) and `pnpm build`, from `ui/`.",
  "- `pnpm design-md` regenerates this file; `pnpm design-md:lint` validates",
  "  it. CI runs both plus the fallow quality gate (`fallow audit --base`).",
  "- The design-system contract checker: `node",
  "  .agents/skills/design-system/scripts/check-contract.mjs` and the staged",
  "  variant in the pre-commit hook.",
  "- Screen evidence: the `ui-verify` skill (agent-browser, axe-core,",
  "  console checks). Browser support: current Chromium and Firefox; the",
  "  widget targets the same engines.",
  "",
  "## Gaps and decisions",
  "",
  "Open gaps: [journal](design-system/gaps.md). Closed entries:",
  "[archive](design-system/gaps-archive.md). Move closed entries there in full",
  "with their disposition, closure date and basis. Resolution requires",
  "demonstrating the original expected result.",
];

function fail(message) {
  process.stderr.write(`design-md: ${message}\n`);
  process.exit(1);
}

fs.writeFileSync(outPath, `${prose.join("\n")}\n`);
process.stdout.write(`design-md: wrote ${path.relative(process.cwd(), outPath)}\n`);
