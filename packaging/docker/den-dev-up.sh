#!/usr/bin/env bash
set -euo pipefail

# Bring up a local Den testability stack with random host ports.
#
# Usage (from _repos/openwork repo root):
#   packaging/docker/den-dev-up.sh
#
# Outputs:
# - Cloud web app URL
# - Den control plane demo/API URL
# - Runtime env file path with ports + project name

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/packaging/docker/docker-compose.den-dev.yml"
RUNTIME_DIR="$ROOT_DIR/tmp/docker-den-dev"
DAYTONA_ENV_FILE="${DAYTONA_ENV_FILE:-$ROOT_DIR/.env.daytona}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

pick_port() {
  node -e "
    const net = require('net');
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      console.log(port);
      server.close();
    });
  "
}

random_hex() {
  local bytes="$1"
  node -e "console.log(require('crypto').randomBytes(${bytes}).toString('hex'))"
}

DEV_ID="$(node -e "console.log(require('crypto').randomUUID().slice(0, 8))")"
PROJECT="openwork-den-dev-$DEV_ID"

DEN_API_PORT="${DEN_API_PORT:-$(pick_port)}"
DEN_WEB_PORT="${DEN_WEB_PORT:-$(pick_port)}"
DEN_WORKER_PROXY_PORT="${DEN_WORKER_PROXY_PORT:-$(pick_port)}"
DEN_MYSQL_PORT="${DEN_MYSQL_PORT:-$(pick_port)}"
if [ "$DEN_WEB_PORT" = "$DEN_API_PORT" ]; then
  DEN_WEB_PORT="$(pick_port)"
fi
if [ "$DEN_WORKER_PROXY_PORT" = "$DEN_API_PORT" ] || [ "$DEN_WORKER_PROXY_PORT" = "$DEN_WEB_PORT" ]; then
  DEN_WORKER_PROXY_PORT="$(pick_port)"
fi
if [ "$DEN_MYSQL_PORT" = "$DEN_API_PORT" ] || [ "$DEN_MYSQL_PORT" = "$DEN_WEB_PORT" ] || [ "$DEN_MYSQL_PORT" = "$DEN_WORKER_PROXY_PORT" ]; then
  DEN_MYSQL_PORT="$(pick_port)"
fi

DEN_BETTER_AUTH_SECRET="${DEN_BETTER_AUTH_SECRET:-$(random_hex 32)}"
DEN_BETTER_AUTH_URL="${DEN_BETTER_AUTH_URL:-http://localhost:$DEN_WEB_PORT}"
DEN_PROVISIONER_MODE="${DEN_PROVISIONER_MODE:-stub}"
DEN_WORKER_URL_TEMPLATE="${DEN_WORKER_URL_TEMPLATE:-https://workers.local/{workerId}}"
DEN_DAYTONA_WORKER_PROXY_BASE_URL="${DEN_DAYTONA_WORKER_PROXY_BASE_URL:-http://localhost:$DEN_WORKER_PROXY_PORT}"
DEN_CORS_ORIGINS="${DEN_CORS_ORIGINS:-http://localhost:$DEN_WEB_PORT,http://127.0.0.1:$DEN_WEB_PORT,http://localhost:$DEN_API_PORT,http://127.0.0.1:$DEN_API_PORT}"

if [ "$DEN_PROVISIONER_MODE" = "daytona" ] && [ -f "$DAYTONA_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$DAYTONA_ENV_FILE"
  set +a
fi

if [ "$DEN_PROVISIONER_MODE" = "daytona" ] && [ -z "${DAYTONA_API_KEY:-}" ]; then
  echo "DAYTONA_API_KEY is required when DEN_PROVISIONER_MODE=daytona" >&2
  echo "Set DAYTONA_ENV_FILE to your .env.daytona path or export DAYTONA_API_KEY before running den-dev-up.sh" >&2
  exit 1
fi

mkdir -p "$RUNTIME_DIR"
RUNTIME_FILE="$ROOT_DIR/tmp/.den-dev-env-$DEV_ID"

cat > "$RUNTIME_FILE" <<EOF
PROJECT=$PROJECT
DEN_API_PORT=$DEN_API_PORT
DEN_WEB_PORT=$DEN_WEB_PORT
DEN_WORKER_PROXY_PORT=$DEN_WORKER_PROXY_PORT
DEN_MYSQL_PORT=$DEN_MYSQL_PORT
DEN_API_URL=http://localhost:$DEN_API_PORT
DEN_WEB_URL=http://localhost:$DEN_WEB_PORT
DEN_WORKER_PROXY_URL=http://localhost:$DEN_WORKER_PROXY_PORT
DEN_MYSQL_URL=mysql://root:password@127.0.0.1:$DEN_MYSQL_PORT/openwork_den
DEN_BETTER_AUTH_URL=$DEN_BETTER_AUTH_URL
COMPOSE_FILE=$COMPOSE_FILE
EOF

echo "Starting Docker Compose project: $PROJECT" >&2
echo "- DEN_API_PORT=$DEN_API_PORT" >&2
echo "- DEN_WEB_PORT=$DEN_WEB_PORT" >&2
echo "- DEN_WORKER_PROXY_PORT=$DEN_WORKER_PROXY_PORT" >&2
echo "- DEN_MYSQL_PORT=$DEN_MYSQL_PORT" >&2
echo "- DEN_BETTER_AUTH_URL=$DEN_BETTER_AUTH_URL" >&2
echo "- DEN_PROVISIONER_MODE=$DEN_PROVISIONER_MODE" >&2
if [ "$DEN_PROVISIONER_MODE" = "daytona" ]; then
  echo "- DAYTONA_API_URL=${DAYTONA_API_URL:-https://app.daytona.io/api}" >&2
  if [ -n "${DAYTONA_TARGET:-}" ]; then
    echo "- DAYTONA_TARGET=$DAYTONA_TARGET" >&2
  fi
fi

if ! DEN_API_PORT="$DEN_API_PORT" \
  DEN_WEB_PORT="$DEN_WEB_PORT" \
  DEN_WORKER_PROXY_PORT="$DEN_WORKER_PROXY_PORT" \
  DEN_MYSQL_PORT="$DEN_MYSQL_PORT" \
  DEN_BETTER_AUTH_SECRET="$DEN_BETTER_AUTH_SECRET" \
  DEN_BETTER_AUTH_URL="$DEN_BETTER_AUTH_URL" \
  DEN_CORS_ORIGINS="$DEN_CORS_ORIGINS" \
  DEN_PROVISIONER_MODE="$DEN_PROVISIONER_MODE" \
  DEN_WORKER_URL_TEMPLATE="$DEN_WORKER_URL_TEMPLATE" \
  DEN_DAYTONA_WORKER_PROXY_BASE_URL="$DEN_DAYTONA_WORKER_PROXY_BASE_URL" \
  DAYTONA_API_URL="${DAYTONA_API_URL:-}" \
  DAYTONA_API_KEY="${DAYTONA_API_KEY:-}" \
  DAYTONA_TARGET="${DAYTONA_TARGET:-}" \
  DAYTONA_SNAPSHOT="${DAYTONA_SNAPSHOT:-}" \
  DAYTONA_OPENWORK_VERSION="${DAYTONA_OPENWORK_VERSION:-}" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build --wait; then
  echo "Den Docker stack failed to start. Recent logs:" >&2
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs --tail=200 >&2 || true
  exit 1
fi

echo "" >&2
echo "OpenWork Cloud web UI:  http://localhost:$DEN_WEB_PORT" >&2
echo "Den demo/API:          http://localhost:$DEN_API_PORT" >&2
echo "Worker proxy:          http://localhost:$DEN_WORKER_PROXY_PORT" >&2
echo "MySQL:                 mysql://root:password@127.0.0.1:$DEN_MYSQL_PORT/openwork_den" >&2
echo "Health check:          http://localhost:$DEN_API_PORT/health" >&2
echo "Runtime env file:      $RUNTIME_FILE" >&2
echo "" >&2
echo "To stop this stack (keep DB data):" >&2
echo "  docker compose -p $PROJECT -f $COMPOSE_FILE down" >&2
echo "To stop and reset the DB:" >&2
echo "  docker compose -p $PROJECT -f $COMPOSE_FILE down -v" >&2
