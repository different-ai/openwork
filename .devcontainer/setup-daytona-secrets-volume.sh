#!/usr/bin/env bash
set -euo pipefail

# Create the reusable Daytona secrets volume once. If a local env file is
# provided, copy it into the mounted volume without printing it.
#
# Usage:
#   bash .devcontainer/setup-daytona-secrets-volume.sh [.newtoken] [openai.env]

VOLUME_NAME="${DAYTONA_SECRETS_VOLUME:-openwork-eval-secrets}"
MOUNT_PATH="${DAYTONA_SECRETS_MOUNT:-/daytona-secrets}"
LOCAL_ENV_FILE="${1:-.newtoken}"
DEST_ENV_FILE="${2:-openai.env}"
SANDBOX="openwork-secrets-setup-$(date +%Y%m%d-%H%M%S)"
SNAPSHOT_NAME="${DAYTONA_EVAL_SNAPSHOT:-openwork-eval-vnc}"

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

if [[ ! "$DEST_ENV_FILE" =~ ^[A-Za-z0-9._-]+\.env$ ]]; then
  echo "ERROR: destination env file must be a simple .env filename, for example openai.env" >&2
  exit 1
fi

cleanup() {
  yes | daytona delete "$SANDBOX" >/dev/null 2>&1 || true
}
trap cleanup EXIT

volume_create_output="$(daytona volume create "$VOLUME_NAME" --size 1 2>&1 || true)"
if [ -n "$volume_create_output" ] && ! printf '%s' "$volume_create_output" | grep -qi "already exists"; then
  printf '%s\n' "$volume_create_output"
fi
wait_for_volume_ready "$VOLUME_NAME"
VOLUME_ID="$(volume_field "$VOLUME_NAME" id)"

if [ ! -f "$LOCAL_ENV_FILE" ]; then
  echo "Volume ready: $VOLUME_NAME"
  echo "No local env file found at $LOCAL_ENV_FILE; skipping secret copy."
  exit 0
fi

SECRET_ENV_B64="$(base64 < "$LOCAL_ENV_FILE" | tr -d '\n')"

SNAPSHOT_ID="$(daytona snapshot list -f json | node -e 'const name = process.argv[1]; let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const snapshot = JSON.parse(input).find((item) => item.name === name); if (snapshot) process.stdout.write(snapshot.id || snapshot.name); });' "$SNAPSHOT_NAME")"

if [ -z "$SNAPSHOT_ID" ]; then
  echo "ERROR: Daytona snapshot '$SNAPSHOT_NAME' not found." >&2
  echo "Create it with: bash .devcontainer/create-daytona-openwork-snapshot.sh" >&2
  exit 1
fi

daytona create \
  --name "$SANDBOX" \
  --snapshot "$SNAPSHOT_ID" \
  --volume "${VOLUME_ID}:${MOUNT_PATH}" \
  --auto-stop 15 \
  --public \
  --target us >/dev/null

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

daytona exec "$SANDBOX" -- "bash -lc 'mkdir -p \"$MOUNT_PATH\" && umask 177 && printf %s \"$SECRET_ENV_B64\" | base64 -d > \"$MOUNT_PATH/$DEST_ENV_FILE\"'" >/dev/null
daytona exec "$SANDBOX" -- "bash -lc 'test -s \"$MOUNT_PATH/$DEST_ENV_FILE\" && chmod 600 \"$MOUNT_PATH/$DEST_ENV_FILE\"'" >/dev/null

echo "Volume ready: $VOLUME_NAME"
echo "Secret env installed at ${MOUNT_PATH}/${DEST_ENV_FILE}"
echo "Electron sources every ${MOUNT_PATH}/*.env file by default."
