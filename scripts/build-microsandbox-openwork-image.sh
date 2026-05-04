#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$ROOT_DIR/packaging/docker/Dockerfile.microsandbox"

IMAGE_REF="${1:-openwork-microsandbox:dev}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-}"
OPENCODE_VERSION="${OPENCODE_VERSION:-$(node -e 'const fs=require("fs"); const parsed=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(parsed.opencodeVersion || "").trim().replace(/^v/, ""));' "$ROOT_DIR/constants.json")}"
OPENWORK_ORCHESTRATOR_VERSION="${OPENWORK_ORCHESTRATOR_VERSION:-$(node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(pkg.version));' "$ROOT_DIR/apps/orchestrator/package.json")}"
OPENWORK_SERVER_VERSION="${OPENWORK_SERVER_VERSION:-$(node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(pkg.version));' "$ROOT_DIR/apps/server/package.json")}"

args=(
  build
  -t "$IMAGE_REF"
  -f "$DOCKERFILE"
  --build-arg "OPENWORK_ORCHESTRATOR_VERSION=$OPENWORK_ORCHESTRATOR_VERSION"
  --build-arg "OPENWORK_SERVER_VERSION=$OPENWORK_SERVER_VERSION"
  --build-arg "OPENCODE_VERSION=$OPENCODE_VERSION"
)

if [ -n "$DOCKER_PLATFORM" ]; then
  args+=(--platform "$DOCKER_PLATFORM")
fi

args+=("$ROOT_DIR")

printf 'Building micro-sandbox image %s\n' "$IMAGE_REF"
printf '  openwork-orchestrator@%s\n' "$OPENWORK_ORCHESTRATOR_VERSION"
printf '  openwork-server@%s\n' "$OPENWORK_SERVER_VERSION"
printf '  opencode@%s\n' "$OPENCODE_VERSION"

docker "${args[@]}"

printf '\nBuilt micro-sandbox image: %s\n' "$IMAGE_REF"
printf 'Run example:\n'
printf '  docker run --rm -p 8787:8787 -e OPENWORK_CONNECT_HOST=127.0.0.1 %s\n' "$IMAGE_REF"
printf 'Verify:\n'
printf '  curl http://127.0.0.1:8787/health\n'
printf '  curl -H "Authorization: Bearer microsandbox-token" http://127.0.0.1:8787/workspaces\n'
