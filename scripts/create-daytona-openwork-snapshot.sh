#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$ROOT_DIR/ee/apps/den-worker-runtime/Dockerfile.daytona-snapshot"
DAYTONA_ENV_FILE="${DAYTONA_ENV_FILE:-$ROOT_DIR/.env.daytona}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if ! command -v daytona >/dev/null 2>&1; then
  echo "daytona CLI is required" >&2
  exit 1
fi

if [ -f "$DAYTONA_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$DAYTONA_ENV_FILE"
  set +a
fi

if [ -n "${DAYTONA_API_KEY:-}" ]; then
  echo "Authenticating Daytona CLI" >&2
  daytona login --api-key "$DAYTONA_API_KEY" >/dev/null
fi

SNAPSHOT_NAME="${1:-${DAYTONA_SNAPSHOT_NAME:-openwork-runtime}}"
SNAPSHOT_REGION="${DAYTONA_SNAPSHOT_REGION:-${DAYTONA_TARGET:-}}"
SNAPSHOT_CPU="${DAYTONA_SNAPSHOT_CPU:-1}"
SNAPSHOT_MEMORY="${DAYTONA_SNAPSHOT_MEMORY:-2}"
SNAPSHOT_DISK="${DAYTONA_SNAPSHOT_DISK:-8}"
LOCAL_IMAGE_TAG="${DAYTONA_LOCAL_IMAGE_TAG:-openwork-daytona-snapshot:${SNAPSHOT_NAME//[^a-zA-Z0-9_.-]/-}}"

OPENWORK_ORCHESTRATOR_VERSION="${OPENWORK_ORCHESTRATOR_VERSION:-$(node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(pkg.version));' "$ROOT_DIR/apps/orchestrator/package.json")}"
OPENCODE_VERSION="$(node -e 'const fs=require("fs"); const parsed=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(parsed.opencodeVersion || "").trim().replace(/^v/, ""));' "$ROOT_DIR/constants.json")"

echo "Building local image $LOCAL_IMAGE_TAG" >&2
echo "- openwork-orchestrator@$OPENWORK_ORCHESTRATOR_VERSION" >&2
echo "- opencode@$OPENCODE_VERSION" >&2

docker buildx build \
  --platform linux/amd64 \
  -t "$LOCAL_IMAGE_TAG" \
  -f "$DOCKERFILE" \
  --build-arg "OPENWORK_ORCHESTRATOR_VERSION=$OPENWORK_ORCHESTRATOR_VERSION" \
  --build-arg "OPENCODE_VERSION=$OPENCODE_VERSION" \
  --load \
  "$ROOT_DIR"

args=(snapshot push "$LOCAL_IMAGE_TAG" --name "$SNAPSHOT_NAME" --cpu "$SNAPSHOT_CPU" --memory "$SNAPSHOT_MEMORY" --disk "$SNAPSHOT_DISK")
if [ -n "$SNAPSHOT_REGION" ]; then
  args+=(--region "$SNAPSHOT_REGION")
fi

EXISTING_SNAPSHOT_ID="$({
  daytona snapshot list --format json | node -e '
const fs = require("fs");

const target = process.argv[1];
const raw = fs.readFileSync(0, "utf8").trim();

if (!raw || !target) {
  process.exit(0);
}

let data;
try {
  data = JSON.parse(raw);
} catch (error) {
  console.error(`Failed to parse Daytona snapshot list JSON: ${error.message}`);
  process.exit(1);
}

const stack = [data];
while (stack.length > 0) {
  const value = stack.pop();
  if (!value || typeof value !== "object") {
    continue;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      stack.push(item);
    }
    continue;
  }

  const name = typeof value.name === "string" ? value.name : "";
  const id = typeof value.id === "string" ? value.id : "";
  if (name === target) {
    process.stdout.write(id || name);
    process.exit(0);
  }

  for (const child of Object.values(value)) {
    stack.push(child);
  }
}
' "$SNAPSHOT_NAME";
} )"

if [ -n "$EXISTING_SNAPSHOT_ID" ]; then
  echo "Deleting existing Daytona snapshot $SNAPSHOT_NAME" >&2
  daytona snapshot delete "$EXISTING_SNAPSHOT_ID"
fi

echo "Pushing Daytona snapshot $SNAPSHOT_NAME" >&2
daytona "${args[@]}"

echo >&2
echo "Snapshot ready: $SNAPSHOT_NAME" >&2
echo "Set DAYTONA_SNAPSHOT=$SNAPSHOT_NAME in .env.daytona before starting Den." >&2
