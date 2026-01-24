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
"${ROOT_DIR}/scripts/aur/update-aur.sh" "$TAG"

cd "$ROOT_DIR"

if ! git status --porcelain -- packaging/aur/PKGBUILD packaging/aur/.SRCINFO | grep -q .; then
  echo "AUR packaging already up to date."
  exit 0
fi

BRANCH="chore/aur-${VERSION}"
git switch -c "$BRANCH" 2>/dev/null || git switch "$BRANCH"

git add packaging/aur/PKGBUILD packaging/aur/.SRCINFO
git -c user.name="OpenWork Release Bot" \
    -c user.email="release-bot@users.noreply.github.com" \
    commit -m "chore(aur): update PKGBUILD for ${VERSION}"

git push --set-upstream origin "$BRANCH"

if gh pr list --head "$BRANCH" --state open --json number --jq 'length > 0' | grep -q true; then
  echo "PR already open for ${BRANCH}."
  exit 0
fi

gh pr create --title "chore(aur): update PKGBUILD for ${VERSION}" --base dev --body "$(cat <<'EOF'
## Summary
- Update AUR PKGBUILD and .SRCINFO for the ${VERSION} release
- Refresh sha256 for the Linux .deb release asset
EOF
)"
