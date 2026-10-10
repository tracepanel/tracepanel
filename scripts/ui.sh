#!/bin/sh
# Update ui-dist/, the console's UI the server crate embeds, from ui/: builds it (pnpm) and copies the files the
# browser loads, with NOTICES (the licenses of its packages, part of THIRD-PARTY-NOTICES). Commit ui-dist/ with the
# change to ui/: the agent then builds with cargo alone, no Node.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
(cd "$root/ui" && pnpm install --frozen-lockfile --silent && pnpm build)
dist=$root/ui/apps/local/dist
rm -rf "$root/ui-dist"
cp -R "$dist" "$root/ui-dist"
# The source maps are for the UI's own development (`pnpm dev` has them); the sources are in ui/.
find "$root/ui-dist" -name '*.map' -delete
uv run --no-project "$root/scripts/notices.py" --ui > "$root/ui-dist/NOTICES"
echo "ui-dist/ updated from ui/" >&2
