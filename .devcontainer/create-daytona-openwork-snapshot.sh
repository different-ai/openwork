#!/usr/bin/env bash
set -euo pipefail

# Build/refresh the reusable Daytona VNC snapshot used by eval sandboxes from
# the prebuilt GHCR image. The image is built by GitHub Actions on dev pushes.

SNAPSHOT_NAME="${DAYTONA_EVAL_SNAPSHOT:-openwork-eval-vnc}"
IMAGE="${DAYTONA_EVAL_IMAGE:-ghcr.io/different-ai/openwork-eval-vnc:dev}"
REGION="${DAYTONA_TARGET:-us}"

existing_snapshot_id="$(daytona snapshot list -f json | node -e 'const name = process.argv[1]; let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const snapshot = JSON.parse(input).find((item) => item.name === name); if (snapshot) process.stdout.write(snapshot.id || snapshot.name); });' "$SNAPSHOT_NAME")"

if [ -n "$existing_snapshot_id" ]; then
  echo "==> Deleting existing snapshot: $SNAPSHOT_NAME"
  daytona snapshot delete "$existing_snapshot_id" >/dev/null <<< "y"
  for _ in $(seq 1 60); do
    if ! daytona snapshot list -f json | node -e 'const name = process.argv[1]; let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { const snapshot = JSON.parse(input).find((item) => item.name === name); process.exit(snapshot ? 1 : 0); });' "$SNAPSHOT_NAME"; then
      sleep 5
    else
      break
    fi
  done
fi

echo "==> Creating Daytona eval snapshot: $SNAPSHOT_NAME"
daytona snapshot create "$SNAPSHOT_NAME" \
  --image "$IMAGE" \
  --cpu 4 \
  --memory 8 \
  --disk 10 \
  --region "$REGION"

echo "Snapshot ready: $SNAPSHOT_NAME"
