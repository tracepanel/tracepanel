# Skill pins

The agent skills live in `.agents/skills/`; `.claude/skills` is a symlink to that directory, so every agent reads one real copy. Each vendored skill pins its upstream revision here: updating a pin is a deliberate change that review sees.

| Skill | Upstream | Pinned revision | Copied |
| --- | --- | --- | --- |
| design-system | github.com/ymandrikov/ai-design-system, path skills/design-system | 05e0a9ede21cd5e66f5293164e14f6cd3f441dd0 | 2026-10-11 |
| tailwind-best-practices | github.com/evilmartians/agent-skills, path skills/tailwind-best-practices | 075cf6a983bed7b81ef4b91bd9d529bb88c4bfd3 | 2026-10-11 |
| unslop | github.com/cursor/plugins, path pstack/skills/unslop | 11713c683fe4 | 2026-10-11 |
| fallow | fallow.tools/skill.md (served live, versioned by fallow itself) | fallow 3.33.1 era | 2026-10-11 |
| deslop | local agent skills directory at the time (no public upstream pin) | unmatched upstream | 2026-10-11 |
| docs, release | written in this repository | n/a | n/a |
| ui-verify | written in this repository | n/a | n/a |

How to upgrade a vendored skill:

1. Download its new `SKILL.md` (and supporting files) at the new revision.
2. Diff against the vendored copy and keep real deltas, not formatting.
3. Update the pin in this table and say what changed in the PR body.
