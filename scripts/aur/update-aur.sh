#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TAG="${1:-${RELEASE_TAG:-}}"
ASSETS_DIR="${AUR_ASSETS_DIR:-}"

if [ -z "$TAG" ]; then
  echo "Missing release tag (arg or RELEASE_TAG)." >&2
  exit 1
fi
if [[ "$TAG" != v* ]]; then
  TAG="v${TAG}"
fi
if [ "${2:-}" = "--assets-dir" ]; then
  ASSETS_DIR="${3:-}"
fi

VERSION="${TAG#v}"
X64_NAME="openwork-linux-x64-${VERSION}.tar.gz"
ARM64_NAME="openwork-linux-arm64-${VERSION}.tar.gz"
TMP_DIR=""

if [ -z "$ASSETS_DIR" ]; then
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT
  ASSETS_DIR="$TMP_DIR"
  curl -fsSL --retry 5 --retry-all-errors \
    -o "${ASSETS_DIR}/${X64_NAME}" \
    "https://github.com/${GITHUB_REPOSITORY:-different-ai/openwork}/releases/download/${TAG}/${X64_NAME}"
  curl -fsSL --retry 5 --retry-all-errors \
    -o "${ASSETS_DIR}/${ARM64_NAME}" \
    "https://github.com/${GITHUB_REPOSITORY:-different-ai/openwork}/releases/download/${TAG}/${ARM64_NAME}"
fi

node "${ROOT_DIR}/scripts/aur/aur-packaging.mjs" update \
  --tag "$TAG" \
  --x64 "${ASSETS_DIR}/${X64_NAME}" \
  --arm64 "${ASSETS_DIR}/${ARM64_NAME}"
node "${ROOT_DIR}/scripts/aur/aur-packaging.mjs" verify \
  --tag "$TAG" \
  --x64 "${ASSETS_DIR}/${X64_NAME}" \
  --arm64 "${ASSETS_DIR}/${ARM64_NAME}"
