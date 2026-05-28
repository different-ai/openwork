#!/usr/bin/env bash
set -euo pipefail

# Build/refresh the reusable Daytona snapshot used by Den server sandboxes.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_NAME="${DAYTONA_SERVER_SNAPSHOT:-openwork-server}"
REGION="${DAYTONA_TARGET:-us}"

snapshot_id() {
  daytona snapshot list -f json | node -e 'const name = process.argv[1]; let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const snapshot = JSON.parse(input).find((item) => item.name === name); if (snapshot) process.stdout.write(snapshot.id || snapshot.name); });' "$1"
}

existing_snapshot_id="$(snapshot_id "$SNAPSHOT_NAME")"
if [ -n "$existing_snapshot_id" ]; then
  echo "==> Deleting existing snapshot: $SNAPSHOT_NAME"
  daytona snapshot delete "$existing_snapshot_id" >/dev/null <<< "y"
  for _ in $(seq 1 60); do
    if [ -z "$(snapshot_id "$SNAPSHOT_NAME")" ]; then
      break
    fi
    sleep 5
  done
fi

echo "==> Creating Daytona server snapshot: $SNAPSHOT_NAME"
daytona snapshot create "$SNAPSHOT_NAME" \
  --dockerfile "$ROOT_DIR/.devcontainer/Dockerfile.daytona-server" \
  --cpu 4 \
  --memory 8 \
  --disk 10 \
  --region "$REGION"

echo "Snapshot ready: $SNAPSHOT_NAME"
