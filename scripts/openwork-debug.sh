#!/usr/bin/env bash
#
# openwork-debug.sh — one-stop observability + lifecycle control for the
# OpenWork dev stack.
#
# Subcommands:
#   snapshot        (default) processes, ports, health, orphans, sink preview
#   status          same as snapshot
#   tail            live tail pnpm dev + the /dev/log sink
#   sink            print the dev log sink path
#   kill-orphans    remove orphan openwork/opencode processes (ppid == launchd)
#   stop            full, layered teardown of the dev stack (no cache wipe)
#   start           launch pnpm dev in the background with the log sink on
#   wait-healthy    block until openwork-server reports /health = 200
#   reset           stop + wipe Vite dep cache + truncate log sink + start
#   restart         alias for reset
#
# Teardown ordering (important):
#   1. pnpm dev          (parent supervisor)
#   2. tauri dev         (Rust dev runner, if still alive)
#   3. Tauri webview     (target/debug/OpenWork-Dev)  <-- never /Applications/
#   4. Vite              (node node_modules/.../vite)
#   5. orchestrator + openwork-server + opencode + opencode-router orphans
#
# Cache/ephemeral state wiped by `reset`:
#   - Vite dep pre-bundle cache: apps/app/node_modules/.vite
#   - Vite metadata cache:        node_modules/.vite (root, if present)
#   - dev log sink file (truncated, not deleted)
#
# Explicitly NOT touched by `reset`:
#   - ~/Library/Application Support/com.differentai.openwork.dev/** (tokens,
#     workspaces registry, prefs). Use `reset-webview` for WebKit state.
#   - /Applications/OpenWork.app (prod build never targeted).
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config

REPO_ROOT="${REPO_ROOT:-}"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
fi
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fi

DEV_LOG_FILE="${OPENWORK_DEV_LOG_FILE:-$HOME/.openwork/debug/openwork-dev.log}"
PNPM_DEV_LOG="${OPENWORK_PNPM_DEV_LOG:-/tmp/openwork-test/pnpm-dev.log}"
PNPM_DEV_PID_FILE="${OPENWORK_PNPM_DEV_PID:-/tmp/openwork-test/pnpm-dev.pid}"
WAIT_HEALTHY_SECS="${OPENWORK_WAIT_HEALTHY_SECS:-90}"

# ---------------------------------------------------------------------------
# Helpers

log() { printf '[openwork-debug] %s\n' "$*"; }

kill_by_pattern() {
  # Sends TERM then KILL to every process whose full command line matches the
  # given regex. Used for targeted teardown of things like the Tauri dev
  # webview (matched by its target/debug path, so prod OpenWork.app is safe).
  local pattern="$1"
  local pids
  pids=$(pgrep -f "$pattern" || true)
  if [[ -z "$pids" ]]; then
    return 0
  fi
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  pids=$(pgrep -f "$pattern" || true)
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
}

kill_pid_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local pid
  pid=$(tr -d '\n' <"$file" || true)
  rm -f "$file" 2>/dev/null || true
  [[ -z "$pid" ]] && return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  fi
}

discover_openwork_server_port() {
  ps -Ao command | grep "target/debug/openwork-server" | grep -v grep \
    | grep -oE '\-\-port [0-9]+' | head -1 | awk '{print $2}'
}

# ---------------------------------------------------------------------------
# Public subcommands

snapshot() {
  echo "=== dev stack processes (target/debug tree) ==="
  ps -Ao pid,ppid,command | awk '/target\/debug\/OpenWork-Dev|target\/debug\/openwork-server|target\/debug\/openwork-orchestrator|target\/debug\/opencode( |\/)|target\/debug\/opencode-router|vite|pnpm dev/ && !/awk/ && !/grep/' | sed -E 's#/Users/[^ ]*/#…/#g' | head -20

  echo
  echo "=== openwork-server ==="
  local port
  port=$(discover_openwork_server_port)
  if [[ -z "$port" ]]; then
    echo "  (no dev openwork-server running)"
  else
    echo "  port=$port  health:"
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

kill_orphans() {
  local pids
  pids=$(ps -Ao pid,ppid,command | awk '$2 == 1 && $3 ~ /openwork-server|openwork-orchestrator|opencode( |\/)|opencode-router/ {print $1}')
  if [[ -z "$pids" ]]; then
    log "no orphans"
    return 0
  fi
  log "killing orphans: $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}

# Ordered teardown. Safe to run when nothing is up; each step is idempotent.
stop() {
  log "stopping dev stack (layered)"

  # 1. pnpm dev: prefer the PID file we wrote at start-time so we match the
  #    exact process tree for this stack, not some unrelated pnpm run.
  kill_pid_file "$PNPM_DEV_PID_FILE"

  # Also catch any other pnpm dev supervisor that might be running against
  # this repo (e.g. started by a different terminal before the PID file
  # existed). The cwd match keeps us from touching pnpm runs in other repos.
  kill_by_pattern "pnpm .*dev"

  # 2. tauri dev (node bin). Tauri CLI supervises its own child processes.
  kill_by_pattern "tauri(-cli)? +dev"
  kill_by_pattern "@tauri-apps/cli"

  # 3. Tauri dev webview — match full path so the installed /Applications/
  #    prod bundle is never targeted.
  kill_by_pattern "target/debug/OpenWork-Dev"

  # 4. Vite. Match the node process that loads the vite binary from this
  #    repo's node_modules, not any arbitrary node process on the host.
  kill_by_pattern "node_modules/\.bin/vite"
  kill_by_pattern "node_modules/vite/bin/vite\.js"

  # 5. openwork-server / orchestrator / opencode / opencode-router for the
  #    current dev build. These are the longest-lived children and the ones
  #    most likely to orphan after an unclean shutdown.
  kill_by_pattern "target/debug/openwork-server"
  kill_by_pattern "target/debug/openwork-orchestrator"
  kill_by_pattern "target/debug/opencode"
  kill_by_pattern "target/debug/opencode-router"

  # Safety net for stragglers we don't own directly.
  kill_orphans

  sleep 1
  log "stop complete"
  echo
  snapshot | sed -n '1,20p'
}

start() {
  mkdir -p "$(dirname -- "$DEV_LOG_FILE")" "$(dirname -- "$PNPM_DEV_LOG")" "$(dirname -- "$PNPM_DEV_PID_FILE")"

  if [[ -f "$PNPM_DEV_PID_FILE" ]]; then
    local prev
    prev=$(tr -d '\n' <"$PNPM_DEV_PID_FILE" || true)
    if [[ -n "$prev" ]] && kill -0 "$prev" 2>/dev/null; then
      log "pnpm dev already running (pid=$prev); run 'stop' or 'reset' first"
      return 0
    fi
  fi

  log "starting pnpm dev (log sink: $DEV_LOG_FILE)"
  cd "$REPO_ROOT"
  env OPENWORK_DEV_LOG_FILE="$DEV_LOG_FILE" \
    nohup pnpm dev >"$PNPM_DEV_LOG" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" >"$PNPM_DEV_PID_FILE"
  log "pnpm dev pid=$pid"
}

wait_healthy() {
  local deadline=$((SECONDS + WAIT_HEALTHY_SECS))
  while (( SECONDS < deadline )); do
    local port
    port=$(discover_openwork_server_port)
    if [[ -n "$port" ]]; then
      local code
      code=$(curl -sS --max-time 2 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/health" 2>/dev/null || true)
      if [[ "$code" == "200" ]]; then
        log "openwork-server healthy on :$port"
        return 0
      fi
    fi
    sleep 1
  done
  log "openwork-server did not become healthy within ${WAIT_HEALTHY_SECS}s" >&2
  return 1
}

reset() {
  stop

  log "wiping Vite caches"
  # Vite pre-bundled deps. Almost always the culprit when a pull doesn't take.
  rm -rf "$REPO_ROOT/apps/app/node_modules/.vite" 2>/dev/null || true
  # Root-level vite metadata cache if the workspace uses one.
  rm -rf "$REPO_ROOT/node_modules/.vite" 2>/dev/null || true
  # Also clear any transformed-module cache the Tauri dev window might keep.
  rm -rf "$REPO_ROOT/apps/desktop/node_modules/.vite" 2>/dev/null || true

  log "truncating dev log sink"
  mkdir -p "$(dirname -- "$DEV_LOG_FILE")"
  : >"$DEV_LOG_FILE"

  start
  wait_healthy || true
  echo
  snapshot | sed -n '1,20p'
  echo
  log "reset complete — now reload the Tauri webview (Cmd+Shift+R) to drop"
  log "its in-memory module cache and pick up the fresh Vite."
}

reset_webview_state() {
  # Destructive: clears the desktop dev app's WebKit LocalStorage so stale
  # URL overrides / tokens don't leak across code changes. Does NOT touch
  # the openwork-workspaces.json registry or server-side tokens.
  local webkit_dir="$HOME/Library/WebKit/com.differentai.openwork.dev"
  if [[ ! -d "$webkit_dir" ]]; then
    log "no dev WebKit dir found at $webkit_dir"
    return 0
  fi
  log "clearing dev WebKit WebsiteData under $webkit_dir (you may need to restart the app)"
  rm -rf "$webkit_dir/WebsiteData" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Dispatcher

cmd="${1:-snapshot}"

case "$cmd" in
  snapshot|status|"")
    snapshot
    ;;
  tail)
    tail_logs
    ;;
  sink)
    echo "$DEV_LOG_FILE"
    ;;
  kill-orphans)
    kill_orphans
    ;;
  stop)
    stop
    ;;
  start)
    start
    ;;
  wait-healthy)
    wait_healthy
    ;;
  reset|restart)
    reset
    ;;
  reset-webview)
    reset_webview_state
    ;;
  help|-h|--help)
    grep -E '^#( |$)' "$0" | sed -E 's/^# ?//'
    ;;
  *)
    echo "unknown command: $cmd" >&2
    echo "try: $0 help" >&2
    exit 1
    ;;
esac
