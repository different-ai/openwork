#!/usr/bin/env bash
set -euo pipefail

IMAGE_REF="${1:-labs-openwork-runtime:test}"
WORKSPACE_DIR="${2:-/Users/benjaminshafii/openwork-enterprise/_repos/openwork}"
HOST_PORT="${3:-18787}"

docker rm -f labs-openwork-runtime-probe >/dev/null 2>&1 || true

docker run -d \
  --name labs-openwork-runtime-probe \
  -p "${HOST_PORT}:8787" \
  -e LABS_REMOTE_ACCESS=1 \
  -v "${WORKSPACE_DIR}:/workspace/repo" \
  "$IMAGE_REF"

printf 'Runtime probe started: %s\n' "$IMAGE_REF"
printf 'Mounted workspace: %s\n' "$WORKSPACE_DIR"
printf 'Expected OpenWork URL: http://127.0.0.1:%s\n' "$HOST_PORT"
