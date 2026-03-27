#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/packaging/docker/docker-compose.web-local.yml"
PROJECT_NAME="openwork-web-local"

# Local-dev defaults — match the MySQL container in docker-compose.web-local.yml.
# These are only used when not already set in the environment or .env.
: "${DATABASE_URL:=mysql://root:password@127.0.0.1:3306/openwork_den}"
: "${BETTER_AUTH_SECRET:=local-dev-secret-not-for-production-use!!}"

pick_port() {
  node <<'EOF'
const net = require('net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(String(port));
  server.close();
});
EOF
}

port_is_free() {
  local port="$1"
  node -e "const net=require('net'); const server=net.createServer(); server.once('error',()=>process.exit(1)); server.once('listening',()=>server.close(()=>process.exit(0))); server.listen(${port});"
}

choose_port() {
  local preferred="$1"
  if port_is_free "$preferred"; then
    printf '%s\n' "$preferred"
    return
  fi
  pick_port
}

detect_web_origins() {
  local web_port="$1"
  WEB_PORT="$web_port" node <<'EOF'
const os = require('os');
const port = process.env.WEB_PORT;

const origins = new Set([
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
  `http://0.0.0.0:${port}`,
]);

for (const entries of Object.values(os.networkInterfaces())) {
  for (const entry of entries || []) {
    if (!entry || entry.internal || entry.family !== 'IPv4') continue;
    origins.add(`http://${entry.address}:${port}`);
  }
}

process.stdout.write(Array.from(origins).join(','));
EOF
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  for pid_var in DEN_PID WEB_PID; do
    if [[ -n "${!pid_var:-}" ]]; then
      kill "${!pid_var}" >/dev/null 2>&1 || true
      wait "${!pid_var}" 2>/dev/null || true
    fi
  done

  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for pnpm dev:web-local" >&2
  exit 1
fi

DEN_API_PORT="$(choose_port "${DEN_LOCAL_API_PORT:-8788}")"
DEN_WEB_PORT="$(choose_port "${DEN_LOCAL_WEB_PORT:-3005}")"
DEN_WEB_ORIGIN="http://localhost:${DEN_WEB_PORT}"

: "${BETTER_AUTH_URL:=$DEN_WEB_ORIGIN}"
export DATABASE_URL BETTER_AUTH_SECRET BETTER_AUTH_URL

echo "Starting local MySQL..."
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d --wait mysql

echo "Running Den migrations..."
pnpm --filter @openwork-ee/den-db db:push <<'EOF'
y
EOF

WEB_CORS_ORIGINS="$(detect_web_origins "$DEN_WEB_PORT")"
echo "Allowing Better Auth origins: $WEB_CORS_ORIGINS"

echo "Starting Den and web dev servers..."
echo "Den controller: http://localhost:$DEN_API_PORT"
echo "Den web:        $DEN_WEB_ORIGIN"

(
  cd "$ROOT_DIR/ee/apps/den-controller"
  env \
    OPENWORK_DEV_MODE=1 \
    DATABASE_URL="$DATABASE_URL" \
    BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
    BETTER_AUTH_URL="$BETTER_AUTH_URL" \
    CORS_ORIGINS="$WEB_CORS_ORIGINS" \
    PORT="$DEN_API_PORT" \
    sh -lc 'pnpm run build:den-db && exec pnpm exec tsx watch src/index.ts'
) &
DEN_PID=$!

(
  cd "$ROOT_DIR/ee/apps/den-web"
  env \
    OPENWORK_DEV_MODE=1 \
    NEXT_PUBLIC_POSTHOG_KEY= \
    NEXT_PUBLIC_POSTHOG_API_KEY= \
    DEN_API_BASE="http://127.0.0.1:$DEN_API_PORT" \
    DEN_AUTH_FALLBACK_BASE="http://127.0.0.1:$DEN_API_PORT" \
    DEN_AUTH_ORIGIN="$DEN_WEB_ORIGIN" \
    NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL="$DEN_WEB_ORIGIN" \
    pnpm exec next dev --hostname 0.0.0.0 --port "$DEN_WEB_PORT"
) &
WEB_PID=$!

wait "$DEN_PID" "$WEB_PID"
