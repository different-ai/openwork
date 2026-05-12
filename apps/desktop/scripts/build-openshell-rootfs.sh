#!/usr/bin/env bash
# Build the Ubuntu 24.04 + Docker + OpenShell rootfs tarball that the
# OpenWork installer (installer.mjs phaseDistro) imports via
# `wsl --import` on a banker's Windows machine.
#
# Usage (CI or local Linux):
#   ./apps/desktop/scripts/build-openshell-rootfs.sh
#
# Output:
#   apps/desktop/resources/openshell/ubuntu-24.04-openshell.tar.gz (~150 MB)
#
# The packaged Electron MSI picks this file up via electron-builder.yml's
# win.extraResources rule.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$DESKTOP_DIR/resources/openshell"
OUT_FILE="$OUT_DIR/ubuntu-24.04-openshell.tar.gz"
TAG="openwork/openshell-rootfs:build-$(date +%s)"
DOCKERFILE="$SCRIPT_DIR/openshell-rootfs.Dockerfile"

if ! command -v docker >/dev/null 2>&1; then
  echo "build-openshell-rootfs: docker is required but not on PATH." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "build-openshell-rootfs: building image $TAG..."
# --no-cache forces a fresh pull of the docker-ce / openshell installers
# every run. The rootfs is meant to bundle a current snapshot at MSI
# release time; cached builds risk shipping stale upstream packages.
docker build \
  --no-cache \
  --pull \
  -f "$DOCKERFILE" \
  -t "$TAG" \
  "$SCRIPT_DIR"

echo "build-openshell-rootfs: exporting rootfs..."
CONTAINER_ID="$(docker create "$TAG" /bin/true)"
cleanup() {
  docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
  docker image rm -f "$TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# `docker export` produces a flat rootfs tarball — exactly what
# `wsl --import` consumes. gzip -9 trades a couple of CPU minutes for
# ~30 MB off the final MSI size; banker laptops are constrained on
# disk, not CPU.
docker export "$CONTAINER_ID" | gzip -9 > "$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "build-openshell-rootfs: wrote $OUT_FILE ($SIZE)"
