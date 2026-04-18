#!/usr/bin/env bash
#
# One-shot observability for the running openwork dev stack.
# Shows: the dev app's processes, port discovery, server/opencode/router
# health, live tail of pnpm dev + the /dev/log sink file.
#
# Usage:
#   scripts/openwork-debug.sh            # snapshot + probe
#   scripts/openwork-debug.sh tail       # stream logs continuously
#   scripts/openwork-debug.sh sink       # print the dev-log sink path
#   scripts/openwork-debug.sh kill-orphans  # remove orphan openwork/opencode processes (parent == launchd)
#
set -euo pipefail

DEV_LOG_FILE="${OPENWORK_DEV_LOG_FILE:-$HOME/.openwork/debug/openwork-dev.log}"
PNPM_DEV_LOG="/tmp/openwork-test/pnpm-dev.log"

cmd="${1:-snapshot}"

snapshot() {
  echo "=== dev stack processes (target/debug tree) ==="
  ps -Ao pid,ppid,command | awk '/target\/debug\/OpenWork-Dev|target\/debug\/openwork-server|target\/debug\/openwork-orchestrator|target\/debug\/opencode( |\/)|target\/debug\/opencode-router|vite|pnpm dev/ && !/awk/ && !/grep/' | sed -E 's#/Users/[^ ]*/#…/#g' | head -20

  echo
  echo "=== openwork-server ==="
  local port
  port=$(ps -Ao command | grep "target/debug/openwork-server" | grep -v grep | grep -oE '\-\-port [0-9]+' | head -1 | awk '{print $2}')
  if [[ -z "$port" ]]; then
    echo "  (no dev openwork-server running)"
  else
    echo "  port=$port  uptime:"
    curl -sS --max-time 2 "http://127.0.0.1:$port/health" || echo "    unreachable"
    echo
  fi

  echo
  echo "=== opencode (via orchestrator) ==="
  local oc_port
  oc_port=$(ps -Ao command | grep "target/debug/openwork-orchestrator" | grep -v grep | grep -oE '\-\-opencode-port [0-9]+' | head -1 | awk '{print $2}')
  if [[ -z "$oc_port" ]]; then
    echo "  (no opencode port)"
  else
    echo "  port=$oc_port"
    curl -sS --max-time 2 "http://127.0.0.1:$oc_port/app" | head -c 200
    echo
  fi

  echo
  echo "=== opencode-router ==="
  local r_port
  r_port=$(ps -Ao command | grep "target/debug/opencode-router" | grep -v grep | grep -oE '\-\-opencode-url http://127.0.0.1:[0-9]+' | head -1 | awk '{print $2}')
  if [[ -z "$r_port" ]]; then
    echo "  (no opencode-router info)"
  else
    echo "  attached to $r_port"
  fi

  echo
  echo "=== orphans (parent == 1) ==="
  ps -Ao pid,ppid,command | awk '$2 == 1 && $3 ~ /openwork-server|openwork-orchestrator|opencode( |\/)|opencode-router/' | head

  echo
  echo "=== dev log sink ==="
  echo "  path=$DEV_LOG_FILE"
  if [[ -f "$DEV_LOG_FILE" ]]; then
    ls -la "$DEV_LOG_FILE"
    echo "  last 5 entries:"
    tail -5 "$DEV_LOG_FILE"
  else
    echo "  (no sink file yet — run the dev app with OPENWORK_DEV_LOG_FILE set)"
  fi
}

tail_logs() {
  local sources=()
  [[ -f "$PNPM_DEV_LOG" ]] && sources+=("$PNPM_DEV_LOG")
  [[ -f "$DEV_LOG_FILE" ]] && sources+=("$DEV_LOG_FILE")
  if [[ ${#sources[@]} -eq 0 ]]; then
    echo "no log files to tail yet" >&2
    exit 1
  fi
  echo "tailing: ${sources[*]}" >&2
  tail -F "${sources[@]}"
}

case "$cmd" in
  snapshot|"")
    snapshot
    ;;
  tail)
    tail_logs
    ;;
  sink)
    echo "$DEV_LOG_FILE"
    ;;
  kill-orphans)
    PIDS=$(ps -Ao pid,ppid,command | awk '$2 == 1 && $3 ~ /openwork-server|openwork-orchestrator|opencode( |\/)|opencode-router/ {print $1}')
    if [[ -z "$PIDS" ]]; then
      echo "no orphans"
    else
      echo "killing orphans: $PIDS"
      kill $PIDS 2>&1 || true
      sleep 1
      kill -9 $PIDS 2>&1 || true
    fi
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
