#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=packaging/docker/dev/common.sh
source "$SCRIPT_DIR/common.sh"

ensure_runtime_dir
print_debug_context orchestrator

mkdir -p /workspace
touch /workspace/.keep 2>/dev/null || true

OPENWORK_TOKEN="${OPENWORK_TOKEN:-$(cat /proc/sys/kernel/random/uuid)}"
OPENWORK_HOST_TOKEN="${OPENWORK_HOST_TOKEN:-$(cat /proc/sys/kernel/random/uuid)}"
OPENWORK_PORT="${OPENWORK_PORT:-8787}"
WEB_PORT="${WEB_PORT:-5173}"
OPENWORK_SERVER_BIN="${OPENWORK_SERVER_BIN:-/app/packages/server/dist/bin/openwork-server}"
OPENCODE_ROUTER_BIN="${OPENCODE_ROUTER_BIN:-/app/packages/opencode-router/dist/bin/opencode-router}"

cat > "$OPENWORK_RUNTIME_ENV_FILE" <<EOF
OPENWORK_TOKEN=$OPENWORK_TOKEN
OPENWORK_HOST_TOKEN=$OPENWORK_HOST_TOKEN
OPENWORK_PORT=$OPENWORK_PORT
WEB_PORT=$WEB_PORT
OPENWORK_URL=http://localhost:$OPENWORK_PORT
WEB_URL=http://localhost:$WEB_PORT
EOF

chmod 600 "$OPENWORK_RUNTIME_ENV_FILE"

log_line orchestrator "server http://localhost:$OPENWORK_PORT"
log_line orchestrator "health http://localhost:$OPENWORK_PORT/health"
log_line orchestrator "runtime env $OPENWORK_RUNTIME_ENV_FILE"
log_line orchestrator "token $OPENWORK_TOKEN"
log_line orchestrator "host token $OPENWORK_HOST_TOKEN"

command=(
  pnpm
  --filter
  openwork-orchestrator
  dev
  --
  start
  --workspace
  /workspace
  --openwork-host
  0.0.0.0
  --openwork-port
  8787
  --openwork-token
  "$OPENWORK_TOKEN"
  --openwork-host-token
  "$OPENWORK_HOST_TOKEN"
  --openwork-server-bin
  "$OPENWORK_SERVER_BIN"
  --opencode-router-bin
  "$OPENCODE_ROUTER_BIN"
  --approval
  auto
  --allow-external
  --no-opencode-auth
  --cors
  "*"
)

if docker_debug_enabled; then
  command+=(--verbose --log-format "${OPENWORK_LOG_FORMAT:-pretty}")
fi

exec "${command[@]}"
