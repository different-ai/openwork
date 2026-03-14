#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/packaging/docker/docker-compose.web-local.yml"
PROJECT_NAME="openwork-web-local"
DEV_CMD=(pnpm --parallel --filter @openwork/den --filter @different-ai/openwork-web dev)

# Local-dev defaults — match the MySQL container in docker-compose.web-local.yml.
# These are only used when not already set in the environment or .env.
: "${DATABASE_URL:=mysql://root:password@127.0.0.1:3306/openwork_den}"
: "${BETTER_AUTH_SECRET:=local-dev-secret-not-for-production-use!!}"
: "${BETTER_AUTH_URL:=http://localhost:8788}"
export DATABASE_URL BETTER_AUTH_SECRET BETTER_AUTH_URL

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

echo "Starting local MySQL..."
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --wait mysql

echo "Running Den migrations..."
pnpm --filter @openwork/den db:migrate

WEB_CORS_ORIGINS="$(detect_web_origins)"
echo "Allowing Better Auth origins: $WEB_CORS_ORIGINS"

echo "Starting Den and web dev servers..."
env CORS_ORIGINS="$WEB_CORS_ORIGINS" "${DEV_CMD[@]}" &
DEV_PID=$!
wait "$DEV_PID"
