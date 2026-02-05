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

if [ -z "${AUR_SSH_PRIVATE_KEY:-}" ]; then
  echo "AUR_SSH_PRIVATE_KEY is required to push to AUR." >&2
  exit 1
fi

# AUR package repo name (AUR repo = ssh://aur@aur.archlinux.org/<name>.git)
AUR_REPO="${AUR_REPO:-openwork}"
AUR_REMOTE="ssh://aur@aur.archlinux.org/${AUR_REPO}.git"

if [ "${AUR_SKIP_UPDATE:-}" != "1" ]; then
  "${ROOT_DIR}/scripts/aur/update-aur.sh" "$TAG"
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

KEY_PATH="${TMP_DIR}/aur.key"
printf '%s' "$AUR_SSH_PRIVATE_KEY" > "$KEY_PATH"
chmod 600 "$KEY_PATH"

mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/known_hosts"

if ! ssh-keygen -F aur.archlinux.org >/dev/null 2>&1; then
  ssh-keyscan -t rsa,ecdsa,ed25519 aur.archlinux.org >> "$HOME/.ssh/known_hosts" 2>/dev/null
fi

export GIT_SSH_COMMAND="ssh -i $KEY_PATH -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"

git clone "$AUR_REMOTE" "$TMP_DIR/aur"

cp "$ROOT_DIR/packaging/aur/PKGBUILD" "$TMP_DIR/aur/PKGBUILD"
cp "$ROOT_DIR/packaging/aur/.SRCINFO" "$TMP_DIR/aur/.SRCINFO"

cd "$TMP_DIR/aur"

if git diff --quiet -- PKGBUILD .SRCINFO; then
  echo "AUR already up to date for ${AUR_REPO} (${VERSION})."
  exit 0
fi

git add PKGBUILD .SRCINFO
git -c user.name="OpenWork Release Bot" \
    -c user.email="release-bot@users.noreply.github.com" \
    commit -m "chore(aur): update PKGBUILD for ${VERSION}"

current_branch=$(git symbolic-ref --short HEAD 2>/dev/null || true)
if [ -z "$current_branch" ]; then
  current_branch="master"
fi

git push origin "HEAD:${current_branch}"
