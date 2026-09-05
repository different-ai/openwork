#!/usr/bin/env bash
set -euo pipefail

# Start the Den server stack inside a Daytona sandbox.
# Services: MySQL, Den API, and Den Web.

if [ -n "${OPENWORK_WORKSPACE_DIR:-}" ]; then
  REPO_DIR="$OPENWORK_WORKSPACE_DIR"
elif [ -f /workspace/package.json ]; then
  REPO_DIR="/workspace"
else
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

cd "$REPO_DIR"

# Per-test Den env from the eval harness (base64 KEY=VALUE lines, one per
# line). Exported first so a caller's value wins over the defaults below.
if [ -n "${OPENWORK_DEN_EXTRA_ENV_B64:-}" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      [A-Z_]*=*) export "$line" ;;
      *) echo "ERROR: invalid Den env line from OPENWORK_DEN_EXTRA_ENV_B64." >&2; exit 1 ;;
    esac
  done <<EOF_EXTRA_ENV
$(printf %s "$OPENWORK_DEN_EXTRA_ENV_B64" | base64 -d)
EOF_EXTRA_ENV
fi

DEN_API_PORT="${DEN_API_PORT:-8788}"
DEN_WEB_PORT="${DEN_WEB_PORT:-3005}"
PNPM_STORE="${PNPM_STORE:-$REPO_DIR/.openwork-daytona/pnpm-store}"

DEN_API_PUBLIC_URL="${DEN_API_PUBLIC_URL:-http://localhost:$DEN_API_PORT}"
DEN_WEB_PUBLIC_URL="${DEN_WEB_PUBLIC_URL:-http://localhost:$DEN_WEB_PORT}"
DEN_WEB_PUBLIC_HOST="${DEN_WEB_PUBLIC_URL#http://}"
DEN_WEB_PUBLIC_HOST="${DEN_WEB_PUBLIC_HOST#https://}"
DEN_WEB_PUBLIC_HOST="${DEN_WEB_PUBLIC_HOST%%/*}"

export OPENWORK_DEV_MODE="${OPENWORK_DEV_MODE:-1}"
export DEN_ORG_MODE="${DEN_ORG_MODE:-multi_org}"
# Eval sign-ups must not depend on the HIBP API.
export DEN_PASSWORD_BREACH_SCREENING_ENABLED="${DEN_PASSWORD_BREACH_SCREENING_ENABLED:-false}"
export DEN_GENERATED_ARTIFACT_VIEWS_ENABLED="${DEN_GENERATED_ARTIFACT_VIEWS_ENABLED:-false}"
export DATABASE_URL="${DATABASE_URL:-mysql://root:password@127.0.0.1:3306/openwork_den}"
export DEN_DB_ENCRYPTION_KEY="${DEN_DB_ENCRYPTION_KEY:-daytona-den-db-encryption-key-please-change-1234567890}"
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-daytona-den-auth-secret-please-change-1234567890}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-$DEN_WEB_PUBLIC_URL}"
export DEN_BETTER_AUTH_URL="$BETTER_AUTH_URL"
export DEN_API_PUBLIC_URL
export DEN_MCP_RESOURCE_URL="${DEN_MCP_RESOURCE_URL:-$DEN_API_PUBLIC_URL/mcp}"
# DEN_API_BASE is the externally reachable Den API origin (see
# packages/docs/start-here/private-network-deployment.mdx): Den Web publishes
# it through /api/runtime-config as the desktop's denApiUrl. Desktops run in
# other sandboxes and can only reach the public preview URL, never this
# sandbox's loopback.
export DEN_API_BASE="${DEN_API_BASE:-${DEN_API_PUBLIC_URL:-http://127.0.0.1:$DEN_API_PORT}}"
export DEN_AUTH_ORIGIN="${DEN_AUTH_ORIGIN:-$DEN_WEB_PUBLIC_URL}"
export DEN_AUTH_FALLBACK_BASE="${DEN_AUTH_FALLBACK_BASE:-http://127.0.0.1:$DEN_API_PORT}"
export NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL="${NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL:-$DEN_WEB_PUBLIC_URL}"
export DEN_PROVISIONER_MODE="${DEN_PROVISIONER_MODE:-stub}"
export DEN_WORKER_URL_TEMPLATE="${DEN_WORKER_URL_TEMPLATE:-https://workers.local/{workerId}}"
export DEN_WEB_ALLOWED_DEV_ORIGINS="${DEN_WEB_ALLOWED_DEV_ORIGINS:-$DEN_WEB_PUBLIC_HOST}"

DEFAULT_ORIGINS="$DEN_WEB_PUBLIC_URL,$DEN_API_PUBLIC_URL,http://localhost:$DEN_WEB_PORT,http://127.0.0.1:$DEN_WEB_PORT,http://localhost:$DEN_API_PORT,http://127.0.0.1:$DEN_API_PORT"
export CORS_ORIGINS="${CORS_ORIGINS:-$DEFAULT_ORIGINS}"

# Daytona mints a fresh preview hostname on every preview-url call, so any
# origin baked at boot goes stale immediately. Trust the preview proxy domain
# by wildcard (better-auth supports wildcard trusted origins) so rotated
# preview URLs keep working. Local hosts produce no wildcard.
PREVIEW_PROXY_HOST="${DEN_WEB_PUBLIC_URL#http://}"
PREVIEW_PROXY_HOST="${PREVIEW_PROXY_HOST#https://}"
PREVIEW_PROXY_HOST="${PREVIEW_PROXY_HOST%%/*}"
PREVIEW_PROXY_WILDCARD=""
case "$PREVIEW_PROXY_HOST" in
  localhost*|127.*|0.0.0.0*|\[*) ;;
  *.*.*)
    PREVIEW_PROXY_WILDCARD="https://*.${PREVIEW_PROXY_HOST#*.}"
    ;;
esac
# Preview hosts are not app.*: tell den-api the preview domain serves den-web
# so desktop handoff links point at the den-web /api/den proxy.
export DEN_WEB_APP_HOSTS="${DEN_WEB_APP_HOSTS:-${PREVIEW_PROXY_WILDCARD:+.${PREVIEW_PROXY_HOST#*.}}}"
export DEN_BETTER_AUTH_TRUSTED_ORIGINS="${DEN_BETTER_AUTH_TRUSTED_ORIGINS:-$CORS_ORIGINS${PREVIEW_PROXY_WILDCARD:+,$PREVIEW_PROXY_WILDCARD}}"
# The Daytona preview proxy answers CORS itself, reflecting the caller's
# origin on every response. den-api's own headers would then be duplicates,
# which browsers reject, so den-web-in-a-browser could never reach den-api.
export DEN_CORS_HANDLED_BY_EDGE="${DEN_CORS_HANDLED_BY_EDGE:-${PREVIEW_PROXY_WILDCARD:+true}}"

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "ERROR: root privileges are required to start MySQL." >&2
    exit 1
  fi
}

MYSQL_ROOT_CMD=(run_root mysql -uroot)

wait_for_http() {
  local url="$1"
  local label="$2"
  local max_wait="${3:-180}"
  local elapsed=0

  while [ "$elapsed" -lt "$max_wait" ]; do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "==> $label ready after ${elapsed}s"
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done

  echo "ERROR: $label did not become ready at $url" >&2
  return 1
}

echo "==> Starting MySQL..."
run_root service mysql start >/tmp/openwork-mysql-service.log 2>&1 || run_root service mariadb start >/tmp/openwork-mysql-service.log 2>&1

for _ in $(seq 1 60); do
  if mysql -uroot -ppassword -e "SELECT 1" >/dev/null 2>&1; then
    MYSQL_ROOT_CMD=(mysql -uroot -ppassword)
    break
  fi
  if run_root mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
    MYSQL_ROOT_CMD=(run_root mysql -uroot)
    break
  fi
  sleep 2
done

"${MYSQL_ROOT_CMD[@]}" <<'SQL'
CREATE DATABASE IF NOT EXISTS openwork_den;
ALTER USER 'root'@'localhost' IDENTIFIED BY 'password';
CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY 'password';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL

echo "==> Installing dependencies if needed..."
mkdir -p "$PNPM_STORE" .openwork-daytona
baseline=.openwork-daytona/pnpm-lock.sha256
current="$(sha256sum pnpm-lock.yaml | cut -d " " -f 1)"
# The server stack never runs Electron or browser automation; skip their
# binary downloads on reinstalls too.
INSTALL_ENV=(CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 CYPRESS_INSTALL_BINARY=0)
if [ ! -d node_modules ] || [ ! -f "$baseline" ] || [ "$(cat "$baseline")" != "$current" ]; then
  env "${INSTALL_ENV[@]}" pnpm install --store-dir "$PNPM_STORE" --frozen-lockfile \
    || env "${INSTALL_ENV[@]}" pnpm install --store-dir "$PNPM_STORE"
  printf "%s" "$current" > "$baseline"
else
  echo "==> Skipping pnpm install (node_modules present and lockfile unchanged)."
fi

# Content keys for the sandbox-invariant builds baked into the snapshot.
# A build is skipped only when the git trees that feed it and the lockfile
# both match what the snapshot (or a previous boot) built. Snapshots without
# markers, refs that changed those trees, or refs where a tree is missing
# rebuild exactly as before. An empty key never matches and is never stored.
build_key() {
  local trees
  trees="$(git rev-parse "$@" 2>/dev/null)" || return 0
  # Byte-identical to the snapshot bake: one tree hash per line, then the
  # lockfile sha, all newline-terminated.
  printf '%s\n%s\n' "$trees" "$current" | sha256sum | cut -d ' ' -f 1
}

echo "==> Pushing Den DB schema..."
pnpm --filter @openwork-ee/den-db db:push > /tmp/den-db-push.log 2>&1

den_api_assets_marker=.openwork-daytona/den-api-assets.tree
den_api_assets_key="$(build_key HEAD:packages/mcp-apps)"
if [ -n "$den_api_assets_key" ] && [ -d packages/mcp-apps/dist ] && [ -f "$den_api_assets_marker" ] \
  && [ "$(cat "$den_api_assets_marker")" = "$den_api_assets_key" ]; then
  echo "==> Skipping Den API runtime asset build (baked assets match this ref)."
else
  echo "==> Building Den API runtime assets..."
  pnpm --filter @openwork-ee/den-api run build:mcp-apps
  if [ -n "$den_api_assets_key" ]; then
    printf "%s" "$den_api_assets_key" > "$den_api_assets_marker"
  else
    rm -f "$den_api_assets_marker"
  fi
fi

echo "==> Starting Den API on :$DEN_API_PORT..."
# The den-api process cmdline is "tsx watch src/main.ts" (cwd-relative), so a
# pattern anchored on the repo path never matches and restarts silently keep
# the old server alive on the port. main.ts is unique to den-api here.
pkill -f "tsx watch src/main.ts" >/dev/null 2>&1 || true
nohup env \
  PORT="$DEN_API_PORT" \
  DATABASE_URL="$DATABASE_URL" \
  DEN_DB_ENCRYPTION_KEY="$DEN_DB_ENCRYPTION_KEY" \
  BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  BETTER_AUTH_URL="$BETTER_AUTH_URL" \
  DEN_API_PUBLIC_URL="$DEN_API_PUBLIC_URL" \
  DEN_WEB_APP_HOSTS="$DEN_WEB_APP_HOSTS" \
  DEN_MCP_RESOURCE_URL="$DEN_MCP_RESOURCE_URL" \
  DEN_BETTER_AUTH_TRUSTED_ORIGINS="$DEN_BETTER_AUTH_TRUSTED_ORIGINS" \
  CORS_ORIGINS="$CORS_ORIGINS" \
  DEN_BOOTSTRAP_ADMIN_EMAILS="${DEN_BOOTSTRAP_ADMIN_EMAILS:-}" \
  PROVISIONER_MODE="$DEN_PROVISIONER_MODE" \
  WORKER_URL_TEMPLATE="$DEN_WORKER_URL_TEMPLATE" \
  DEN_ORG_MODE="$DEN_ORG_MODE" \
  DEN_PASSWORD_BREACH_SCREENING_ENABLED="$DEN_PASSWORD_BREACH_SCREENING_ENABLED" \
  DEN_GENERATED_ARTIFACT_VIEWS_ENABLED="$DEN_GENERATED_ARTIFACT_VIEWS_ENABLED" \
  OPENWORK_DEV_MODE="$OPENWORK_DEV_MODE" \
  NODE_OPTIONS="--conditions=development" \
  pnpm --filter @openwork-ee/den-api exec tsx watch src/main.ts > /tmp/den-api.log 2>&1 &

wait_for_http "http://127.0.0.1:$DEN_API_PORT/health" "Den API" 180

if [ "${RUN_SEED:-0}" = "1" ]; then
  demo_email="${DEN_DEMO_OWNER_EMAIL:-alex@acme.test}"
  demo_password="${DEN_DEMO_OWNER_PASSWORD:-OpenWorkDemo123!}"
  signin_ok() {
    curl -sf -o /dev/null -X POST "http://127.0.0.1:$DEN_API_PORT/api/auth/sign-in/email" \
      -H 'content-type: application/json' \
      -d "{\"email\":\"$demo_email\",\"password\":\"$demo_password\"}"
  }
  if signin_ok; then
    echo "==> Demo org already present ($demo_email)"
  else
    echo "==> Seeding demo org..."
    (cd ee/apps/den-api && env \
      DATABASE_URL="$DATABASE_URL" \
      DEN_DB_ENCRYPTION_KEY="$DEN_DB_ENCRYPTION_KEY" \
      BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
      BETTER_AUTH_URL="$BETTER_AUTH_URL" \
      DEN_API_PUBLIC_URL="$DEN_API_PUBLIC_URL" \
      DEN_ORG_MODE="$DEN_ORG_MODE" \
      OPENWORK_DEV_MODE=1 \
      DEN_DEMO_SEED_FETCH_GITHUB="${DEN_DEMO_SEED_FETCH_GITHUB:-0}" \
      node --conditions=development --import tsx scripts/seed-demo-org.ts) > /tmp/den-seed.log 2>&1
    if signin_ok; then
      echo "==> Demo org seeded ($demo_email)"
    else
      echo "ERROR: seed completed but $demo_email cannot sign in. See /tmp/den-seed.log" >&2
      tail -40 /tmp/den-seed.log >&2 || true
      exit 1
    fi
  fi
  echo "DEMO_OWNER_READY=$demo_email"
fi

den_web_marker=.openwork-daytona/den-web-build.tree
den_web_key="$(build_key HEAD:packages/ui HEAD:ee/packages/utils HEAD:ee/apps/den-web)"
if [ -n "$den_web_key" ] && [ -d ee/apps/den-web/.next ] && [ -f "$den_web_marker" ] \
  && [ "$(cat "$den_web_marker")" = "$den_web_key" ]; then
  echo "==> Skipping Den Web build (baked build matches this ref)."
else
  # Production build instead of next dev: dev-mode HMR websockets 502 through
  # the preview proxy and block hydration. The build bakes no per-sandbox
  # values (all DEN_* env is consumed at runtime by next start), so a build
  # from the snapshot's base commit is reusable across sandboxes.
  echo "==> Building Den Web..."
  if ! env \
    DEN_WEB_PORT="$DEN_WEB_PORT" \
    DEN_API_BASE="$DEN_API_BASE" \
    DEN_AUTH_ORIGIN="$DEN_AUTH_ORIGIN" \
    DEN_AUTH_FALLBACK_BASE="$DEN_AUTH_FALLBACK_BASE" \
    NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL="$NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL" \
    NEXT_PUBLIC_POSTHOG_KEY= \
    NEXT_PUBLIC_POSTHOG_API_KEY= \
    DEN_ORG_MODE="$DEN_ORG_MODE" \
    OPENWORK_DEV_MODE="$OPENWORK_DEV_MODE" \
    DEN_WEB_ALLOWED_DEV_ORIGINS="$DEN_WEB_ALLOWED_DEV_ORIGINS" \
    bash -c 'pnpm --filter @openwork/ui build && pnpm --filter @openwork-ee/utils build && pnpm --filter @openwork-ee/den-web build' > /tmp/den-web-build.log 2>&1; then
    echo "ERROR: Den Web build failed. Last 80 lines:" >&2
    tail -n 80 /tmp/den-web-build.log >&2
    exit 1
  fi
  if [ -n "$den_web_key" ]; then
    printf "%s" "$den_web_key" > "$den_web_marker"
  else
    rm -f "$den_web_marker"
  fi
fi

echo "==> Starting Den Web on :$DEN_WEB_PORT..."
pkill -f "next dev --hostname 0.0.0.0 --port $DEN_WEB_PORT" >/dev/null 2>&1 || true
pkill -f "next start --hostname 0.0.0.0 --port $DEN_WEB_PORT" >/dev/null 2>&1 || true
nohup env \
  DEN_WEB_PORT="$DEN_WEB_PORT" \
  DEN_API_BASE="$DEN_API_BASE" \
  DEN_AUTH_ORIGIN="$DEN_AUTH_ORIGIN" \
  DEN_AUTH_FALLBACK_BASE="$DEN_AUTH_FALLBACK_BASE" \
  NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL="$NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL" \
  NEXT_PUBLIC_POSTHOG_KEY= \
  NEXT_PUBLIC_POSTHOG_API_KEY= \
  DEN_ORG_MODE="$DEN_ORG_MODE" \
  OPENWORK_DEV_MODE="$OPENWORK_DEV_MODE" \
  DEN_WEB_ALLOWED_DEV_ORIGINS="$DEN_WEB_ALLOWED_DEV_ORIGINS" \
  pnpm --filter @openwork-ee/den-web exec next start --hostname 0.0.0.0 --port "$DEN_WEB_PORT" > /tmp/den-web.log 2>&1 &

wait_for_http "http://127.0.0.1:$DEN_WEB_PORT/api/den/health" "Den Web" 180

cat > .openwork-daytona/server-env <<EOF
DEN_API_URL=$DEN_API_PUBLIC_URL
DEN_WEB_URL=$DEN_WEB_PUBLIC_URL
BETTER_AUTH_URL=$BETTER_AUTH_URL
DEN_MCP_RESOURCE_URL=$DEN_MCP_RESOURCE_URL
DEN_PROVISIONER_MODE=$DEN_PROVISIONER_MODE
EOF

echo ""
echo "============================================"
echo "  OpenWork Daytona server stack ready"
echo ""
echo "  Den Web:       $DEN_WEB_PUBLIC_URL"
echo "  Den API:       $DEN_API_PUBLIC_URL"
echo ""
echo "  Logs:"
echo "    /tmp/den-api.log"
echo "    /tmp/den-web.log"
echo "    /tmp/den-db-push.log"
echo "============================================"
