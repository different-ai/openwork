#!/usr/bin/env bash
set -euo pipefail

# test-on-daytona.sh — one-command Daytona Electron test sandbox
#
# Usage:
#   bash .devcontainer/test-on-daytona.sh [branch-or-commit]
#   bash .devcontainer/test-on-daytona.sh [branch-or-commit] --force-install
#   bash .devcontainer/test-on-daytona.sh [branch-or-commit] --artifacts-volume
#   bash .devcontainer/test-on-daytona.sh [branch-or-commit] --record-video
#   bash .devcontainer/setup-daytona-secrets-volume.sh [.newtoken]
#
# Creates a Daytona sandbox from the reusable VNC snapshot, checks out the given
# ref, installs dependencies with a workspace-local pnpm store when needed,
# starts `pnpm dev:sandbox`, and prints CDP/noVNC URLs. Optionally mounts an
# artifacts volume and records the Electron display.

REF=""
FORCE_INSTALL=0
DEN_BASE_URL=""
DEN_API_BASE_URL=""
DEN_REQUIRE_SIGNIN=0
ARTIFACTS_ENABLED=0
RECORD_VIDEO=0
RECORDING_NAME=""
RECORDING_FPS="15"
RECORDING_SIZE="1920x1080"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force-install)
      FORCE_INSTALL=1
      ;;
    --snapshot)
      shift
      DAYTONA_EVAL_SNAPSHOT="${1:?missing snapshot name}"
      ;;
    --den-base-url)
      shift
      DEN_BASE_URL="${1:?missing Den base URL}"
      ;;
    --den-api-base-url)
      shift
      DEN_API_BASE_URL="${1:?missing Den API base URL}"
      ;;
    --require-signin)
      DEN_REQUIRE_SIGNIN=1
      ;;
    --artifacts-volume)
      ARTIFACTS_ENABLED=1
      ;;
    --record-video)
      ARTIFACTS_ENABLED=1
      RECORD_VIDEO=1
      ;;
    --recording-name)
      shift
      RECORDING_NAME="${1:?missing recording name}"
      ;;
    --recording-fps)
      shift
      RECORDING_FPS="${1:?missing recording fps}"
      ;;
    --recording-size)
      shift
      RECORDING_SIZE="${1:?missing recording size}"
      ;;
    --help|-h)
      sed -n '1,16p' "$0"
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

SANDBOX="openwork-test-$(date +%Y%m%d-%H%M%S)"
CDP_PORT=9825
NOVNC_PORT=6080
ARTIFACTS_PORT=8090
MAX_WAIT=90
DAYTONA_EVAL_SNAPSHOT="${DAYTONA_EVAL_SNAPSHOT:-openwork-eval-vnc}"
DAYTONA_SECRETS_VOLUME="${DAYTONA_SECRETS_VOLUME:-openwork-eval-secrets}"
DAYTONA_SECRETS_MOUNT="${DAYTONA_SECRETS_MOUNT:-/daytona-secrets}"
DAYTONA_SECRETS_ENV="${DAYTONA_SECRETS_ENV:-${DAYTONA_SECRETS_MOUNT}}"
DAYTONA_ARTIFACTS_VOLUME="${DAYTONA_ARTIFACTS_VOLUME:-openwork-eval-artifacts}"
DAYTONA_ARTIFACTS_MOUNT="${DAYTONA_ARTIFACTS_MOUNT:-/daytona-artifacts}"
DAYTONA_ELECTRON_EXTRA_LAUNCH_ARGS="${DAYTONA_ELECTRON_EXTRA_LAUNCH_ARGS:---disable-gpu --disable-dev-shm-usage --enable-unsafe-swiftshader}"
OPENWORK_ELECTRON_FAKE_MEDIA="${OPENWORK_ELECTRON_FAKE_MEDIA:-0}"

if [ -z "$RECORDING_NAME" ]; then
  RECORDING_NAME="$SANDBOX"
fi
if [[ ! "$RECORDING_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ERROR: recording name may only contain letters, numbers, dots, underscores, and dashes" >&2
  exit 1
fi
if [[ ! "$RECORDING_FPS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: recording fps must be a positive integer" >&2
  exit 1
fi
if [[ ! "$RECORDING_SIZE" =~ ^[0-9]+x[0-9]+$ ]]; then
  echo "ERROR: recording size must use WxH format, for example 1920x1080" >&2
  exit 1
fi

volume_field() {
  local name="$1"
  local field="$2"
  daytona volume list -f json | node -e 'const name = process.argv[1]; const field = process.argv[2]; let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const volume = JSON.parse(input).find((item) => item.name === name); if (!volume) process.exit(1); process.stdout.write(String(volume[field] ?? "")); });' "$name" "$field"
}

wait_for_volume_ready() {
  local name="$1"
  local state=""

  for _ in $(seq 1 60); do
    state="$(volume_field "$name" state 2>/dev/null || true)"
    if [ "$state" = "ready" ]; then
      return 0
    fi
    if [ "$state" = "error" ]; then
      echo "ERROR: volume '$name' is in error state" >&2
      exit 1
    fi
    sleep 5
  done

  echo "ERROR: volume '$name' did not become ready (last state: ${state:-missing})" >&2
  exit 1
}

snapshot_id() {
  daytona snapshot list -f json | node -e 'const name = process.argv[1]; let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const snapshot = JSON.parse(input).find((item) => item.name === name); if (snapshot) process.stdout.write(snapshot.id || snapshot.name); });' "$1"
}

echo "==> Creating sandbox: $SANDBOX"
echo "    Ref: $REF"
echo ""

echo "==> Ensuring reusable secrets volume: $DAYTONA_SECRETS_VOLUME"
volume_create_output="$(daytona volume create "$DAYTONA_SECRETS_VOLUME" --size 1 2>&1 || true)"
if [ -n "$volume_create_output" ] && ! printf '%s' "$volume_create_output" | grep -qi "already exists"; then
  printf '%s\n' "$volume_create_output"
fi
wait_for_volume_ready "$DAYTONA_SECRETS_VOLUME"
DAYTONA_SECRETS_VOLUME_ID="$(volume_field "$DAYTONA_SECRETS_VOLUME" id)"

DAYTONA_ARTIFACTS_VOLUME_ID=""
if [ "$ARTIFACTS_ENABLED" -eq 1 ]; then
  echo ""
  echo "==> Ensuring reusable artifacts volume: $DAYTONA_ARTIFACTS_VOLUME"
  volume_create_output="$(daytona volume create "$DAYTONA_ARTIFACTS_VOLUME" --size 5 2>&1 || true)"
  if [ -n "$volume_create_output" ] && ! printf '%s' "$volume_create_output" | grep -qi "already exists"; then
    printf '%s\n' "$volume_create_output"
  fi
  wait_for_volume_ready "$DAYTONA_ARTIFACTS_VOLUME"
  DAYTONA_ARTIFACTS_VOLUME_ID="$(volume_field "$DAYTONA_ARTIFACTS_VOLUME" id)"
fi

SNAPSHOT_ID="$(snapshot_id "$DAYTONA_EVAL_SNAPSHOT")"
if [ -z "$SNAPSHOT_ID" ]; then
  echo "ERROR: Daytona snapshot '$DAYTONA_EVAL_SNAPSHOT' not found." >&2
  echo "Create it with: bash .devcontainer/create-daytona-openwork-snapshot.sh" >&2
  exit 1
fi

echo "==> Using Daytona snapshot: $DAYTONA_EVAL_SNAPSHOT"
DAYTONA_CREATE_ARGS=(
  --name "$SANDBOX"
  --snapshot "$SNAPSHOT_ID"
  --volume "${DAYTONA_SECRETS_VOLUME_ID}:${DAYTONA_SECRETS_MOUNT}"
  --auto-stop 60
  --public
  --target us
)
if [ "$ARTIFACTS_ENABLED" -eq 1 ]; then
  DAYTONA_CREATE_ARGS+=(--volume "${DAYTONA_ARTIFACTS_VOLUME_ID}:${DAYTONA_ARTIFACTS_MOUNT}")
fi
daytona create "${DAYTONA_CREATE_ARGS[@]}"

echo ""
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

if [ "$ARTIFACTS_ENABLED" -eq 1 ]; then
  echo ""
  echo "==> Starting artifacts download server..."
  daytona exec "$SANDBOX" -- "bash -lc 'set -euo pipefail; mkdir -p \"$DAYTONA_ARTIFACTS_MOUNT/recordings\" \"$DAYTONA_ARTIFACTS_MOUNT/screenshots\" \"$DAYTONA_ARTIFACTS_MOUNT/validation\"; nohup python3 -m http.server $ARTIFACTS_PORT --directory \"$DAYTONA_ARTIFACTS_MOUNT\" >/tmp/daytona-artifacts.log 2>&1 &'"
fi

echo ""
echo "==> Checking out $REF..."
daytona exec "$SANDBOX" -- "bash -lc 'set -euo pipefail; cd /workspace; REF=\"$REF\"; FORCE_INSTALL=\"$FORCE_INSTALL\"; PNPM_STORE=/workspace/.openwork-daytona/pnpm-store; if git fetch origin \"\$REF\"; then git checkout --detach FETCH_HEAD; else git fetch origin dev --depth 50 || true; git checkout \"\$REF\"; fi; git rev-parse --short HEAD; mkdir -p \"\$PNPM_STORE\" .openwork-daytona; baseline=.openwork-daytona/pnpm-lock.sha256; current=\$(sha256sum pnpm-lock.yaml | cut -d \" \" -f 1); if [ \"\$FORCE_INSTALL\" = 1 ] || [ ! -d node_modules ] || [ ! -f \"\$baseline\" ] || [ \"\$(cat \"\$baseline\")\" != \"\$current\" ]; then echo \"==> Installing deps (missing node_modules, lockfile changed, or forced)...\"; CI=1 pnpm install --store-dir \"\$PNPM_STORE\" --frozen-lockfile || CI=1 pnpm install --store-dir \"\$PNPM_STORE\"; printf \"%s\" \"\$current\" > \"\$baseline\"; else echo \"==> Skipping pnpm install (node_modules present and lockfile unchanged).\"; fi'"

echo ""
echo "==> Starting OpenWork sandbox dev stack..."
daytona exec "$SANDBOX" -- "bash -lc 'set -euo pipefail; cd /workspace; DEN_BASE_URL=\"$DEN_BASE_URL\"; DEN_API_BASE_URL=\"$DEN_API_BASE_URL\"; DEN_REQUIRE_SIGNIN=\"$DEN_REQUIRE_SIGNIN\"; if [ -n \"\$DEN_BASE_URL\" ] || [ -n \"\$DEN_API_BASE_URL\" ] || [ \"\$DEN_REQUIRE_SIGNIN\" = 1 ]; then mkdir -p /workspace/.openwork-daytona; DEN_BASE_URL=\"\$DEN_BASE_URL\" DEN_API_BASE_URL=\"\$DEN_API_BASE_URL\" DEN_REQUIRE_SIGNIN=\"\$DEN_REQUIRE_SIGNIN\" node -e '\''const fs = require(\"node:fs\"); const baseUrl = process.env.DEN_BASE_URL || \"https://app.openworklabs.com\"; const apiBaseUrl = process.env.DEN_API_BASE_URL || null; const requireSignin = process.env.DEN_REQUIRE_SIGNIN === \"1\"; fs.writeFileSync(\"/workspace/.openwork-daytona/desktop-bootstrap.json\", JSON.stringify({ baseUrl, apiBaseUrl, requireSignin }, null, 2) + \"\\n\");'\''; fi; export DAYTONA_SECRETS_ENV=\"$DAYTONA_SECRETS_ENV\" DAYTONA_ELECTRON_EXTRA_LAUNCH_ARGS=\"$DAYTONA_ELECTRON_EXTRA_LAUNCH_ARGS\" OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=$CDP_PORT OPENWORK_ELECTRON_FAKE_MEDIA=\"$OPENWORK_ELECTRON_FAKE_MEDIA\" OPENWORK_WORKSPACE_DIR=/workspace OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT=1; if [ -f /workspace/.openwork-daytona/desktop-bootstrap.json ]; then export OPENWORK_DESKTOP_BOOTSTRAP_PATH=/workspace/.openwork-daytona/desktop-bootstrap.json; fi; pnpm dev:sandbox'"

echo ""
echo "==> Waiting for Electron CDP on port $CDP_PORT (up to ${MAX_WAIT}s)..."
elapsed=0
while [ "$elapsed" -lt "$MAX_WAIT" ]; do
  if daytona exec "$SANDBOX" -- "bash -lc 'curl -sf http://127.0.0.1:$CDP_PORT/json/list >/dev/null 2>&1'" 2>/dev/null; then
    echo "    CDP ready after ${elapsed}s."
    break
  fi
  sleep 5
  elapsed=$((elapsed + 5))
  printf "    %ds...\r" "$elapsed"
done

if [ "$elapsed" -ge "$MAX_WAIT" ]; then
  echo ""
  echo "WARNING: CDP did not become ready within ${MAX_WAIT}s."
  echo "Check logs:"
  echo "  daytona exec $SANDBOX -- 'tail -80 /tmp/start-vnc.log'"
  echo "  daytona exec $SANDBOX -- 'tail -80 /tmp/electron.log'"
  echo "  daytona exec $SANDBOX -- 'tail -80 /tmp/vite.log'"
  exit 1
fi

RECORDING_PATH=""
if [ "$RECORD_VIDEO" -eq 1 ]; then
  RECORDING_PATH="${DAYTONA_ARTIFACTS_MOUNT}/recordings/${RECORDING_NAME}.mp4"
  echo ""
  echo "==> Starting Daytona display recording..."
  daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace; DISPLAY=:99 .devcontainer/start-daytona-recording.sh --detach --output \"$RECORDING_PATH\" --size \"$RECORDING_SIZE\" --fps \"$RECORDING_FPS\"'"
  echo "    Recording is active. Begin the user-visible flow after the ready banner below."
fi

echo ""
if daytona exec "$SANDBOX" -- "bash -lc 'ps aux | grep opencode | grep -v grep'" 2>/dev/null | grep -q opencode; then
  echo "==> opencode sidecar: running"
else
  echo "==> opencode sidecar: not running (workspace may need creation first)"
fi

echo "==> Secrets env: ${DAYTONA_SECRETS_ENV} (file or directory, sourced if present)"
if [ -n "$DEN_BASE_URL" ]; then
  echo "==> Den base URL: $DEN_BASE_URL"
fi

CDP_URL=$(daytona preview-url "$SANDBOX" -p "$CDP_PORT" 2>/dev/null | grep -v "^time=")
NOVNC_URL=$(daytona preview-url "$SANDBOX" -p "$NOVNC_PORT" 2>/dev/null | grep -v "^time=")
ARTIFACTS_URL=""
RECORDING_URL=""
if [ "$ARTIFACTS_ENABLED" -eq 1 ]; then
  ARTIFACTS_URL=$(daytona preview-url "$SANDBOX" -p "$ARTIFACTS_PORT" 2>/dev/null | grep -v "^time=")
fi
if [ "$RECORD_VIDEO" -eq 1 ]; then
  RECORDING_URL="${ARTIFACTS_URL%/}/recordings/${RECORDING_NAME}.mp4"
fi

echo ""
echo "============================================"
echo "  Sandbox ready: $SANDBOX"
echo ""
echo "  Electron CDP:  $CDP_URL"
echo "  noVNC visual:  $NOVNC_URL"
if [ "$ARTIFACTS_ENABLED" -eq 1 ]; then
  echo "  Artifacts:     $ARTIFACTS_URL"
  echo "  Screenshot:"
  echo "    daytona exec $SANDBOX -- 'bash .devcontainer/capture-daytona-screenshot.sh'"
fi
if [ "$RECORD_VIDEO" -eq 1 ]; then
  echo "  Recording:     $RECORDING_URL"
  echo ""
  echo "  Stop recording:"
  echo "    daytona exec $SANDBOX -- 'bash .devcontainer/stop-daytona-recording.sh'"
  echo "  Validate recording duration before using it as evidence."
fi
echo ""
echo "  Connect browser tools:"
echo "    browser_list({ browser_url: \"$CDP_URL\" })"
echo ""
echo "  Cleanup:"
echo "    daytona delete $SANDBOX"
echo "============================================"
