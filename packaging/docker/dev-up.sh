#!/usr/bin/env bash
set -euo pipefail

# Bring up a dev stack with random host ports.
#
# Usage (from _repos/openwork repo root):
#   packaging/docker/dev-up.sh
#
# Defaults to isolated OpenCode dev state inside the container.
# Escape hatch: set OPENWORK_DOCKER_DEV_MOUNT_HOST_OPENCODE=1 to import host
# OpenCode config/auth into the isolated dev state for this stack.
#
# Outputs:
# - Web UI URL
# - OpenWork server URL
# - Token file path

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/packaging/docker/docker-compose.dev.yml"
WORKSPACE_DIR="$ROOT_DIR/packaging/docker/workspace"
DEV_RUNTIME_DIR="$ROOT_DIR/tmp/docker-dev"
MOUNT_HOST_OPENCODE="${OPENWORK_DOCKER_DEV_MOUNT_HOST_OPENCODE:-0}"
DOCKER_DEBUG="${OPENWORK_DOCKER_DEBUG:-0}"
DOCKER_SKIP_BUILD="${OPENWORK_DOCKER_SKIP_BUILD:-0}"

resolve_opencode_config_dir() {
  local override="${OPENWORK_OPENCODE_CONFIG_DIR:-}"
  if [ -n "$override" ]; then
    if [ -d "$override" ]; then
      printf '%s\n' "$override"
      return 0
    fi
    echo "warning: OPENWORK_OPENCODE_CONFIG_DIR is not a directory: $override" >&2
  fi

  local candidates=()
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then
    candidates+=("${XDG_CONFIG_HOME}/opencode")
  fi
  candidates+=("${HOME}/.config/opencode")
  if [ "$(uname -s)" = "Darwin" ]; then
    candidates+=("${HOME}/Library/Application Support/opencode")
  fi

  local files=("opencode.jsonc" "opencode.json" "config.json" "AGENTS.md")
  local candidate file
  for candidate in "${candidates[@]}"; do
    [ -d "$candidate" ] || continue
    for file in "${files[@]}"; do
      if [ -f "$candidate/$file" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
    if [ -n "$(ls -A "$candidate" 2>/dev/null)" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

resolve_opencode_data_dir() {
  local override="${OPENWORK_OPENCODE_DATA_DIR:-}"
  if [ -n "$override" ]; then
    if [ -d "$override" ]; then
      printf '%s\n' "$override"
      return 0
    fi
    echo "warning: OPENWORK_OPENCODE_DATA_DIR is not a directory: $override" >&2
  fi

  local candidates=()
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    candidates+=("${XDG_DATA_HOME}/opencode")
  fi
  candidates+=("${HOME}/.local/share/opencode")
  if [ "$(uname -s)" = "Darwin" ]; then
    candidates+=("${HOME}/Library/Application Support/opencode")
  fi

  local files=("auth.json" "mcp-auth.json")
  local candidate file
  for candidate in "${candidates[@]}"; do
    [ -d "$candidate" ] || continue
    for file in "${files[@]}"; do
      if [ -f "$candidate/$file" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  done

  return 1
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is required" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not reachable. Start Docker Desktop/OrbStack and retry." >&2
  exit 1
fi

read_bool() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

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
RUN_DIR="$DEV_RUNTIME_DIR/$DEV_ID"
TOKEN_FILE="$RUN_DIR/dev.env"
STACK_INFO_FILE="$RUN_DIR/stack-info.txt"

mkdir -p "$WORKSPACE_DIR"
mkdir -p "$DEV_RUNTIME_DIR"
mkdir -p "$RUN_DIR"

OPENCODE_CONFIG_FALLBACK_DIR="$RUN_DIR/host-opencode-config"
OPENCODE_DATA_FALLBACK_DIR="$RUN_DIR/host-opencode-data"
mkdir -p "$OPENCODE_CONFIG_FALLBACK_DIR" "$OPENCODE_DATA_FALLBACK_DIR"

HOST_OPENCODE_CONFIG_DIR="$OPENCODE_CONFIG_FALLBACK_DIR"
HOST_OPENCODE_DATA_DIR="$OPENCODE_DATA_FALLBACK_DIR"

if [ "$MOUNT_HOST_OPENCODE" = "1" ]; then
  HOST_OPENCODE_CONFIG_DIR="$(resolve_opencode_config_dir || true)"
  HOST_OPENCODE_DATA_DIR="$(resolve_opencode_data_dir || true)"

  if [ -z "$HOST_OPENCODE_CONFIG_DIR" ]; then
    HOST_OPENCODE_CONFIG_DIR="$OPENCODE_CONFIG_FALLBACK_DIR"
  fi
  if [ -z "$HOST_OPENCODE_DATA_DIR" ]; then
    HOST_OPENCODE_DATA_DIR="$OPENCODE_DATA_FALLBACK_DIR"
  fi
fi

OPENWORK_PORT="$(pick_port)"
WEB_PORT="$(pick_port)"
if [ "$WEB_PORT" = "$OPENWORK_PORT" ]; then
  WEB_PORT="$(pick_port)"
fi

echo "Starting Docker Compose project: $PROJECT" >&2
echo "- OPENWORK_PORT=$OPENWORK_PORT" >&2
echo "- WEB_PORT=$WEB_PORT" >&2
echo "- OPENWORK_DEV_MODE=1" >&2
echo "- OPENWORK_RUNTIME_DIR=$RUN_DIR" >&2
if read_bool "$DOCKER_SKIP_BUILD"; then
  echo "- Docker image build: skipped" >&2
else
  echo "- Docker image build: enabled" >&2
fi
if read_bool "$DOCKER_DEBUG"; then
  echo "- Docker debug mode: enabled" >&2
else
  echo "- Docker debug mode: disabled" >&2
fi
if [ "$MOUNT_HOST_OPENCODE" = "1" ]; then
  echo "- Host OpenCode import: enabled" >&2
else
  echo "- Host OpenCode import: disabled (isolated dev state)" >&2
fi

OPENWORK_VERBOSE_VALUE="0"
if read_bool "$DOCKER_DEBUG"; then
  OPENWORK_VERBOSE_VALUE="1"
fi

compose() {
  OPENWORK_DEV_ID="$DEV_ID" OPENWORK_PORT="$OPENWORK_PORT" WEB_PORT="$WEB_PORT" \
    OPENWORK_DEV_MODE="1" \
    OPENWORK_RUNTIME_DIR="$RUN_DIR" \
    OPENWORK_DOCKER_DEBUG="$DOCKER_DEBUG" \
    OPENWORK_LOG_FORMAT="${OPENWORK_LOG_FORMAT:-pretty}" \
    OPENWORK_VERBOSE="$OPENWORK_VERBOSE_VALUE" \
    OPENWORK_HOST_OPENCODE_CONFIG_DIR="$ACTIVE_OPENCODE_CONFIG_DIR" \
    OPENWORK_HOST_OPENCODE_DATA_DIR="$ACTIVE_OPENCODE_DATA_DIR" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

compose_build() {
  local progress_mode="${1:-}"
  if [ -n "$progress_mode" ]; then
    OPENWORK_DEV_ID="$DEV_ID" OPENWORK_PORT="$OPENWORK_PORT" WEB_PORT="$WEB_PORT" \
      OPENWORK_DEV_MODE="1" \
      OPENWORK_RUNTIME_DIR="$RUN_DIR" \
      OPENWORK_DOCKER_DEBUG="$DOCKER_DEBUG" \
      OPENWORK_LOG_FORMAT="${OPENWORK_LOG_FORMAT:-pretty}" \
      OPENWORK_VERBOSE="$OPENWORK_VERBOSE_VALUE" \
      OPENWORK_HOST_OPENCODE_CONFIG_DIR="$ACTIVE_OPENCODE_CONFIG_DIR" \
      OPENWORK_HOST_OPENCODE_DATA_DIR="$ACTIVE_OPENCODE_DATA_DIR" \
      docker compose --progress "$progress_mode" -p "$PROJECT" -f "$COMPOSE_FILE" build
    return
  fi

  OPENWORK_DEV_ID="$DEV_ID" OPENWORK_PORT="$OPENWORK_PORT" WEB_PORT="$WEB_PORT" \
    OPENWORK_DEV_MODE="1" \
    OPENWORK_RUNTIME_DIR="$RUN_DIR" \
    OPENWORK_DOCKER_DEBUG="$DOCKER_DEBUG" \
    OPENWORK_LOG_FORMAT="${OPENWORK_LOG_FORMAT:-pretty}" \
    OPENWORK_VERBOSE="$OPENWORK_VERBOSE_VALUE" \
    OPENWORK_HOST_OPENCODE_CONFIG_DIR="$ACTIVE_OPENCODE_CONFIG_DIR" \
    OPENWORK_HOST_OPENCODE_DATA_DIR="$ACTIVE_OPENCODE_DATA_DIR" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" build
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local timeout_seconds="${3:-180}"
  local started_at
  started_at="$(date +%s)"

  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi

    if [ $(( $(date +%s) - started_at )) -ge "$timeout_seconds" ]; then
      echo "Timed out waiting for $label at $url" >&2
      return 1
    fi

    sleep 2
  done
}

collect_debug_snapshot() {
  compose ps > "$RUN_DIR/compose-ps.txt" 2>&1 || true
  compose logs --no-color > "$RUN_DIR/compose-logs.txt" 2>&1 || true

  local orchestrator_id
  local web_id
  orchestrator_id="$(compose ps -q orchestrator 2>/dev/null || true)"
  web_id="$(compose ps -q web 2>/dev/null || true)"

  if [ -n "$orchestrator_id" ]; then
    docker inspect "$orchestrator_id" > "$RUN_DIR/orchestrator.inspect.json" 2>/dev/null || true
  fi
  if [ -n "$web_id" ]; then
    docker inspect "$web_id" > "$RUN_DIR/web.inspect.json" 2>/dev/null || true
  fi

  curl -fsS "http://localhost:$OPENWORK_PORT/health" > "$RUN_DIR/openwork-health.txt" 2>/dev/null || true
  curl -fsS "http://localhost:$OPENWORK_PORT/status" > "$RUN_DIR/openwork-status.json" 2>/dev/null || true
}

write_stack_info() {
  cat > "$STACK_INFO_FILE" <<EOF
project=$PROJECT
compose_file=$COMPOSE_FILE
run_dir=$RUN_DIR
openwork_url=http://localhost:$OPENWORK_PORT
web_url=http://localhost:$WEB_PORT
token_file=$TOKEN_FILE
logs_command=docker compose -p $PROJECT -f $COMPOSE_FILE logs -f
down_command=docker compose -p $PROJECT -f $COMPOSE_FILE down
EOF
}

on_start_failure() {
  echo "Docker stack failed to become ready." >&2
  compose ps >&2 || true
  compose logs --tail=200 >&2 || true
  collect_debug_snapshot
  echo "Debug artifacts: $RUN_DIR" >&2
}

start_stack() {
  if ! read_bool "$DOCKER_SKIP_BUILD"; then
    echo "Building Docker dev image from the current checkout..." >&2
    if read_bool "$DOCKER_DEBUG"; then
      compose_build plain || return 1
    else
      compose_build || return 1
    fi
  fi

  compose up -d --remove-orphans || return 1
}

ACTIVE_OPENCODE_CONFIG_DIR="$HOST_OPENCODE_CONFIG_DIR"
ACTIVE_OPENCODE_DATA_DIR="$HOST_OPENCODE_DATA_DIR"

echo "- OPENWORK_HOST_OPENCODE_CONFIG_DIR=$ACTIVE_OPENCODE_CONFIG_DIR" >&2
echo "- OPENWORK_HOST_OPENCODE_DATA_DIR=$ACTIVE_OPENCODE_DATA_DIR" >&2

if ! start_stack "$ACTIVE_OPENCODE_CONFIG_DIR" "$ACTIVE_OPENCODE_DATA_DIR"; then
  if [ "$ACTIVE_OPENCODE_CONFIG_DIR" != "$OPENCODE_CONFIG_FALLBACK_DIR" ] || [ "$ACTIVE_OPENCODE_DATA_DIR" != "$OPENCODE_DATA_FALLBACK_DIR" ]; then
    echo "Detected host OpenCode config mount failed; retrying with empty fallback dirs." >&2
    compose down >/dev/null 2>&1 || true
    ACTIVE_OPENCODE_CONFIG_DIR="$OPENCODE_CONFIG_FALLBACK_DIR"
    ACTIVE_OPENCODE_DATA_DIR="$OPENCODE_DATA_FALLBACK_DIR"
    echo "- OPENWORK_HOST_OPENCODE_CONFIG_DIR=$ACTIVE_OPENCODE_CONFIG_DIR" >&2
    echo "- OPENWORK_HOST_OPENCODE_DATA_DIR=$ACTIVE_OPENCODE_DATA_DIR" >&2
    if ! start_stack "$ACTIVE_OPENCODE_CONFIG_DIR" "$ACTIVE_OPENCODE_DATA_DIR"; then
      on_start_failure
      exit 1
    fi
  else
    on_start_failure
    exit 1
  fi
fi

write_stack_info

if ! wait_for_http "http://localhost:$OPENWORK_PORT/health" "OpenWork health" 180; then
  on_start_failure
  exit 1
fi

if ! wait_for_http "http://localhost:$WEB_PORT/" "OpenWork web UI" 180; then
  on_start_failure
  exit 1
fi

if read_bool "$DOCKER_DEBUG"; then
  collect_debug_snapshot
fi

echo "" >&2
echo "OpenWork web UI:     http://localhost:$WEB_PORT" >&2
echo "OpenWork server:     http://localhost:$OPENWORK_PORT" >&2
echo "Token file:          $TOKEN_FILE" >&2
echo "Run metadata:        $STACK_INFO_FILE" >&2
if read_bool "$DOCKER_DEBUG"; then
  echo "Debug artifacts:     $RUN_DIR" >&2
fi
echo "" >&2
echo "To stop this stack:" >&2
echo "  docker compose -p $PROJECT -f $COMPOSE_FILE down" >&2
