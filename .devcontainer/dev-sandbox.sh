#!/usr/bin/env bash
set -euo pipefail

# Start the OpenWork desktop dev stack inside a Daytona/devcontainer sandbox.
# This is the sandbox equivalent of `pnpm dev`: it prepares the virtual display
# and launches the desktop dev runner in the background with CDP enabled.

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  printf '%s\n' \
    "Usage: pnpm dev:sandbox" \
    "" \
    "Starts the OpenWork desktop dev stack inside a Daytona/devcontainer sandbox." \
    "Use .devcontainer/test-on-daytona.sh [branch-or-commit] to provision a new Daytona sandbox."
  exit 0
fi

if [ "$#" -gt 0 ]; then
  echo "Unexpected argument: $1" >&2
  echo "Use --help for usage." >&2
  exit 1
fi

if [ -n "${OPENWORK_WORKSPACE_DIR:-}" ]; then
  REPO_DIR="$OPENWORK_WORKSPACE_DIR"
elif [ -f /workspace/package.json ]; then
  REPO_DIR="/workspace"
else
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

cd "$REPO_DIR"
export OPENWORK_WORKSPACE_DIR="$REPO_DIR"
export OPENWORK_DEV_MODE="${OPENWORK_DEV_MODE:-1}"
export DISPLAY="${DISPLAY:-:99}"
export ELECTRON_DISABLE_SANDBOX="${ELECTRON_DISABLE_SANDBOX:-1}"
export OPENWORK_REACT_DEVTOOLS="${OPENWORK_REACT_DEVTOOLS:-0}"
export OPENWORK_ELECTRON_REMOTE_DEBUG_PORT="${OPENWORK_ELECTRON_REMOTE_DEBUG_PORT:-9825}"
export DAYTONA_ELECTRON_EXTRA_LAUNCH_ARGS="${DAYTONA_ELECTRON_EXTRA_LAUNCH_ARGS:---disable-gpu --disable-dev-shm-usage --enable-unsafe-swiftshader}"

VNC_SCRIPT="$REPO_DIR/.devcontainer/start-daytona-vnc.sh"
ELECTRON_SCRIPT="$REPO_DIR/.devcontainer/start-daytona-electron.sh"

echo "==> Starting Daytona display stack..."
bash "$VNC_SCRIPT"

echo "==> Starting OpenWork dev stack in background..."
bash "$ELECTRON_SCRIPT" --detach

echo "==> Waiting for Electron CDP on :$OPENWORK_ELECTRON_REMOTE_DEBUG_PORT..."
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$OPENWORK_ELECTRON_REMOTE_DEBUG_PORT/json/list" >/dev/null 2>&1; then
    echo "OpenWork sandbox dev stack is ready."
    echo "Electron log: /tmp/electron.log"
    exit 0
  fi
  sleep 5
done

echo "ERROR: Electron CDP did not become ready." >&2
echo "Check logs with: tail -80 /tmp/electron.log" >&2
exit 1
