#!/bin/sh
# Update ui-dist/, the console's UI the server crate embeds, from ui/: builds it (pnpm) and copies the files the
# browser loads, with NOTICES (the licenses of its packages, part of THIRD-PARTY-NOTICES). Commit ui-dist/ with the
# change to ui/: the agent then builds with cargo alone, no Node.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
# ui/package.json says which Node it needs ("engines": ">=26"); an older one fails later in pnpm with an unclear error.
need=$(sed -n 's/.*"node": ">=\([0-9]*\)".*/\1/p' "$root/ui/package.json")
have=$(node -p 'process.versions.node' 2>/dev/null || echo none)
if [ "${have%%.*}" = none ] || [ "${have%%.*}" -lt "$need" ]; then
  echo "ui/ needs Node $need or newer (found: $have); with nvm: nvm install $need && nvm alias default $need" >&2
  exit 1
fi
(cd "$root/ui" && pnpm install --frozen-lockfile --silent && pnpm build)
dist=$root/ui/apps/local/dist
rm -rf "$root/ui-dist"
cp -R "$dist" "$root/ui-dist"
# The source maps are for the UI's own development (`pnpm dev` has them); the sources are in ui/.
find "$root/ui-dist" -name '*.map' -delete
# Into a temporary file first: a failed run must not leave NOTICES empty.
uv run --no-project "$root/scripts/notices.py" --ui > "$root/ui-dist/NOTICES.tmp"
mv "$root/ui-dist/NOTICES.tmp" "$root/ui-dist/NOTICES"
echo "ui-dist/ updated from ui/" >&2
