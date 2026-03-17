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

detect_public_host() {
  if [ -n "${DEN_PUBLIC_HOST:-}" ]; then
    printf '%s\n' "$DEN_PUBLIC_HOST"
    return
  fi

  local host
  host="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"
  host="${host//$'\n'/}"
  host="${host// /}"
  if [ -n "$host" ]; then
    printf '%s\n' "$host"
    return
  fi

  printf '%s\n' "localhost"
}

detect_lan_ipv4() {
  node -e '
    const os = require("os");
    const nets = os.networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const entry of entries || []) {
        if (!entry || entry.internal || entry.family !== "IPv4") continue;
        if (entry.address.startsWith("127.")) continue;
        process.stdout.write(entry.address);
        process.exit(0);
      }
    }
  '
}

join_csv_unique() {
  printf "%s\n" "$@" | awk 'NF && !seen[$0]++' | paste -sd, -
}

DEV_ID="$(node -e "console.log(require('crypto').randomUUID().slice(0, 8))")"
PROJECT="openwork-den-dev-$DEV_ID"

DEN_API_PORT="${DEN_API_PORT:-$(pick_port)}"
DEN_WEB_PORT="${DEN_WEB_PORT:-$(pick_port)}"
if [ "$DEN_WEB_PORT" = "$DEN_API_PORT" ]; then
  DEN_WEB_PORT="$(pick_port)"
fi

PUBLIC_HOST="$(detect_public_host)"
LAN_IPV4="$(detect_lan_ipv4 || true)"

DEN_BETTER_AUTH_SECRET="${DEN_BETTER_AUTH_SECRET:-$(random_hex 32)}"
DEN_BETTER_AUTH_URL="${DEN_BETTER_AUTH_URL:-http://$PUBLIC_HOST:$DEN_WEB_PORT}"
DEN_PROVISIONER_MODE="${DEN_PROVISIONER_MODE:-stub}"
DEN_WORKER_URL_TEMPLATE="${DEN_WORKER_URL_TEMPLATE:-https://workers.local/{workerId}}"
if [ -z "${DEN_CORS_ORIGINS:-}" ]; then
  DEN_CORS_ORIGINS="$(join_csv_unique \
    "http://$PUBLIC_HOST:$DEN_WEB_PORT" \
    "http://$PUBLIC_HOST:$DEN_API_PORT" \
    "http://localhost:$DEN_WEB_PORT" \
    "http://127.0.0.1:$DEN_WEB_PORT" \
    "http://localhost:$DEN_API_PORT" \
    "http://127.0.0.1:$DEN_API_PORT" \
    "${LAN_IPV4:+http://$LAN_IPV4:$DEN_WEB_PORT}" \
    "${LAN_IPV4:+http://$LAN_IPV4:$DEN_API_PORT}")"
fi

DEN_BETTER_AUTH_TRUSTED_ORIGINS="${DEN_BETTER_AUTH_TRUSTED_ORIGINS:-$DEN_CORS_ORIGINS}"

mkdir -p "$RUNTIME_DIR"
RUNTIME_FILE="$ROOT_DIR/tmp/.den-dev-env-$DEV_ID"

cat > "$RUNTIME_FILE" <<EOF
PROJECT=$PROJECT
DEN_API_PORT=$DEN_API_PORT
DEN_WEB_PORT=$DEN_WEB_PORT
DEN_API_URL=http://localhost:$DEN_API_PORT
DEN_WEB_URL=http://localhost:$DEN_WEB_PORT
DEN_WEB_URL_PUBLIC=http://$PUBLIC_HOST:$DEN_WEB_PORT
DEN_BETTER_AUTH_URL=$DEN_BETTER_AUTH_URL
COMPOSE_FILE=$COMPOSE_FILE
EOF

echo "Starting Docker Compose project: $PROJECT" >&2
echo "- DEN_API_PORT=$DEN_API_PORT" >&2
echo "- DEN_WEB_PORT=$DEN_WEB_PORT" >&2
echo "- DEN_BETTER_AUTH_URL=$DEN_BETTER_AUTH_URL" >&2
echo "- DEN_BETTER_AUTH_TRUSTED_ORIGINS=$DEN_BETTER_AUTH_TRUSTED_ORIGINS" >&2
echo "- DEN_CORS_ORIGINS=$DEN_CORS_ORIGINS" >&2
echo "- DEN_PROVISIONER_MODE=$DEN_PROVISIONER_MODE" >&2

if ! DEN_API_PORT="$DEN_API_PORT" \
  DEN_WEB_PORT="$DEN_WEB_PORT" \
  DEN_BETTER_AUTH_SECRET="$DEN_BETTER_AUTH_SECRET" \
  DEN_BETTER_AUTH_URL="$DEN_BETTER_AUTH_URL" \
  DEN_BETTER_AUTH_TRUSTED_ORIGINS="$DEN_BETTER_AUTH_TRUSTED_ORIGINS" \
  DEN_CORS_ORIGINS="$DEN_CORS_ORIGINS" \
  DEN_PROVISIONER_MODE="$DEN_PROVISIONER_MODE" \
  DEN_WORKER_URL_TEMPLATE="$DEN_WORKER_URL_TEMPLATE" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --wait; then
  echo "Den Docker stack failed to start. Recent logs:" >&2
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs --tail=200 >&2 || true
  exit 1
fi

echo "" >&2
echo "OpenWork Cloud web UI:  http://localhost:$DEN_WEB_PORT" >&2
echo "OpenWork Cloud web UI (LAN/public): http://$PUBLIC_HOST:$DEN_WEB_PORT" >&2
if [ -n "$LAN_IPV4" ]; then
  echo "OpenWork Cloud web UI (LAN IP):     http://$LAN_IPV4:$DEN_WEB_PORT" >&2
fi
echo "Den demo/API:          http://localhost:$DEN_API_PORT" >&2
echo "Den demo/API (LAN/public):          http://$PUBLIC_HOST:$DEN_API_PORT" >&2
if [ -n "$LAN_IPV4" ]; then
  echo "Den demo/API (LAN IP):              http://$LAN_IPV4:$DEN_API_PORT" >&2
fi
echo "Health check:          http://localhost:$DEN_API_PORT/health" >&2
echo "Runtime env file:      $RUNTIME_FILE" >&2
echo "" >&2
echo "To stop this stack (keep DB data):" >&2
echo "  docker compose -p $PROJECT -f $COMPOSE_FILE down" >&2
echo "To stop and reset the DB:" >&2
echo "  docker compose -p $PROJECT -f $COMPOSE_FILE down -v" >&2
