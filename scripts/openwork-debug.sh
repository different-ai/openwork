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
#   diagnose-hang   classify Electron crash/hang/sidecar/app-state failures
#   stop            full, layered teardown of the dev stack (no cache wipe)
#   start           launch pnpm dev in the background with the log sink on
#   wait-healthy    block until openwork-server reports /health = 200
#   reset           stop + wipe Vite dep cache + truncate log sink + start
#   restart         alias for reset
#
# Variant (OPENWORK_DEV_VARIANT):
#   electron   (default) pnpm --filter @openwork/desktop dev:electron
#              Electron shell + CDP on 127.0.0.1:9823 for chrome-devtools MCP.
#              Sidecars run from apps/desktop/src-tauri/sidecars/*.
#   tauri      legacy: pnpm dev (Tauri dev webview, no CDP).
#              Sidecars run from apps/desktop/src-tauri/target/debug/*.
#
# Teardown ordering (important, both variants):
#   1. pnpm dev / dev:electron supervisor  (parent supervisor)
#   2. tauri dev                           (Rust dev runner, if still alive)
#   3. Tauri webview       (target/debug/OpenWork-Dev)  <-- never /Applications/
#   4. Electron main+helpers (node_modules/electron/...Electron.app)
#   5. Vite                (node node_modules/.../vite)
#   6. orchestrator + openwork-server + opencode + opencode-router
#      (both target/debug/* and src-tauri/sidecars/* trees)
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
ELECTRON_CDP_PORT="${OPENWORK_ELECTRON_REMOTE_DEBUG_PORT:-9823}"

# Dev variant. 'electron' (default) launches pnpm dev:electron with CDP on
# 127.0.0.1:9823 so chrome-devtools MCP can attach. 'tauri' preserves the
# legacy pnpm dev (Tauri webview) for users still on that path.
DEV_VARIANT="${OPENWORK_DEV_VARIANT:-electron}"
case "$DEV_VARIANT" in electron|tauri) ;; *)
  printf '[openwork-debug] unknown OPENWORK_DEV_VARIANT=%s (expected electron|tauri)\n' "$DEV_VARIANT" >&2
  exit 2
  ;;
esac

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
  ps -Ao command \
    | grep -E "(target/debug|apps/desktop/src-tauri/sidecars)/openwork-server" \
    | grep -v grep \
    | grep -oE '\-\-port [0-9]+' \
    | head -1 \
    | awk '{print $2}' \
    || true
}

electron_renderer_stats() {
  ps -axo pid,ppid,pcpu,pmem,rss,command \
    | awk '/Electron Helper \(Renderer\)/ && /com\.differentai\.openwork/ && !/awk/ && !/grep/ {print; found=1} END {exit found ? 0 : 1}' \
    || true
}

electron_renderer_pid() {
  electron_renderer_stats | awk 'NR == 1 {print $1}'
}

electron_renderer_cpu() {
  electron_renderer_stats | awk 'NR == 1 {print $3}'
}

probe_electron_page_cdp() {
  node <<'NODE'
const port = process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT || "9823";
const controller = new AbortController();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const timeout = setTimeout(() => controller.abort(), 1800);
let targets;
try {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
  targets = await response.json();
} catch (error) {
  clearTimeout(timeout);
  fail(`target-list-failed: ${error instanceof Error ? error.message : String(error)}`);
}
clearTimeout(timeout);
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) fail("no-page-target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let settled = false;
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  try { ws.close(); } catch {}
  fail("page-cdp-timeout");
}, 2200);
ws.onopen = () => {
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1+1", returnByValue: true } }));
};
ws.onerror = () => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  fail("page-cdp-websocket-error");
};
ws.onmessage = (event) => {
  try {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    settled = true;
    clearTimeout(timer);
    try { ws.close(); } catch {}
    if (message.error) fail(`page-cdp-error: ${message.error.message ?? JSON.stringify(message.error)}`);
    console.log("ok");
    process.exit(0);
  } catch (error) {
    settled = true;
    clearTimeout(timer);
    fail(`page-cdp-parse-error: ${error instanceof Error ? error.message : String(error)}`);
  }
};
NODE
}

# ---------------------------------------------------------------------------
# Public subcommands

snapshot() {
  echo "=== dev stack processes ==="
  ps -Ao pid,ppid,command | awk '/target\/debug\/OpenWork-Dev|node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron|apps\/desktop\/scripts\/electron-dev\.mjs|target\/debug\/openwork-server|target\/debug\/openwork-orchestrator|target\/debug\/opencode( |\/)|target\/debug\/opencode-router|apps\/desktop\/src-tauri\/sidecars\/openwork-server|apps\/desktop\/src-tauri\/sidecars\/openwork-orchestrator|apps\/desktop\/src-tauri\/sidecars\/opencode( |\/)|apps\/desktop\/src-tauri\/sidecars\/opencode-router|vite|pnpm .*dev/ && !/awk/ && !/grep/' | sed -E 's#/Users/[^ ]*/#…/#g' | head -20

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
  oc_port=$(ps -Ao command \
    | grep -E "(target/debug|apps/desktop/src-tauri/sidecars)/openwork-orchestrator" \
    | grep -v grep \
    | grep -oE '\-\-opencode-port [0-9]+' \
    | head -1 \
    | awk '{print $2}' \
    || true)
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
  r_port=$(ps -Ao command \
    | grep -E "(target/debug|apps/desktop/src-tauri/sidecars)/opencode-router" \
    | grep -v grep \
    | grep -oE '\-\-opencode-url http://127.0.0.1:[0-9]+' \
    | head -1 \
    | awk '{print $2}' \
    || true)
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

diagnose_hang() {
  local now
  now=$(date "+%Y-%m-%dT%H:%M:%S%z")
  echo "=== openwork hang diagnosis ==="
  echo "time=$now"
  echo "repo=$REPO_ROOT"
  echo "cdp=http://127.0.0.1:$ELECTRON_CDP_PORT"
  echo

  echo "=== browser CDP ==="
  local browser_json target_json
  browser_json=$(curl -sS --max-time 2 "http://127.0.0.1:$ELECTRON_CDP_PORT/json/version" 2>&1 || true)
  if [[ "$browser_json" == *"webSocketDebuggerUrl"* ]]; then
    echo "  browser: responsive"
    printf '%s\n' "$browser_json" | sed -n '1,8p'
  else
    echo "  browser: not reachable"
    printf '  %s\n' "$browser_json"
  fi

  echo
  echo "=== page target ==="
  target_json=$(curl -sS --max-time 2 "http://127.0.0.1:$ELECTRON_CDP_PORT/json/list" 2>&1 || true)
  if [[ "$target_json" == *"webSocketDebuggerUrl"* ]]; then
    printf '%s\n' "$target_json" | sed -n '1,20p'
  else
    echo "  no page target (or target list failed)"
    printf '  %s\n' "$target_json"
  fi

  echo
  echo "=== renderer process ==="
  local renderer_stats renderer_pid renderer_cpu
  renderer_stats=$(electron_renderer_stats)
  renderer_pid=$(printf '%s\n' "$renderer_stats" | awk 'NR == 1 {print $1}')
  renderer_cpu=$(printf '%s\n' "$renderer_stats" | awk 'NR == 1 {print $3}')
  if [[ -n "$renderer_pid" ]]; then
    echo "  renderer: alive"
    echo "  PID PPID %CPU %MEM RSS COMMAND"
    printf '  %s\n' "$renderer_stats" | sed -E 's#/Users/[^ ]*/#…/#g'
  else
    echo "  renderer: missing"
  fi

  echo
  echo "=== page CDP probe ==="
  local page_probe="skipped"
  if [[ "$browser_json" == *"webSocketDebuggerUrl"* && "$target_json" == *"webSocketDebuggerUrl"* ]]; then
    if page_probe=$(OPENWORK_ELECTRON_REMOTE_DEBUG_PORT="$ELECTRON_CDP_PORT" probe_electron_page_cdp 2>&1); then
      echo "  page: responsive ($page_probe)"
      page_probe="ok"
    else
      echo "  page: unresponsive ($page_probe)"
      page_probe="failed"
    fi
  else
    echo "  page: skipped (browser or page target unavailable)"
  fi

  echo
  echo "=== classification ==="
  local high_cpu="false"
  if [[ -n "${renderer_cpu:-}" ]]; then
    high_cpu=$(awk -v cpu="$renderer_cpu" 'BEGIN {print (cpu + 0 >= 80) ? "true" : "false"}')
  fi
  if [[ "$browser_json" != *"webSocketDebuggerUrl"* ]]; then
    echo "  no-electron-cdp: Electron is down or was not launched with CDP."
  elif [[ "$target_json" == *"webSocketDebuggerUrl"* && -z "$renderer_pid" ]]; then
    echo "  renderer-crashed: browser CDP advertises a page but no renderer process exists."
    echo "  next: inspect latest macOS .ips crash report below."
  elif [[ -n "$renderer_pid" && "$page_probe" == "failed" && "$high_cpu" == "true" ]]; then
    echo "  renderer-hung-hot: renderer exists, page CDP timed out, CPU >= 80%."
    echo "  next: use the sample captured below; logs will usually stop once wedged."
  elif [[ -n "$renderer_pid" && "$page_probe" == "failed" ]]; then
    echo "  renderer-unresponsive: renderer exists but page CDP timed out."
    echo "  next: sample + check memory/CPU; could be blocked main thread or native stall."
  elif [[ -n "$renderer_pid" && "$page_probe" == "ok" ]]; then
    echo "  renderer-responsive: likely app-state or sidecar/API issue, not a renderer hang."
  else
    echo "  unknown: insufficient signal."
  fi

  echo
  echo "=== latest crash report ==="
  local crash
  crash=$(ls -t "$HOME"/Library/Logs/DiagnosticReports/*"Electron Helper (Renderer)"*.ips 2>/dev/null | head -1 || true)
  if [[ -n "$crash" ]]; then
    ls -la "$crash"
    sed -n '1,55p' "$crash" 2>/dev/null | sed -n '1,25p'
  else
    echo "  no Electron renderer .ips crash report found"
  fi

  echo
  echo "=== sidecar health ==="
  local port
  port=$(discover_openwork_server_port)
  if [[ -n "$port" ]]; then
    echo "  openwork-server port=$port"
    curl -sS --max-time 2 "http://127.0.0.1:$port/health" || echo "unreachable"
    echo
  else
    echo "  no openwork-server port discovered"
  fi

  echo
  echo "=== recent dev sink ==="
  echo "  path=$DEV_LOG_FILE"
  if [[ -f "$DEV_LOG_FILE" ]]; then
    ls -la "$DEV_LOG_FILE"
    tail -40 "$DEV_LOG_FILE"
  else
    echo "  missing"
  fi

  echo
  echo "=== recent pnpm log ==="
  echo "  path=$PNPM_DEV_LOG"
  if [[ -f "$PNPM_DEV_LOG" ]]; then
    ls -la "$PNPM_DEV_LOG"
    tail -80 "$PNPM_DEV_LOG"
  else
    echo "  missing"
  fi

  echo
  echo "=== renderer sample ==="
  if [[ -n "$renderer_pid" && ( "$page_probe" == "failed" || "$high_cpu" == "true" ) ]]; then
    local sample_file="/tmp/openwork-renderer-${renderer_pid}-$(date +%Y%m%dT%H%M%S).sample.txt"
    if sample "$renderer_pid" 3 -file "$sample_file" >/dev/null 2>&1; then
      echo "  captured=$sample_file"
      grep -n "Thread_.*CrRendererMain\|Call graph:\|Physical footprint" "$sample_file" | head -20 || true
    else
      echo "  sample failed for pid=$renderer_pid"
    fi
  elif [[ -n "$renderer_pid" ]]; then
    echo "  skipped (renderer responsive and CPU not high). Set OPENWORK_FORCE_SAMPLE=1 not currently supported."
  else
    echo "  skipped (no renderer process to sample)."
  fi
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

  # 2b. Electron variant supervisor (scripts/electron-dev.mjs). Idempotent if
  #     the current variant is tauri; harmless if nothing matches.
  kill_by_pattern "apps/desktop/scripts/electron-dev\.mjs"

  # 3. Tauri dev webview — match full path so the installed /Applications/
  #    prod bundle is never targeted.
  kill_by_pattern "target/debug/OpenWork-Dev"

  # 3b. Electron main (the helpers die with the main via mach-port rendezvous
  #     loss; we still pattern-match them below in case a crash left orphans).
  #     Scoped to this repo's node_modules/electron so /Applications/Slack,
  #     Cursor, VSCode, etc. are never touched.
  kill_by_pattern "node_modules/electron/dist/Electron\.app/Contents/MacOS/Electron"

  # 4. Vite. Match the node process that loads the vite binary from this
  #    repo's node_modules, not any arbitrary node process on the host.
  kill_by_pattern "node_modules/\.bin/vite"
  kill_by_pattern "node_modules/vite/bin/vite\.js"

  # 5. openwork-server / orchestrator / opencode / opencode-router for the
  #    current dev build. These are the longest-lived children and the ones
  #    most likely to orphan after an unclean shutdown.
  #    Tauri dev runs them from target/debug/, Electron dev runs them from
  #    src-tauri/sidecars/ — kill both trees, both are idempotent.
  kill_by_pattern "target/debug/openwork-server"
  kill_by_pattern "target/debug/openwork-orchestrator"
  kill_by_pattern "target/debug/opencode"
  kill_by_pattern "target/debug/opencode-router"
  kill_by_pattern "apps/desktop/src-tauri/sidecars/openwork-server"
  kill_by_pattern "apps/desktop/src-tauri/sidecars/openwork-orchestrator"
  kill_by_pattern "apps/desktop/src-tauri/sidecars/opencode( |/)"
  kill_by_pattern "apps/desktop/src-tauri/sidecars/opencode-router"

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

  cd "$REPO_ROOT"
  local pid
  case "$DEV_VARIANT" in
    electron)
      log "starting pnpm dev:electron (variant=electron, log sink: $DEV_LOG_FILE, CDP: 127.0.0.1:9823)"
      env OPENWORK_DEV_LOG_FILE="$DEV_LOG_FILE" \
        nohup pnpm --filter @openwork/desktop dev:electron >"$PNPM_DEV_LOG" 2>&1 &
      pid=$!
      ;;
    tauri)
      log "starting pnpm dev (variant=tauri, log sink: $DEV_LOG_FILE)"
      env OPENWORK_DEV_LOG_FILE="$DEV_LOG_FILE" \
        nohup pnpm dev >"$PNPM_DEV_LOG" 2>&1 &
      pid=$!
      ;;
  esac
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
  case "$DEV_VARIANT" in
    electron)
      log "reset complete (variant=electron) — Electron CDP should be up at"
      log "http://127.0.0.1:9823; chrome-devtools MCP can attach there."
      log "If the window looks stale, Cmd+Shift+R to drop its Vite module cache."
      ;;
    tauri)
      log "reset complete — now reload the Tauri webview (Cmd+Shift+R) to drop"
      log "its in-memory module cache and pick up the fresh Vite."
      ;;
  esac
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
  diagnose-hang)
    diagnose_hang
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
