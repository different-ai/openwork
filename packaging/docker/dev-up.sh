#!/usr/bin/env bash
set -euo pipefail

# Bring up a dev stack with random host ports.
#
# Usage (from _repos/openwork repo root):
#   packaging/docker/dev-up.sh
#
# Outputs:
# - Web UI URL
# - OpenWork server URL
# - Token file path

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/packaging/docker/docker-compose.dev.yml"
WORKSPACE_DIR="$ROOT_DIR/packaging/docker/workspace"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

pick_port() {
  node -e "
    const net = require('net');
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      console.log(port);
      s.close();
    });
  "
}

DEV_ID="$(node -e "console.log(require('crypto').randomUUID().slice(0, 8))")"
PROJECT="openwork-dev-$DEV_ID"

mkdir -p "$WORKSPACE_DIR"

OPENWORK_PORT="$(pick_port)"
WEB_PORT="$(pick_port)"
if [ "$WEB_PORT" = "$OPENWORK_PORT" ]; then
  WEB_PORT="$(pick_port)"
fi

echo "Starting Docker Compose project: $PROJECT" >&2
echo "- OPENWORK_PORT=$OPENWORK_PORT" >&2
echo "- WEB_PORT=$WEB_PORT" >&2

OPENWORK_DEV_ID="$DEV_ID" OPENWORK_PORT="$OPENWORK_PORT" WEB_PORT="$WEB_PORT" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d

echo "" >&2
echo "OpenWork web UI:     http://localhost:$WEB_PORT" >&2
echo "OpenWork server:     http://localhost:$OPENWORK_PORT" >&2
echo "Token file:          $ROOT_DIR/tmp/.dev-env-$DEV_ID" >&2
echo "" >&2
echo "To stop this stack:" >&2
echo "  docker compose -p $PROJECT -f $COMPOSE_FILE down" >&2
