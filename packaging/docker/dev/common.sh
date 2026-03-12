#!/usr/bin/env bash
set -euo pipefail

OPENWORK_RUNTIME_DIR="${OPENWORK_RUNTIME_DIR:-/runtime}"
OPENWORK_RUNTIME_ENV_FILE="${OPENWORK_RUNTIME_ENV_FILE:-$OPENWORK_RUNTIME_DIR/dev.env}"
OPENWORK_DOCKER_DEBUG="${OPENWORK_DOCKER_DEBUG:-0}"

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

docker_debug_enabled() {
  read_bool "$OPENWORK_DOCKER_DEBUG"
}

log_line() {
  local component="$1"
  local message="$2"
  printf '[openwork-docker:%s] %s\n' "$component" "$message"
}

ensure_runtime_dir() {
  mkdir -p "$OPENWORK_RUNTIME_DIR"
}

print_debug_context() {
  local component="$1"

  if ! docker_debug_enabled; then
    return 0
  fi

  log_line "$component" "debug mode enabled"
  log_line "$component" "node $(node --version)"
  log_line "$component" "bun $(bun --version)"
  log_line "$component" "pnpm $(pnpm --version)"
  log_line "$component" "runtime dir $OPENWORK_RUNTIME_DIR"
  log_line "$component" "workspace ${OPENWORK_WORKSPACE:-/workspace}"
}

wait_for_file() {
  local path="$1"
  local timeout_seconds="$2"
  local started_at
  started_at="$(date +%s)"

  while [ ! -f "$path" ]; do
    if [ $(( $(date +%s) - started_at )) -ge "$timeout_seconds" ]; then
      return 1
    fi
    sleep 1
  done

  return 0
}
