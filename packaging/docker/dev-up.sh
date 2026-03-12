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
mkdir -p "$DEV_RUNTIME_DIR"

OPENCODE_CONFIG_FALLBACK_DIR="$DEV_RUNTIME_DIR/host-opencode-config"
OPENCODE_DATA_FALLBACK_DIR="$DEV_RUNTIME_DIR/host-opencode-data"
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
if [ "$MOUNT_HOST_OPENCODE" = "1" ]; then
  echo "- Host OpenCode import: enabled" >&2
else
  echo "- Host OpenCode import: disabled (isolated dev state)" >&2
fi

start_stack() {
  local config_dir="$1"
  local data_dir="$2"
  OPENWORK_DEV_ID="$DEV_ID" OPENWORK_PORT="$OPENWORK_PORT" WEB_PORT="$WEB_PORT" \
    OPENWORK_DEV_MODE="1" \
    OPENWORK_HOST_OPENCODE_CONFIG_DIR="$config_dir" \
    OPENWORK_HOST_OPENCODE_DATA_DIR="$data_dir" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d
}

ACTIVE_OPENCODE_CONFIG_DIR="$HOST_OPENCODE_CONFIG_DIR"
ACTIVE_OPENCODE_DATA_DIR="$HOST_OPENCODE_DATA_DIR"

echo "- OPENWORK_HOST_OPENCODE_CONFIG_DIR=$ACTIVE_OPENCODE_CONFIG_DIR" >&2
echo "- OPENWORK_HOST_OPENCODE_DATA_DIR=$ACTIVE_OPENCODE_DATA_DIR" >&2

if ! start_stack "$ACTIVE_OPENCODE_CONFIG_DIR" "$ACTIVE_OPENCODE_DATA_DIR"; then
  if [ "$ACTIVE_OPENCODE_CONFIG_DIR" != "$OPENCODE_CONFIG_FALLBACK_DIR" ] || [ "$ACTIVE_OPENCODE_DATA_DIR" != "$OPENCODE_DATA_FALLBACK_DIR" ]; then
    echo "Detected host OpenCode config mount failed; retrying with empty fallback dirs." >&2
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down >/dev/null 2>&1 || true
    ACTIVE_OPENCODE_CONFIG_DIR="$OPENCODE_CONFIG_FALLBACK_DIR"
    ACTIVE_OPENCODE_DATA_DIR="$OPENCODE_DATA_FALLBACK_DIR"
    echo "- OPENWORK_HOST_OPENCODE_CONFIG_DIR=$ACTIVE_OPENCODE_CONFIG_DIR" >&2
    echo "- OPENWORK_HOST_OPENCODE_DATA_DIR=$ACTIVE_OPENCODE_DATA_DIR" >&2
    start_stack "$ACTIVE_OPENCODE_CONFIG_DIR" "$ACTIVE_OPENCODE_DATA_DIR"
  else
    exit 1
  fi
fi

echo "" >&2
echo "OpenWork web UI:     http://localhost:$WEB_PORT" >&2
echo "OpenWork server:     http://localhost:$OPENWORK_PORT" >&2
echo "Token file:          $ROOT_DIR/tmp/.dev-env-$DEV_ID" >&2
echo "" >&2
echo "To stop this stack:" >&2
echo "  docker compose -p $PROJECT -f $COMPOSE_FILE down" >&2
