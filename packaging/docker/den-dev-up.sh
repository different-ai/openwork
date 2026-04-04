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
#
# Notes:
# - This script auto-generates a Better Auth secret per run.
# - It also uses a premade dev-only DB encryption key unless you override
#   DEN_DB_ENCRYPTION_KEY yourself.
# - Generate a replacement with: openssl rand -base64 128

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

detect_tailscale_dns_name() {
  if ! command -v tailscale >/dev/null 2>&1; then
    return 1
  fi

  tailscale status --json 2>/dev/null | node -e '
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        const value = (parsed?.Self?.DNSName || "").replace(/\.$/, "").trim();
        if (!value) process.exit(1);
        process.stdout.write(value);
      } catch {
        process.exit(1);
      }
    });
  '
}

detect_public_host() {
  if [ -n "${DEN_PUBLIC_HOST:-}" ]; then
    printf '%s\n' "$DEN_PUBLIC_HOST"
    return
  fi

  local lan_ipv4
  lan_ipv4="$(detect_lan_ipv4 || true)"
  if [ -n "$lan_ipv4" ]; then
    printf '%s\n' "$lan_ipv4"
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

append_origin() {
  local value="$1"
  [ -n "$value" ] || return 0
  if [ -z "${DEN_CORS_ORIGINS:-}" ]; then
    DEN_CORS_ORIGINS="$value"
    return 0
  fi
  case ",${DEN_CORS_ORIGINS}," in
    *",${value},"*) ;;
    *) DEN_CORS_ORIGINS="${DEN_CORS_ORIGINS},${value}" ;;
  esac
}

DEV_ID="$(node -e "console.log(require('crypto').randomUUID().slice(0, 8))")"
PROJECT="openwork-den-dev-$DEV_ID"
DEN_WATCH_OTP_CODES="${DEN_WATCH_OTP_CODES:-1}"

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

PUBLIC_HOST="$(detect_public_host)"
LAN_IPV4="$(detect_lan_ipv4 || true)"
TAILSCALE_DNS_NAME="$(detect_tailscale_dns_name || true)"

DEN_BETTER_AUTH_SECRET="${DEN_BETTER_AUTH_SECRET:-$(random_hex 32)}"
DEN_DB_ENCRYPTION_KEY="${DEN_DB_ENCRYPTION_KEY:-dev-den-db-encryption-key-please-change-1234567890}"
DEN_BETTER_AUTH_URL="${DEN_BETTER_AUTH_URL:-http://$PUBLIC_HOST:$DEN_WEB_PORT}"
DEN_PROVISIONER_MODE="${DEN_PROVISIONER_MODE:-stub}"
DEN_WORKER_URL_TEMPLATE="${DEN_WORKER_URL_TEMPLATE:-https://workers.local/{workerId}}"
DEN_DAYTONA_WORKER_PROXY_BASE_URL="${DEN_DAYTONA_WORKER_PROXY_BASE_URL:-http://$PUBLIC_HOST:$DEN_WORKER_PROXY_PORT}"
DEN_CORS_ORIGINS="${DEN_CORS_ORIGINS:-http://localhost:$DEN_WEB_PORT,http://127.0.0.1:$DEN_WEB_PORT,http://0.0.0.0:$DEN_WEB_PORT,http://localhost:$DEN_API_PORT,http://127.0.0.1:$DEN_API_PORT}"
append_origin "http://$PUBLIC_HOST:$DEN_WEB_PORT"
append_origin "http://$PUBLIC_HOST:$DEN_API_PORT"
append_origin "http://$PUBLIC_HOST:$DEN_WORKER_PROXY_PORT"
if [ -n "$LAN_IPV4" ]; then
  append_origin "http://$LAN_IPV4:$DEN_WEB_PORT"
  append_origin "http://$LAN_IPV4:$DEN_API_PORT"
  append_origin "http://$LAN_IPV4:$DEN_WORKER_PROXY_PORT"
fi
DEN_BETTER_AUTH_TRUSTED_ORIGINS="${DEN_BETTER_AUTH_TRUSTED_ORIGINS:-$DEN_CORS_ORIGINS}"

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

start_otp_log_watch() {
  if [ "$DEN_WATCH_OTP_CODES" != "1" ]; then
    return
  fi

  (
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs -f --since=1s den 2>&1 | while IFS= read -r line; do
      case "$line" in
        *"[auth] dev verification code for "*)
          if [[ "$line" == *" | "* ]]; then
            line="${line#* | }"
          fi
          printf '\n[den otp] %s\n' "$line" >&2
          ;;
      esac
    done
  ) &

  OTP_LOG_PID=$!
}

cat > "$RUNTIME_FILE" <<EOF
PROJECT=$PROJECT
DEN_API_PORT=$DEN_API_PORT
DEN_WEB_PORT=$DEN_WEB_PORT
DEN_WORKER_PROXY_PORT=$DEN_WORKER_PROXY_PORT
DEN_MYSQL_PORT=$DEN_MYSQL_PORT
DEN_API_URL=http://localhost:$DEN_API_PORT
DEN_WEB_URL=http://localhost:$DEN_WEB_PORT
DEN_WORKER_PROXY_URL=http://localhost:$DEN_WORKER_PROXY_PORT
DEN_API_PUBLIC_URL=http://$PUBLIC_HOST:$DEN_API_PORT
DEN_WEB_PUBLIC_URL=http://$PUBLIC_HOST:$DEN_WEB_PORT
DEN_WORKER_PROXY_PUBLIC_URL=http://$PUBLIC_HOST:$DEN_WORKER_PROXY_PORT
DEN_MYSQL_URL=mysql://root:password@127.0.0.1:$DEN_MYSQL_PORT/openwork_den
DEN_BETTER_AUTH_URL=$DEN_BETTER_AUTH_URL
DEN_DB_ENCRYPTION_KEY=$DEN_DB_ENCRYPTION_KEY
COMPOSE_FILE=$COMPOSE_FILE
DEN_WATCH_OTP_CODES=$DEN_WATCH_OTP_CODES
EOF

echo "Starting Docker Compose project: $PROJECT" >&2
echo "- DEN_API_PORT=$DEN_API_PORT" >&2
echo "- DEN_WEB_PORT=$DEN_WEB_PORT" >&2
echo "- DEN_WORKER_PROXY_PORT=$DEN_WORKER_PROXY_PORT" >&2
echo "- DEN_MYSQL_PORT=$DEN_MYSQL_PORT" >&2
echo "- DEN_BETTER_AUTH_URL=$DEN_BETTER_AUTH_URL" >&2
echo "- DEN_DB_ENCRYPTION_KEY=[set] (dev default unless overridden)" >&2
echo "- DEN_PROVISIONER_MODE=$DEN_PROVISIONER_MODE" >&2
echo "- OTP verification codes will stream back to this terminal" >&2
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
  DEN_DB_ENCRYPTION_KEY="$DEN_DB_ENCRYPTION_KEY" \
  DEN_BETTER_AUTH_URL="$DEN_BETTER_AUTH_URL" \
  DEN_CORS_ORIGINS="$DEN_CORS_ORIGINS" \
  DEN_BETTER_AUTH_TRUSTED_ORIGINS="$DEN_BETTER_AUTH_TRUSTED_ORIGINS" \
  DEN_PROVISIONER_MODE="$DEN_PROVISIONER_MODE" \
  DEN_WORKER_URL_TEMPLATE="$DEN_WORKER_URL_TEMPLATE" \
  DEN_DAYTONA_WORKER_PROXY_BASE_URL="$DEN_DAYTONA_WORKER_PROXY_BASE_URL" \
  DAYTONA_API_URL="${DAYTONA_API_URL:-}" \
  DAYTONA_API_KEY="${DAYTONA_API_KEY:-}" \
  DAYTONA_TARGET="${DAYTONA_TARGET:-}" \
  DAYTONA_SNAPSHOT="${DAYTONA_SNAPSHOT:-}" \
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build --wait; then
  echo "Den Docker stack failed to start. Recent logs:" >&2
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs --tail=200 >&2 || true
  exit 1
fi

OTP_LOG_PID=""
start_otp_log_watch

if [ -n "$OTP_LOG_PID" ]; then
  printf 'OTP_LOG_PID=%s\n' "$OTP_LOG_PID" >> "$RUNTIME_FILE"
fi

echo "" >&2
echo "OpenWork Cloud web UI:  http://localhost:$DEN_WEB_PORT" >&2
echo "OpenWork Cloud web UI (LAN/public): http://$PUBLIC_HOST:$DEN_WEB_PORT" >&2
if [ -n "$LAN_IPV4" ]; then
  echo "OpenWork Cloud web UI (LAN IP):     http://$LAN_IPV4:$DEN_WEB_PORT" >&2
fi
if [ -n "$TAILSCALE_DNS_NAME" ]; then
  echo "OpenWork Cloud web UI (Tailscale):  http://$TAILSCALE_DNS_NAME:$DEN_WEB_PORT" >&2
fi
echo "Den demo/API:          http://localhost:$DEN_API_PORT" >&2
echo "Den demo/API (LAN/public):         http://$PUBLIC_HOST:$DEN_API_PORT" >&2
if [ -n "$LAN_IPV4" ]; then
  echo "Den demo/API (LAN IP):             http://$LAN_IPV4:$DEN_API_PORT" >&2
fi
if [ -n "$TAILSCALE_DNS_NAME" ]; then
  echo "Den demo/API (Tailscale):          http://$TAILSCALE_DNS_NAME:$DEN_API_PORT" >&2
fi
echo "Worker proxy:          http://localhost:$DEN_WORKER_PROXY_PORT" >&2
echo "Worker proxy (LAN/public):         http://$PUBLIC_HOST:$DEN_WORKER_PROXY_PORT" >&2
if [ -n "$LAN_IPV4" ]; then
  echo "Worker proxy (LAN IP):             http://$LAN_IPV4:$DEN_WORKER_PROXY_PORT" >&2
fi
if [ -n "$TAILSCALE_DNS_NAME" ]; then
  echo "Worker proxy (Tailscale):          http://$TAILSCALE_DNS_NAME:$DEN_WORKER_PROXY_PORT" >&2
fi
echo "MySQL:                 mysql://root:password@127.0.0.1:$DEN_MYSQL_PORT/openwork_den" >&2
echo "Health check:          http://localhost:$DEN_API_PORT/health" >&2
echo "Runtime env file:      $RUNTIME_FILE" >&2
if [ -n "$OTP_LOG_PID" ]; then
  echo "OTP watch:             active in this terminal (PID $OTP_LOG_PID)" >&2
  echo "Stop OTP watch only:   kill $OTP_LOG_PID" >&2
  echo "                        export DEN_WATCH_OTP_CODES=0 to disable" >&2
fi
echo "" >&2
echo "To stop this stack (keep DB data):" >&2
echo "  docker compose -p $PROJECT -f $COMPOSE_FILE down" >&2
echo "To stop and reset the DB:" >&2
echo "  docker compose -p $PROJECT -f $COMPOSE_FILE down -v" >&2
