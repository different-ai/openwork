#!/usr/bin/env bash
# Report unused files, dependencies and exports with knip, using the repo's knip.jsonc.
#
#   bash scripts/find-unused.sh                  # unused files and dependencies
#   bash scripts/find-unused.sh --include exports # any other knip flags are passed through
#
# knip.jsonc already declares the entry points that knip cannot infer (path-loaded OpenCode
# plugins, Electron preloads, scripts run from CI), so its findings need no extra filtering.
set -euo pipefail

cd "$(dirname "$0")/.."

args=("$@")
if [ ${#args[@]} -eq 0 ]; then
  args=(--include files,dependencies)
fi

# A fake DATABASE_URL keeps config files that read it at import time from failing.
DATABASE_URL="${DATABASE_URL:-mysql://fake:fake@localhost/fake}" \
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=12288}" \
  pnpm dlx knip@5 --config knip.jsonc --no-progress "${args[@]}"
