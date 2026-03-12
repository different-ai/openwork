#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/packaging/docker/docker-compose.web-local.yml"
PROJECT_NAME="openwork-web-local"
ENV_FILE="$ROOT_DIR/.env.local"
LOCAL_DEN_PORT="8788"
LOCAL_WEB_PORT="3005"
LOCAL_BETTER_AUTH_URL="http://127.0.0.1:${LOCAL_DEN_PORT}"
LOCAL_WEB_ORIGIN="http://127.0.0.1:${LOCAL_WEB_PORT}"
LOCAL_WORKER_URL_TEMPLATE="https://workers.example.com/{workerId}"
DEV_CMD=(pnpm --parallel --filter @openwork/den --filter @different-ai/openwork-web dev)

detect_web_origins() {
  node <<'EOF'
const os = require('os');

const origins = new Set([
  'http://localhost:3005',
  'http://127.0.0.1:3005',
]);

for (const entries of Object.values(os.networkInterfaces())) {
  for (const entry of entries || []) {
    if (!entry || entry.internal || entry.family !== 'IPv4') continue;
    origins.add(`http://${entry.address}:3005`);
  }
}

process.stdout.write(Array.from(origins).join(','));
EOF
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "${DEV_PID:-}" ]]; then
    kill "$DEV_PID" >/dev/null 2>&1 || true
    wait "$DEV_PID" 2>/dev/null || true
  fi

  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for pnpm dev:web-local" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

LOCAL_DATABASE_URL="${DATABASE_URL:-mysql://root:password@127.0.0.1:3306/openwork_den}"
LOCAL_BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-}"

if [[ -z "$LOCAL_BETTER_AUTH_SECRET" ]]; then
  echo "BETTER_AUTH_SECRET must be set in $ENV_FILE (or exported in the shell)." >&2
  exit 1
fi

echo "Starting local MySQL..."
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --wait mysql

echo "Running Den migrations..."
env \
  DATABASE_URL="$LOCAL_DATABASE_URL" \
  BETTER_AUTH_SECRET="$LOCAL_BETTER_AUTH_SECRET" \
  BETTER_AUTH_URL="$LOCAL_BETTER_AUTH_URL" \
  PORT="$LOCAL_DEN_PORT" \
  CORS_ORIGINS="$LOCAL_WEB_ORIGIN" \
  PROVISIONER_MODE="stub" \
  WORKER_URL_TEMPLATE="$LOCAL_WORKER_URL_TEMPLATE" \
  POLAR_FEATURE_GATE_ENABLED="false" \
  pnpm --filter @openwork/den db:migrate

WEB_CORS_ORIGINS="$(detect_web_origins)"
echo "Allowing Better Auth origins: $WEB_CORS_ORIGINS"

echo "Starting Den and web dev servers..."
env \
  DATABASE_URL="$LOCAL_DATABASE_URL" \
  BETTER_AUTH_SECRET="$LOCAL_BETTER_AUTH_SECRET" \
  BETTER_AUTH_URL="$LOCAL_BETTER_AUTH_URL" \
  PORT="$LOCAL_DEN_PORT" \
  CORS_ORIGINS="$WEB_CORS_ORIGINS" \
  PROVISIONER_MODE="stub" \
  WORKER_URL_TEMPLATE="$LOCAL_WORKER_URL_TEMPLATE" \
  POLAR_FEATURE_GATE_ENABLED="false" \
  DEN_API_BASE="$LOCAL_BETTER_AUTH_URL" \
  DEN_AUTH_ORIGIN="$LOCAL_BETTER_AUTH_URL" \
  DEN_AUTH_FALLBACK_BASE="$LOCAL_BETTER_AUTH_URL" \
  NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL="$LOCAL_WEB_ORIGIN" \
  "${DEV_CMD[@]}" &
DEV_PID=$!
wait "$DEV_PID"
