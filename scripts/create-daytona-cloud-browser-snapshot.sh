#!/usr/bin/env bash
# Builds packaging/docker/Dockerfile.cloud-browser and pushes it as the Daytona
# snapshot that every member's cloud browser sandbox boots from.
#
#   scripts/create-daytona-cloud-browser-snapshot.sh [snapshot-name] [--build-only]
#
# The Daytona CLI reads DAYTONA_API_KEY and DAYTONA_API_URL from the
# environment (or .env.daytona); without them it uses your own CLI login.
# Snapshot names are never reused: existing member sandboxes keep the snapshot
# they were created from, and new ones use DEN_CLOUD_BROWSER_DAYTONA_SNAPSHOT.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$ROOT_DIR/packaging/docker/Dockerfile.cloud-browser"
DAYTONA_ENV_FILE="${DAYTONA_ENV_FILE:-$ROOT_DIR/.env.daytona}"

BUILD_ONLY=0
SNAPSHOT_NAME=""
for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) SNAPSHOT_NAME="$arg" ;;
  esac
done
SNAPSHOT_NAME="${SNAPSHOT_NAME:-${DAYTONA_SNAPSHOT_NAME:-openwork-cloud-browser-$(date -u +%Y%m%d%H%M)}}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if [ -f "$DAYTONA_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$DAYTONA_ENV_FILE"
  set +a
fi
if [ -n "${DAYTONA_API_KEY:-}" ]; then
  export DAYTONA_API_URL="${DAYTONA_API_URL:-https://app.daytona.io/api}"
fi

SNAPSHOT_REGION="${DAYTONA_SNAPSHOT_REGION:-${DAYTONA_TARGET:-}}"
SNAPSHOT_CPU="${DAYTONA_SNAPSHOT_CPU:-1}"
SNAPSHOT_MEMORY="${DAYTONA_SNAPSHOT_MEMORY:-2}"
SNAPSHOT_DISK="${DAYTONA_SNAPSHOT_DISK:-4}"
LOCAL_IMAGE_TAG="${DAYTONA_LOCAL_IMAGE_TAG:-openwork-cloud-browser:${SNAPSHOT_NAME//[^a-zA-Z0-9_.-]/-}}"

# Daytona runs linux/amd64. The image's `chromium --version` check needs that
# architecture natively; skip it for cross-builds and verify on the target.
case "$(uname -m)" in
  x86_64 | amd64) RUNTIME_ASSERTS="${RUNTIME_ASSERTS:-1}" ;;
  *) RUNTIME_ASSERTS="${RUNTIME_ASSERTS:-0}" ;;
esac

echo "Building $LOCAL_IMAGE_TAG (runtime asserts: $RUNTIME_ASSERTS)" >&2
docker buildx build \
  --platform linux/amd64 \
  -t "$LOCAL_IMAGE_TAG" \
  -f "$DOCKERFILE" \
  --build-arg "RUNTIME_ASSERTS=$RUNTIME_ASSERTS" \
  --load \
  "$ROOT_DIR/packaging/docker"

if [ "$BUILD_ONLY" = "1" ]; then
  echo "Built $LOCAL_IMAGE_TAG; not pushed (--build-only)." >&2
  exit 0
fi

if ! command -v daytona >/dev/null 2>&1; then
  echo "daytona CLI is required to push the snapshot" >&2
  exit 1
fi

if daytona snapshot list --format json | node -e '
const target = process.argv[1]
const data = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]")
const stack = [data]
while (stack.length) {
  const value = stack.pop()
  if (!value || typeof value !== "object") continue
  if (Array.isArray(value)) { stack.push(...value); continue }
  if (value.name === target) process.exit(0)
  stack.push(...Object.values(value))
}
process.exit(1)
' "$SNAPSHOT_NAME"; then
  echo "Daytona snapshot $SNAPSHOT_NAME already exists; choose a new name." >&2
  exit 1
fi

args=(snapshot push "$LOCAL_IMAGE_TAG" --name "$SNAPSHOT_NAME" --cpu "$SNAPSHOT_CPU" --memory "$SNAPSHOT_MEMORY" --disk "$SNAPSHOT_DISK")
if [ -n "$SNAPSHOT_REGION" ]; then
  args+=(--region "$SNAPSHOT_REGION")
fi

echo "Pushing Daytona snapshot $SNAPSHOT_NAME" >&2
daytona "${args[@]}"

echo >&2
echo "Snapshot ready: $SNAPSHOT_NAME" >&2
echo "Set DEN_CLOUD_BROWSER_DAYTONA_SNAPSHOT=$SNAPSHOT_NAME for Den, then smoke-test it with:" >&2
echo "  pnpm --filter @openwork-ee/cloud-browser smoke:daytona -- --snapshot $SNAPSHOT_NAME" >&2
