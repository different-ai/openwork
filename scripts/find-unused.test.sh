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
if grep -Eq 'safe to remove|removable' "$SOURCE_SCRIPT"; then
  fail "absence from imports must not be presented as deletion-safe"
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/find-unused-test.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT
repo="$tmp_dir/repo"

mkdir -p \
  "$repo/scripts" \
  "$repo/src" \
  "$repo/ee/apps/den-web/app" \
  "$repo/.github/workflows" \
  "$repo/.opencode/skills/example/scripts" \
  "$repo/evals/drivers" \
  "$repo/packages/widget/test" \
  "$repo/packages/widget/tests" \
  "$repo/packages/widget/__tests__" \
  "$repo/packages/widget/evals" \
  "$repo/packages/widget/scripts" \
  "$repo/packages/widget/bin" \
  "$repo/packages/widget/src" \
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

printf '%s\n' 'export const directTest = true;' > "$repo/src/isolated.test.ts"
printf '%s\n' 'export const directSpec = true;' > "$repo/src/isolated.spec.ts"
printf '%s\n' 'export const testDirectory = true;' > "$repo/packages/widget/test/directory.ts"
printf '%s\n' 'export const testsDirectory = true;' > "$repo/packages/widget/tests/directory.ts"
printf '%s\n' 'export const underscoreTests = true;' > "$repo/packages/widget/__tests__/unit.ts"
printf '%s\n' 'export const rootEval = true;' > "$repo/evals/drivers/standalone.mjs"
printf '%s\n' 'export const nestedEval = true;' > "$repo/packages/widget/evals/nested.mjs"
printf '%s\n' '#!/usr/bin/env sh' 'exit 0' > "$repo/.opencode/skills/example/scripts/runner.sh"
printf '%s\n' 'export const release = true;' > "$repo/packages/widget/scripts/release.mjs"
printf '%s\n' 'export const tool = true;' > "$repo/packages/widget/bin/tool.mjs"
printf '%s\n' 'export const manifestRunner = true;' > "$repo/packages/widget/src/manifest-runner.mjs"
printf '%s\n' 'export const manifestCli = true;' > "$repo/packages/widget/src/manifest-cli.mjs"
printf '%s\n' \
  '{' \
  '  "name": "fixture-widget",' \
  '  "bin": { "fixture-widget": "./src/manifest-cli.mjs" },' \
  '  "scripts": { "fixture:run": "node ./src/manifest-runner.mjs" }' \
  '}' > "$repo/packages/widget/package.json"
commit_fixture "2024-01-01T00:00:00Z" "add convention and manifest entrypoints"

printf '%s\n' \
  'Unused files (16)' \
  'packages/widget/src/manifest-runner.mjs' \
  'src/safe-new.ts' \
  'packages/widget/tests/directory.ts' \
  'evals/drivers/standalone.mjs' \
  'src/isolated.test.ts' \
  'packages/widget/bin/tool.mjs' \
  'ee/apps/den-web/app/page.tsx' \
  '.opencode/skills/example/scripts/runner.sh' \
  'src/infra-used.ts' \
  'packages/widget/evals/nested.mjs' \
  'packages/widget/test/directory.ts' \
  'src/isolated.spec.ts' \
  'packages/widget/scripts/release.mjs' \
  'packages/widget/src/manifest-cli.mjs' \
  'packages/widget/__tests__/unit.ts' \
  'src/safe-old.ts' > "$repo/knip-output.txt"

output=$(
  PATH="$tmp_dir/bin:$PATH" \
  FIND_UNUSED_KNIP_OUTPUT_FILE="$repo/knip-output.txt" \
    "$BASH_BIN" "$repo/scripts/find-unused.sh" 2> "$tmp_dir/stderr"
)

assert_contains "$output" "no known entrypoint/config signal (2)"
assert_contains "$output" "known entrypoint/config signal (14)"
assert_contains "$output" "./src/safe-old.ts:1"
assert_contains "$output" "./src/safe-new.ts:1"
assert_contains "$output" "./ee/apps/den-web/app/page.tsx:1"
assert_contains "$output" "./src/infra-used.ts:1"
assert_contains "$output" ".github/workflows/test.yml"
assert_contains "$output" "./src/isolated.test.ts:1"
assert_contains "$output" "./src/isolated.spec.ts:1"
assert_contains "$output" "./packages/widget/test/directory.ts:1"
assert_contains "$output" "./packages/widget/tests/directory.ts:1"
assert_contains "$output" "./packages/widget/__tests__/unit.ts:1"
assert_contains "$output" "./evals/drivers/standalone.mjs:1"
assert_contains "$output" "./packages/widget/evals/nested.mjs:1"
assert_contains "$output" "./.opencode/skills/example/scripts/runner.sh:1"
assert_contains "$output" "./packages/widget/scripts/release.mjs:1"
assert_contains "$output" "./packages/widget/bin/tool.mjs:1"
assert_contains "$output" "./packages/widget/src/manifest-runner.mjs:1"
assert_contains "$output" "./packages/widget/src/manifest-cli.mjs:1"
assert_contains "$output" "test entrypoint convention"
assert_contains "$output" "eval entrypoint convention"
assert_contains "$output" "OpenCode skill script entrypoint convention"
assert_contains "$output" "script entrypoint convention"
assert_contains "$output" "package binary entrypoint convention"
assert_contains "$output" "package manifest: packages/widget/package.json"
assert_contains "$output" "2 need investigation"
assert_contains "$output" "14 have review signals"
assert_contains "$output" "not a deletion verdict"

review_heading="REVIEW — known entrypoint/config signal"
assert_before "$output" "./src/safe-old.ts:1" "$review_heading"
assert_before "$output" "./src/safe-new.ts:1" "$review_heading"
for review_path in \
  "./ee/apps/den-web/app/page.tsx:1" \
  "./src/infra-used.ts:1" \
  "./src/isolated.test.ts:1" \
  "./src/isolated.spec.ts:1" \
  "./packages/widget/test/directory.ts:1" \
  "./packages/widget/tests/directory.ts:1" \
  "./packages/widget/__tests__/unit.ts:1" \
  "./evals/drivers/standalone.mjs:1" \
  "./packages/widget/evals/nested.mjs:1" \
  "./.opencode/skills/example/scripts/runner.sh:1" \
  "./packages/widget/scripts/release.mjs:1" \
  "./packages/widget/bin/tool.mjs:1" \
  "./packages/widget/src/manifest-runner.mjs:1" \
  "./packages/widget/src/manifest-cli.mjs:1"; do
  assert_before "$output" "$review_heading" "$review_path"
done

assert_before "$output" "./src/safe-old.ts:1" "./src/safe-new.ts:1"
assert_before "$output" "./ee/apps/den-web/app/page.tsx:1" "./src/infra-used.ts:1"

printf '%s\n' 'Unused files (1)' 'src/safe-old.ts' > "$repo/knip-candidate-only.txt"
candidate_only_output=$(
  PATH="$tmp_dir/bin:$PATH" \
  FIND_UNUSED_KNIP_OUTPUT_FILE="$repo/knip-candidate-only.txt" \
    "$BASH_BIN" "$repo/scripts/find-unused.sh" 2> "$tmp_dir/candidate-only-stderr"
)
assert_contains "$candidate_only_output" "no known entrypoint/config signal (1)"
assert_contains "$candidate_only_output" "known entrypoint/config signal (0)"

printf '%s\n' 'Unused files (1)' 'ee/apps/den-web/app/page.tsx' > "$repo/knip-review-only.txt"
review_only_output=$(
  PATH="$tmp_dir/bin:$PATH" \
  FIND_UNUSED_KNIP_OUTPUT_FILE="$repo/knip-review-only.txt" \
    "$BASH_BIN" "$repo/scripts/find-unused.sh" 2> "$tmp_dir/review-only-stderr"
)
assert_contains "$review_only_output" "no known entrypoint/config signal (0)"
assert_contains "$review_only_output" "known entrypoint/config signal (1)"

echo "find-unused fixture passed with $("$BASH_BIN" --version | sed -n '1p')"
