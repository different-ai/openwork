#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TAG="${1:-${RELEASE_TAG:-}}"

if [ -z "$TAG" ]; then
  echo "Missing release tag (arg or RELEASE_TAG)." >&2
  exit 1
fi
if [[ "$TAG" != v* ]]; then
  TAG="v${TAG}"
fi

VERSION="${TAG#v}"
X64_NAME="openwork-linux-x64-${VERSION}.tar.gz"
ARM64_NAME="openwork-linux-arm64-${VERSION}.tar.gz"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

for asset in "$X64_NAME" "$ARM64_NAME"; do
  curl -fsSL --retry 5 --retry-all-errors \
    -o "${TMP_DIR}/${asset}" \
    "https://github.com/${GITHUB_REPOSITORY:-different-ai/openwork}/releases/download/${TAG}/${asset}"
done

node "${ROOT_DIR}/scripts/aur/aur-packaging.mjs" verify \
  --tag "$TAG" \
  --x64 "${TMP_DIR}/${X64_NAME}" \
  --arm64 "${TMP_DIR}/${ARM64_NAME}"
