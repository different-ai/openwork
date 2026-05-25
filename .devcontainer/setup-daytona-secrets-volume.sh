#!/usr/bin/env bash
set -euo pipefail

# Create the reusable Daytona secrets volume once. If a local env file is
# provided, copy it into the mounted volume as openai.env without printing it.
#
# Usage:
#   bash .devcontainer/setup-daytona-secrets-volume.sh [.newtoken]

VOLUME_NAME="${DAYTONA_SECRETS_VOLUME:-openwork-eval-secrets}"
MOUNT_PATH="${DAYTONA_SECRETS_MOUNT:-/daytona-secrets}"
LOCAL_ENV_FILE="${1:-.newtoken}"
SANDBOX="openwork-secrets-setup-$(date +%Y%m%d-%H%M%S)"
SNAPSHOT_NAME="${DAYTONA_EVAL_SNAPSHOT:-openwork-eval-vnc}"

cleanup() {
  yes | daytona delete "$SANDBOX" >/dev/null 2>&1 || true
}
trap cleanup EXIT

volume_create_output="$(daytona volume create "$VOLUME_NAME" --size 1 2>&1 || true)"
if [ -n "$volume_create_output" ] && ! printf '%s' "$volume_create_output" | grep -qi "already exists"; then
  printf '%s\n' "$volume_create_output"
fi
VOLUME_ID="$(daytona volume list -f json | node -e 'const name = process.argv[1]; let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const volume = JSON.parse(input).find((item) => item.name === name); if (!volume) process.exit(1); process.stdout.write(volume.id); });' "$VOLUME_NAME")"

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

daytona exec "$SANDBOX" -- "bash -lc 'mkdir -p \"$MOUNT_PATH\" && umask 177 && printf %s \"$SECRET_ENV_B64\" | base64 -d > \"$MOUNT_PATH/openai.env\"'" >/dev/null
daytona exec "$SANDBOX" -- "bash -lc 'test -s \"$MOUNT_PATH/openai.env\" && chmod 600 \"$MOUNT_PATH/openai.env\"'" >/dev/null

echo "Volume ready: $VOLUME_NAME"
echo "Secret env installed at ${MOUNT_PATH}/openai.env"
