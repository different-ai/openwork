#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash before publish."
  exit 1
fi

version=$(node -p "require('./packages/headless/package.json').version")
echo "Publishing openwrk@$version"

pnpm --filter openwrk publish --access public
