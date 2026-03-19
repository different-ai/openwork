#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash before publish."
  exit 1
fi

version=$(node -p "require('./apps/orchestrator/package.json').version")
echo "Publishing openwork-orchestrator@$version"

pnpm --filter openwork-orchestrator publish --access public
