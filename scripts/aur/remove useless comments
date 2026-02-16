#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PKG_DIR="${ROOT_DIR}/packaging/aur"
PKGBUILD="${PKG_DIR}/PKGBUILD"
SRCINFO="${PKG_DIR}/.SRCINFO"

PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  else
    echo "Python is required (python3 preferred)." >&2
    exit 1
  fi
fi

TAG="${1:-${RELEASE_TAG:-}}"
if [ -z "$TAG" ]; then
  echo "Missing release tag (arg or RELEASE_TAG)." >&2
  exit 1
fi

if [[ "$TAG" != v* ]]; then
  TAG="v${TAG}"
fi

VERSION="${TAG#v}"
ASSET_NAME_AMD64="${AUR_ASSET_NAME:-openwork-desktop-linux-amd64.deb}"
ASSET_NAME_ARM64="openwork-desktop-linux-arm64.deb"
ASSET_URL_AMD64="https://github.com/different-ai/openwork/releases/download/${TAG}/${ASSET_NAME_AMD64}"
ASSET_URL_ARM64="https://github.com/different-ai/openwork/releases/download/${TAG}/${ASSET_NAME_ARM64}"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL -o "${TMP_DIR}/${ASSET_NAME_AMD64}" "$ASSET_URL_AMD64"
curl -fsSL -o "${TMP_DIR}/${ASSET_NAME_ARM64}" "$ASSET_URL_ARM64"

# Calculate SHA256 checksums
SHA256_AMD64=$(sha256sum "${TMP_DIR}/${ASSET_NAME_AMD64}" | awk '{print $1}')
SHA256_ARM64=$(sha256sum "${TMP_DIR}/${ASSET_NAME_ARM64}" | awk '{print $1}')

$PYTHON_BIN - "$PKGBUILD" "$VERSION" "$SHA256_AMD64" "$SHA256_ARM64" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
version = sys.argv[2]
sha_amd64 = sys.argv[3]
sha_arm64 = sys.argv[4]

text = path.read_text()
text = re.sub(r"^pkgver=.*$", f"pkgver={version}", text, flags=re.M)
text = re.sub(r"^(pkgrel=)\d+", r"\g<1>1", text, flags=re.M)
text = re.sub(r"^sha256sums_x86_64=.*$", f"sha256sums_x86_64=('{sha_amd64}')", text, flags=re.M)
text = re.sub(r"^sha256sums_aarch64=.*$", f"sha256sums_aarch64=('{sha_arm64}')", text, flags=re.M)
path.write_text(text)
PY

$PYTHON_BIN - "$SRCINFO" "$PKGBUILD" "$VERSION" "$SHA256_AMD64" "$SHA256_ARM64" "$ASSET_URL_AMD64" "$ASSET_URL_ARM64" <<'PY'
import pathlib
import re
import sys

srcinfo_path = pathlib.Path(sys.argv[1])
pkgbuild_path = pathlib.Path(sys.argv[2])
version = sys.argv[3]
sha_amd64 = sys.argv[4]
sha_arm64 = sys.argv[5]
url_amd64 = sys.argv[6]
url_arm64 = sys.argv[7]

pkgbuild = pkgbuild_path.read_text()
match = re.search(r"^pkgname=(.+)$", pkgbuild, flags=re.M)
if not match:
    raise SystemExit("Could not determine pkgname from PKGBUILD")
pkgname = match.group(1).strip()

renamed = f"{pkgname}-{version}.deb"

text = srcinfo_path.read_text()
text = re.sub(r"^\s*pkgver = .*", f"\tpkgver = {version}", text, flags=re.M)
text = re.sub(r"^\s*pkgrel = .*", "\tpkgrel = 1", text, flags=re.M)
text = re.sub(r"^\s*noextract = .*", f"\tnoextract = {renamed}", text, flags=re.M)
text = re.sub(
    r"^\s*source_x86_64 = .*",
    f"\tsource_x86_64 = {renamed}::{url_amd64}",
    text,
    flags=re.M,
)
text = re.sub(r"^\s*sha256sums_x86_64 = .*", f"\tsha256sums_x86_64 = {sha_amd64}", text, flags=re.M)
text = re.sub(
    r"^\s*source_aarch64 = .*",
    f"\tsource_aarch64 = {renamed}::{url_arm64}",
    text,
    flags=re.M,
)
text = re.sub(r"^\s*sha256sums_aarch64 = .*", f"\tsha256sums_aarch64 = {sha_arm64}", text, flags=re.M)
srcinfo_path.write_text(text)
PY
