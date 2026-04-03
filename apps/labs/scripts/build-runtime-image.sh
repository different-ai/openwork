#!/usr/bin/env bash
set -euo pipefail

IMAGE_REF="${1:-labs-openwork-runtime:dev}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.3.13}"

OPENWORK_ROOT="$(git rev-parse --show-toplevel)"
ENTERPRISE_ROOT="${OPENWORK_ROOT%%/_repos/openwork*}"
RUNTIME_DIR="${OPENWORK_ROOT}/apps/labs/runtime"
GENERATED_DIR="${RUNTIME_DIR}/.generated"
ARCHIVE_PATH="${GENERATED_DIR}/opencode-linux-arm64.tar.gz"
EXTRACT_DIR="${GENERATED_DIR}/opencode-linux-arm64"
OPENCODE_BIN="${GENERATED_DIR}/opencode"

mkdir -p "$GENERATED_DIR"

if [ ! -x "$OPENCODE_BIN" ]; then
  printf 'Downloading opencode %s linux-arm64 binary\n' "$OPENCODE_VERSION"
  rm -rf "$EXTRACT_DIR"
  mkdir -p "$EXTRACT_DIR"
  curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-arm64.tar.gz" -o "$ARCHIVE_PATH"
  tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"
  cp "$(find "$EXTRACT_DIR" -type f -name opencode | head -1)" "$OPENCODE_BIN"
  chmod +x "$OPENCODE_BIN"
fi

docker build \
  -t "$IMAGE_REF" \
  -f "./runtime/Dockerfile" \
  ./runtime

printf 'Built runtime image: %s\n' "$IMAGE_REF"
