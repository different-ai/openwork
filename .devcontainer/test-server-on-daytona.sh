#!/usr/bin/env bash
set -euo pipefail

# test-server-on-daytona.sh — one-command Daytona Den server sandbox.
#
# Usage:
#   bash .devcontainer/test-server-on-daytona.sh [branch-or-commit]
#   bash .devcontainer/test-server-on-daytona.sh [branch-or-commit] --force-install
#
# Creates a Daytona sandbox, starts MySQL + Den API + Den Web + worker proxy,
# waits for health checks, and prints public preview URLs.

REF=""
FORCE_INSTALL=0
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="openwork-server-$(date +%Y%m%d-%H%M%S)"
DAYTONA_SERVER_SNAPSHOT="${DAYTONA_SERVER_SNAPSHOT:-openwork-server}"
DAYTONA_TARGET="${DAYTONA_TARGET:-us}"
DEN_API_PORT="${DEN_API_PORT:-8788}"
DEN_WEB_PORT="${DEN_WEB_PORT:-3005}"
DEN_WORKER_PROXY_PORT="${DEN_WORKER_PROXY_PORT:-8789}"
MAX_WAIT="${DAYTONA_SERVER_MAX_WAIT:-240}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force-install)
      FORCE_INSTALL=1
      ;;
    --snapshot)
      shift
      DAYTONA_SERVER_SNAPSHOT="${1:?missing snapshot name}"
      ;;
    --name)
      shift
      SANDBOX="${1:?missing sandbox name}"
      ;;
    --help|-h)
      sed -n '1,13p' "$0"
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      if [ -n "$REF" ]; then
        echo "Unexpected extra argument: $1" >&2
        exit 1
      fi
      REF="$1"
      ;;
  esac
  shift
done

if [ -z "$REF" ]; then
  REF="$(git branch --show-current 2>/dev/null || true)"
  REF="${REF:-$(git rev-parse HEAD)}"
fi

snapshot_id() {
  daytona snapshot list -f json | node -e 'const name = process.argv[1]; let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const snapshot = JSON.parse(input).find((item) => item.name === name); if (snapshot) process.stdout.write(snapshot.id || snapshot.name); });' "$1"
}

SNAPSHOT_ID="$(snapshot_id "$DAYTONA_SERVER_SNAPSHOT")"
CREATE_ARGS=(--name "$SANDBOX" --auto-stop 60 --public --target "$DAYTONA_TARGET")
if [ -n "$SNAPSHOT_ID" ]; then
  echo "==> Using Daytona server snapshot: $DAYTONA_SERVER_SNAPSHOT"
  CREATE_ARGS+=(--snapshot "$SNAPSHOT_ID")
else
  echo "==> Daytona server snapshot '$DAYTONA_SERVER_SNAPSHOT' not found; building from Dockerfile."
  CREATE_ARGS+=(--dockerfile "$ROOT_DIR/.devcontainer/Dockerfile.daytona-server" --cpu 4 --memory 8 --disk 10)
fi

echo "==> Creating server sandbox: $SANDBOX"
echo "    Ref: $REF"
daytona create "${CREATE_ARGS[@]}"

echo "==> Waiting for sandbox exec readiness..."
exec_ready=0
for _ in $(seq 1 60); do
  if daytona exec "$SANDBOX" -- "bash -lc 'true'" >/dev/null 2>&1; then
    exec_ready=1
    break
  fi
  sleep 5
done
if [ "$exec_ready" -ne 1 ]; then
  echo "ERROR: sandbox did not become exec-ready" >&2
  exit 1
fi

DEN_WEB_URL="$(daytona preview-url "$SANDBOX" -p "$DEN_WEB_PORT" 2>/dev/null | grep -v "^time=")"
DEN_API_URL="$(daytona preview-url "$SANDBOX" -p "$DEN_API_PORT" 2>/dev/null | grep -v "^time=")"
DEN_WORKER_PROXY_URL="$(daytona preview-url "$SANDBOX" -p "$DEN_WORKER_PROXY_PORT" 2>/dev/null | grep -v "^time=")"

echo "==> Checking out $REF..."
daytona exec "$SANDBOX" -- "bash -lc 'set -euo pipefail; cd /workspace; REF=\"$REF\"; FORCE_INSTALL=\"$FORCE_INSTALL\"; if git fetch origin \"\$REF\"; then git checkout --detach FETCH_HEAD; else git fetch origin dev --depth 50 || true; git checkout \"\$REF\"; fi; git rev-parse --short HEAD; if [ \"\$FORCE_INSTALL\" = 1 ]; then rm -f .openwork-daytona/pnpm-lock.sha256; fi'"

echo "==> Uploading server start script..."
START_SCRIPT_B64="$(base64 < "$ROOT_DIR/.devcontainer/start-daytona-server.sh" | tr -d '\n')"
daytona exec "$SANDBOX" -- "bash -lc 'set -euo pipefail; cd /workspace; mkdir -p .devcontainer; printf %s $START_SCRIPT_B64 | base64 -d > .devcontainer/start-daytona-server.sh; chmod +x .devcontainer/start-daytona-server.sh'"

echo "==> Starting OpenWork Den server stack..."
daytona exec "$SANDBOX" -- "bash -lc 'set -euo pipefail; cd /workspace; DEN_WEB_PUBLIC_URL=\"$DEN_WEB_URL\" DEN_API_PUBLIC_URL=\"$DEN_API_URL\" DEN_WORKER_PROXY_PUBLIC_URL=\"$DEN_WORKER_PROXY_URL\" DEN_WEB_PORT=$DEN_WEB_PORT DEN_API_PORT=$DEN_API_PORT DEN_WORKER_PROXY_PORT=$DEN_WORKER_PROXY_PORT bash .devcontainer/start-daytona-server.sh'"

echo "==> Waiting for public Den Web health (up to ${MAX_WAIT}s)..."
elapsed=0
while [ "$elapsed" -lt "$MAX_WAIT" ]; do
  if curl -sf "$DEN_WEB_URL/api/den/health" >/dev/null 2>&1; then
    echo "    Den Web ready after ${elapsed}s."
    break
  fi
  sleep 5
  elapsed=$((elapsed + 5))
  printf "    %ds...\r" "$elapsed"
done

if [ "$elapsed" -ge "$MAX_WAIT" ]; then
  echo ""
  echo "WARNING: Den Web did not become ready within ${MAX_WAIT}s." >&2
  echo "Check logs:" >&2
  echo "  daytona exec $SANDBOX -- 'tail -120 /tmp/den-api.log'" >&2
  echo "  daytona exec $SANDBOX -- 'tail -120 /tmp/den-web.log'" >&2
  echo "  daytona exec $SANDBOX -- 'tail -120 /tmp/den-worker-proxy.log'" >&2
  exit 1
fi

echo ""
echo "============================================"
echo "  Server sandbox ready: $SANDBOX"
echo ""
echo "  Den Web:       $DEN_WEB_URL"
echo "  Den API:       $DEN_API_URL"
echo "  Worker Proxy:  $DEN_WORKER_PROXY_URL"
echo ""
echo "  Start Electron against this server:"
echo "    bash .devcontainer/test-on-daytona.sh $REF --den-base-url $DEN_WEB_URL --den-api-base-url $DEN_API_URL"
echo ""
echo "  Cleanup:"
echo "    daytona delete $SANDBOX"
echo "============================================"
