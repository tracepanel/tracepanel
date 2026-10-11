# AGENTS

This repository is the Tracepanel agent: a Rust binary that observes traffic and serves the traces console. The console, the panel and the widget live in `ui/` and ship as `ui-dist/`, what the Rust binary embeds.

## Where things live

```text
crates/    the agent (analysis, server, store, protocol, and the rest)
ui/        the pnpm workspace for the console UI (apps/local, packages/ui, packages/widget)
ui-dist/   the built UI, committed; the agent embeds it
schema/    the wire and API contracts the code is generated from
scripts/   project scripts (UI build, docs lint, wheel checks)
```

## Working on the console UI

1. Read the relevant skill before the work, and follow it:
   - `design-system` for any component, layout, pattern, token or screen work. It routes two workflows: `use` builds screens with the system, `craft` changes the system. Keep them in separate PRs.
   - `tailwind-best-practices` whenever Tailwind classes are written or edited.
   - `fallow` to audit a diff, find dead code, or check the boundaries before opening a PR.
   - `ui-verify` to record screen evidence for a UI PR.
   - `deslop` in a cleanup PR per area, never mixed with a behavior change.
   - `unslop` when writing or editing prose.
2. Check `ui/design-system/` inventories for a component before writing a new one; the component code alone is not its contract. `ui/DESIGN.md` is the entry point: sources, indexes, verification and the gap journal.
3. Record every doubt about system coverage in `ui/design-system/gaps.md`, and work through the documented APIs and escapes meanwhile. Logging is not authorization.
4. The generated API client (`ui/packages/ui/src/api.gen.ts`) is off limits: change `schema/openapi.yaml` and run `pnpm api` instead. Types in the app come from that contract.

## The gates

- git hooks (lefthook): biome on staged `ui/` files, docs lint on prose pages, and a pre-push typecheck plus `fallow audit --base origin/main`
- CI runs the same five jobs (`Biome`, `TypeScript`, `API contract`, `ui-dist`, `fallow quality gate`); a PR lands only with all five green
- `fallow audit` fails only on findings the change introduces
- `ui/DESIGN.md` is generated from the `--dt-*` tokens by `pnpm design-md`; regenerate and commit it after token changes, CI checks the sync too
- Dependabot proposes `ui/` dependency updates (`.github/dependabot.yml`): minors and patches in one weekly PR, majors one by one. Its 48-hour cooldown matches `ui/pnpm-workspace.yaml`; no token or GitHub app is involved

## House rules

- Node 26 (the floor is `engines.node` in `ui/package.json`; CI pins it), the pnpm version in `ui/package.json` packageManager, no global install
- The repo voice rules (`.agents/skills/docs/SKILL.md`) apply to the README, the changelog, the security and contributing pages and PR descriptions: plain verbs, no marketing words, no em dashes, no semicolons
- Keep changes consistent with the surrounding structure. When a rule exists in a hook, change the hook or the config, never skip it silently
