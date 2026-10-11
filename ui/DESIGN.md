---
name: Tracepanel
omitted: [spacing, components]
colors:
  background: "#0a0c11"
  surface: "#0a0c11"
  chrome: "#0d1016"
  chrome-strong: "#12151d"
  panel: "#0a0c11"
  popover: "#12151d"
  card: "#10131a"
  field: "#0c0f15"
  faint: "#141821"
  border: "#1d212c"
  border-strong: "#2a3040"
  text: "#eceef3"
  text-2: "#b9bfcd"
  text-3: "#8c93a6"
  accent: "#bc9cff"
  accent-strong: "#7c4ff0"
  primary: "#7c4ff0"
  on-primary: "#ffffff"
  lime: "#b6e24a"
  ok: "#b8f25c"
  warn: "#f5b544"
  error: "#ff8a7a"
  info: "#9db2ff"
typography:
  display:
    fontFamily: Geist Variable
    fontSize: 1.875rem
  heading:
    fontFamily: Geist Variable
    fontSize: 1.5rem
  title:
    fontFamily: Geist Variable
    fontSize: 1.25rem
  body:
    fontFamily: Geist Variable
    fontSize: 0.875rem
  label:
    fontFamily: Geist Variable
    fontSize: 0.8125rem
  caption:
    fontFamily: Geist Variable
    fontSize: 0.75rem
  code:
    fontFamily: Geist Mono Variable
    fontSize: 0.8125rem
rounded:
  sm: 0.4375rem
  md: 0.625rem
---

## Overview

A dense request inspector, dark first. Neutral inks carry the surface and the
text, one violet accent carries interaction and brand, and state colors are
reserved for meaning: lime for success, amber for warnings, coral for errors
and pale blue for information. Nothing else on the screen carries color.

## Colors

- Backgrounds run from the page (`background`) through chrome strips
  (`chrome`, `chrome-strong`) to floating layers (`panel`, `card`,
  `popover`, `field`, `faint`).
- Text uses the ramp `text`, `text-2`, `text-3`; never a hardcoded gray.
- `accent` (violet) marks interaction: focus rings, selection, brand. Use
  `accent-strong` only where the accent has to survive on light fills.
  `accent-strong` is also the format's `primary` (it fills primary buttons),
  with `on-primary` as its foreground.
- State colors `ok`, `warn`, `error`, `info` come with soft backgrounds in
  styles.css. They may not double as decoration.
- Component code never holds a raw hex. Utilities come from the `@theme
  inline` mapping in theme.css (`bg-brand-soft`, `text-ok`, `text-3`, and so
  on). The light theme is `:root[data-theme="light"]` in styles.css.

## Typography

Geist Variable for text, Geist Mono Variable for code for everything that
reads as a value (durations, rows counts, SQL). The scale is the `--dt-size-*`
set, exposed as the Tailwind text utilities `text-2xs` through `text-4xl`
with their own line heights. Sizes outside the scale do not exist.

## Layout

Density is a knob: `html { font-size: 71.25% }`, one line in the app CSS.
Every size and spacing value sits on rem, and the whole UI scales from that
one line. The shell offers a sidebar in `chrome`, a list rail and a detail
panel. Generous popovers read at their own size; they do not shrink content.

## Elevation & Depth

Structure comes from hairline borders (`border`, `border-strong`), not from
shadow. Two shadows exist: `--dt-shadow`, a soft inset lift for panels, and
`--dt-popover-shadow` for the floating layer. No other shadow is permitted.

## Shapes

Radii are `--dt-radius` (panels, cards) and `--dt-radius-sm` (small controls,
inputs, badges). Chips and pills use `999px`. Corners stay on the radii the
two tokens think about; nothing is square except hairline borders.

## Components

The shared system is the shadcn/ui wrappers in `@tracepanel/ui` (button,
badge, card, checkbox, command, dialog, dropdown-menu, input, popover,
separator, table, tabs, tooltip). Variants are declared with cva and tokens
apply through cn(). A local escape carries its reason next to the code as a
`// dt-exception: <reason>` comment. Doubts about system coverage go to
`ui/design-system/gaps.md` once the design-system craft PR lands; logging
does not authorize the repair.

## Do's and Don'ts

- Do use the semantic tokens and the `@theme inline` utilities. Don't type a
  hex, a px size or a font stack into component code.
- Don't add color, size or spacing tokens without a use in the same PR that
  defines their rule. A token is a contract, not a constant.
- Do keep class lists short and in the canonical order. Don't rebuild
  system components with `className` payloads where a variant exists.
- Don't let the widget carry a second palette: it must consume the tokens.

## Intent and shared rules

The console answers one end-user task: find one request among observed
traffic, then read its story without leaving the page. The visual character
is dense, dark-first and quiet: neutral inks, one accent, hairline
structure. Required rules live in the sections above and in the contracts;
the craft/use split of the design-system skill governs who may change
them. Local escapes carry a `// dt-exception: <reason>` comment next to
the code and a gap entry when the reason is a system gap.

## Design-system sources

- Components: [index](design-system/COMPONENTS.md)
- Layouts: [index](design-system/LAYOUTS.md)
- Patterns: [index](design-system/PATTERNS.md)
- Tokens: `packages/ui/src/styles.css` (the `--dt-*` set, dark default,
  light overrides under `:root[data-theme="light"]`).
- Theme bridge: `packages/ui/src/theme.css` maps tokens to Tailwind and the
  shadcn variables.

UI indexes route to contracts; the token file is the single source of
values. Layout and pattern contracts do not exist yet; empty indexes are
valid until the craft workflow defines them.

## Contracts and public use

Component contracts live in `design-system/components/` with their
uppercase index. Public imports resolve through the `@tracepanel/ui`
exports map: `@tracepanel/ui/components/ui/*`, `@tracepanel/ui/lib/utils`,
`@tracepanel/ui/hooks/*`. The app (`apps/local`) consumes those imports;
`packages/widget` consumes the components for its build. Any import that
does not resolve through the exports map is a violation, not a
convenience.

Craft follows the project process for design-only CSS, markup and public
settings; product screens compose through the public APIs. Component
internals and business logic remain project-owned.

## Verification

- `pnpm lint` (biome + typecheck) and `pnpm build`, from `ui/`.
- `pnpm design-md` regenerates this file; `pnpm design-md:lint` validates
  it. CI runs both plus the fallow quality gate (`fallow audit --base`).
- The design-system contract checker: `node
  .agents/skills/design-system/scripts/check-contract.mjs` and the staged
  variant in the pre-commit hook.
- Screen evidence: the `ui-verify` skill (agent-browser, axe-core,
  console checks). Browser support: current Chromium and Firefox; the
  widget targets the same engines.

## Gaps and decisions

Open gaps: [journal](design-system/gaps.md). Closed entries:
[archive](design-system/gaps-archive.md). Move closed entries there in full
with their disposition, closure date and basis. Resolution requires
demonstrating the original expected result.
