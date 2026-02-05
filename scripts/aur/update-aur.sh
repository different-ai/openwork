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
ASSET_NAME="${AUR_ASSET_NAME:-openwork-desktop-linux-amd64.deb}"
ASSET_URL="https://github.com/different-ai/openwork/releases/download/${TAG}/${ASSET_NAME}"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL -o "${TMP_DIR}/${ASSET_NAME}" "$ASSET_URL"

SHA256=$($PYTHON_BIN - "${TMP_DIR}/${ASSET_NAME}" <<'PY'
import hashlib
import sys

path = sys.argv[1]
hasher = hashlib.sha256()
with open(path, "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        hasher.update(chunk)
print(hasher.hexdigest())
PY
)

$PYTHON_BIN - "$PKGBUILD" "$VERSION" "$SHA256" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
version = sys.argv[2]
sha = sys.argv[3]

text = path.read_text()
text = re.sub(r"^pkgver=.*$", f"pkgver={version}", text, flags=re.M)
text = re.sub(r"^(pkgrel=)\d+", r"\g<1>1", text, flags=re.M)
text = re.sub(r"^sha256sums=.*$", f"sha256sums=('{sha}')", text, flags=re.M)
path.write_text(text)
PY

$PYTHON_BIN - "$SRCINFO" "$PKGBUILD" "$VERSION" "$SHA256" "$ASSET_URL" <<'PY'
import pathlib
import re
import sys

srcinfo_path = pathlib.Path(sys.argv[1])
pkgbuild_path = pathlib.Path(sys.argv[2])
version = sys.argv[3]
sha = sys.argv[4]
url = sys.argv[5]

pkgbuild = pkgbuild_path.read_text()
match = re.search(r"^pkgname=(.+)$", pkgbuild, flags=re.M)
if not match:
    raise SystemExit("Could not determine pkgname from PKGBUILD")
pkgname = match.group(1).strip()

renamed = f"{pkgname}-{version}.deb"

text = srcinfo_path.read_text()
text = re.sub(r"^\s*pkgver = .*", f"\tpkgver = {version}", text, flags=re.M)
text = re.sub(r"^\s*pkgrel = .*", "\tpkgrel = 1", text, flags=re.M)
text = re.sub(
    r"^\s*source = .*",
    f"\tsource = {renamed}::{url}",
    text,
    flags=re.M,
)
text = re.sub(r"^\s*noextract = .*", f"\tnoextract = {renamed}", text, flags=re.M)
text = re.sub(r"^\s*sha256sums = .*", f"\tsha256sums = {sha}", text, flags=re.M)
srcinfo_path.write_text(text)
PY
