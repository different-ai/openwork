#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=packaging/docker/dev/common.sh
source "$SCRIPT_DIR/common.sh"

ensure_runtime_dir
print_debug_context web

if ! wait_for_file "$OPENWORK_RUNTIME_ENV_FILE" 60; then
  log_line web "timed out waiting for $OPENWORK_RUNTIME_ENV_FILE"
  exit 1
fi

# shellcheck source=/dev/null
source "$OPENWORK_RUNTIME_ENV_FILE"

export HOST="0.0.0.0"
export PORT="5173"
export VITE_ALLOWED_HOSTS="all"
export VITE_OPENWORK_URL="http://localhost:${OPENWORK_PORT:-8787}"
export VITE_OPENWORK_PORT="${OPENWORK_PORT:-8787}"
export VITE_OPENWORK_TOKEN="$OPENWORK_TOKEN"

log_line web "ui http://localhost:${WEB_PORT:-5173}"
log_line web "token ${VITE_OPENWORK_TOKEN:-unset}"

exec pnpm --filter @different-ai/openwork-ui exec vite \
  --host 0.0.0.0 \
  --port 5173 \
  --strictPort
