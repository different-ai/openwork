#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${1:-}"
HEAD_SHA="${2:-}"
TAG="${3:-}"
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

if [[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || [[ ! "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Signed branch verification requires source and head commit SHAs." >&2
  exit 1
fi
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Signed branch verification requires a stable tag." >&2
  exit 1
fi
if [ -z "${COMMIT_SIGNING_KEY:-}" ]; then
  echo "Missing required secret: COMMIT_SIGNING_KEY" >&2
  exit 1
fi

key_path="$RUNNER_TEMP/release-signing-key"
allowed_signers="$RUNNER_TEMP/release-allowed-signers"
trap 'rm -f "$key_path" "$allowed_signers"' EXIT
umask 077
printf '%s\n' "$COMMIT_SIGNING_KEY" > "$key_path"
chmod 600 "$key_path"
public_key="$(ssh-keygen -y -f "$key_path")"
printf '%s %s\n' '11430621+benjaminshafii@users.noreply.github.com' "$public_key" > "$allowed_signers"

git -C "$ROOT_DIR" config --local gpg.format ssh
git -C "$ROOT_DIR" config --local gpg.ssh.allowedSignersFile "$allowed_signers"
git -C "$ROOT_DIR" merge-base --is-ancestor "$SOURCE_SHA" "$HEAD_SHA"

commits=("$SOURCE_SHA")
while IFS= read -r commit; do
  if [ -n "$commit" ]; then commits+=("$commit"); fi
done < <(git -C "$ROOT_DIR" rev-list --reverse "$SOURCE_SHA..$HEAD_SHA")

for commit in "${commits[@]}"; do
  git -C "$ROOT_DIR" verify-commit "$commit"
done

while IFS= read -r path; do
  case "$path" in
    packaging/aur/PKGBUILD|packaging/aur/.SRCINFO|.github/releases/"$TAG"/*) ;;
    *)
      echo "Unexpected post-build release branch change: $path" >&2
      exit 1
      ;;
  esac
done < <(git -C "$ROOT_DIR" diff --name-only "$SOURCE_SHA..$HEAD_SHA")
