#!/usr/bin/env bash
set -euo pipefail

exec "$CHROME_BIN" --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check \
  --user-data-dir="${OPENWORK_PROOF_BROWSER_PROFILE:-$RUNNER_TEMP/pr-proof-browser}" "$@"
