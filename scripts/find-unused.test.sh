#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_SCRIPT="$SCRIPT_DIR/find-unused.sh"
BASH_BIN="${BASH_BIN:-/bin/bash}"

fail() {
  echo "find-unused test failed: $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  case "$haystack" in
    *"$needle"*) ;;
    *) fail "missing output: $needle" ;;
  esac
}

line_number() {
  local haystack="$1"
  local needle="$2"
  printf '%s\n' "$haystack" | awk -v needle="$needle" 'index($0, needle) { print NR; exit }'
}

assert_before() {
  local haystack="$1"
  local first="$2"
  local second="$3"
  local first_line
  local second_line
  first_line=$(line_number "$haystack" "$first")
  second_line=$(line_number "$haystack" "$second")
  [ -n "$first_line" ] || fail "missing ordered entry: $first"
  [ -n "$second_line" ] || fail "missing ordered entry: $second"
  [ "$first_line" -lt "$second_line" ] || fail "expected $first before $second"
}

if grep -q 'declare -A' "$SOURCE_SCRIPT"; then
  fail "associative arrays are not supported by macOS Bash 3.2"
fi
if grep -q 'apps/desktop/src-tauri/tauri.conf.json' "$SOURCE_SCRIPT"; then
  fail "stale Tauri config path is still indexed"
fi
if grep -q 'apps/story-book/vite.config.ts' "$SOURCE_SCRIPT"; then
  fail "stale Storybook config path is still indexed"
fi
grep -q '"apps/ui-demo/vite.config.ts"' "$SOURCE_SCRIPT" || fail "live UI demo config path was removed"

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/find-unused-test.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT
repo="$tmp_dir/repo"

mkdir -p \
  "$repo/scripts" \
  "$repo/src" \
  "$repo/ee/apps/den-web/app" \
  "$repo/.github/workflows" \
  "$tmp_dir/bin"
cp "$SOURCE_SCRIPT" "$repo/scripts/find-unused.sh"

printf '%s\n' '#!/usr/bin/env sh' 'exit 99' > "$tmp_dir/bin/npx"
chmod +x "$tmp_dir/bin/npx"

git init -q "$repo"
git -C "$repo" config user.name "find-unused fixture"
git -C "$repo" config user.email "fixture@example.invalid"

commit_fixture() {
  local date="$1"
  local message="$2"
  git -C "$repo" add .
  GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" \
    git -C "$repo" commit -qm "$message"
}

printf '%s\n' 'export const safeOld = true;' > "$repo/src/safe-old.ts"
commit_fixture "2020-01-01T00:00:00Z" "add older safe candidate"

printf '%s\n' 'export default function Page() { return null; }' > "$repo/ee/apps/den-web/app/page.tsx"
commit_fixture "2021-01-01T00:00:00Z" "add convention route candidate"

printf '%s\n' 'export const safeNew = true;' > "$repo/src/safe-new.ts"
commit_fixture "2022-01-01T00:00:00Z" "add newer safe candidate"

printf '%s\n' 'export const infraUsed = true;' > "$repo/src/infra-used.ts"
printf '%s\n' 'tracked-source: src/infra-used.ts' > "$repo/.github/workflows/test.yml"
commit_fixture "2023-01-01T00:00:00Z" "add infra-referenced candidate"

printf '%s\n' \
  'Unused files (4)' \
  'src/safe-new.ts' \
  'ee/apps/den-web/app/page.tsx' \
  'src/infra-used.ts' \
  'src/safe-old.ts' > "$repo/knip-output.txt"

output=$(
  PATH="$tmp_dir/bin:$PATH" \
  FIND_UNUSED_KNIP_OUTPUT_FILE="$repo/knip-output.txt" \
    "$BASH_BIN" "$repo/scripts/find-unused.sh" 2> "$tmp_dir/stderr"
)

assert_contains "$output" "safe to remove (2)"
assert_contains "$output" "referenced in infra/CI (2)"
assert_contains "$output" "./src/safe-old.ts:1"
assert_contains "$output" "./src/safe-new.ts:1"
assert_contains "$output" "./ee/apps/den-web/app/page.tsx:1"
assert_contains "$output" "./src/infra-used.ts:1"
assert_contains "$output" ".github/workflows/test.yml"

assert_before "$output" "./src/safe-old.ts:1" "./src/safe-new.ts:1"
assert_before "$output" "./ee/apps/den-web/app/page.tsx:1" "./src/infra-used.ts:1"

printf '%s\n' 'Unused files (1)' 'src/safe-old.ts' > "$repo/knip-safe-only.txt"
safe_only_output=$(
  PATH="$tmp_dir/bin:$PATH" \
  FIND_UNUSED_KNIP_OUTPUT_FILE="$repo/knip-safe-only.txt" \
    "$BASH_BIN" "$repo/scripts/find-unused.sh" 2> "$tmp_dir/safe-only-stderr"
)
assert_contains "$safe_only_output" "safe to remove (1)"
assert_contains "$safe_only_output" "referenced in infra/CI (0)"

printf '%s\n' 'Unused files (1)' 'ee/apps/den-web/app/page.tsx' > "$repo/knip-review-only.txt"
review_only_output=$(
  PATH="$tmp_dir/bin:$PATH" \
  FIND_UNUSED_KNIP_OUTPUT_FILE="$repo/knip-review-only.txt" \
    "$BASH_BIN" "$repo/scripts/find-unused.sh" 2> "$tmp_dir/review-only-stderr"
)
assert_contains "$review_only_output" "safe to remove (0)"
assert_contains "$review_only_output" "referenced in infra/CI (1)"

echo "find-unused fixture passed with $("$BASH_BIN" --version | sed -n '1p')"
