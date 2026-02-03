#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PKG_DIR="${ROOT_DIR}/packaging/aur"
PKGBUILD="${PKG_DIR}/PKGBUILD"
SRCINFO="${PKG_DIR}/.SRCINFO"

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

SHA256=$(python - "${TMP_DIR}/${ASSET_NAME}" <<'PY'
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

python - "$PKGBUILD" "$VERSION" "$SHA256" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
version = sys.argv[2]
sha = sys.argv[3]

text = path.read_text()
text = re.sub(r"^pkgver=.*$", f"pkgver={version}", text, flags=re.M)
text = re.sub(r"^sha256sums=.*$", f"sha256sums=('{sha}')", text, flags=re.M)
path.write_text(text)
PY

python - "$SRCINFO" "$VERSION" "$SHA256" "$ASSET_URL" "$ASSET_NAME" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
version = sys.argv[2]
sha = sys.argv[3]
url = sys.argv[4]
asset = sys.argv[5]

text = path.read_text()
text = re.sub(r"^\s*pkgver = .*", f"  pkgver = {version}", text, flags=re.M)
text = re.sub(
    r"^\s*source = .*",
    f"  source = {asset}::{url}",
    text,
    flags=re.M,
)
text = re.sub(r"^\s*sha256sums = .*", f"  sha256sums = {sha}", text, flags=re.M)
path.write_text(text)
PY
