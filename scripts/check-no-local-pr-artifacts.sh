#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

changed_files="$(
  {
    git diff --name-only --diff-filter=ACMR HEAD -- .
    git ls-files --others --exclude-standard
  } | awk 'NF' | sort -u
)"

offending_files="$(printf '%s\n' "$changed_files" | rg '^(artifacts/|tmp/verification/)' || true)"

if [[ -n "$offending_files" ]]; then
  cat >&2 <<EOF
Local PR proof files are not allowed in git changes.
Publish screenshots/videos via the Factory Supabase evidence workflow instead.

Offending paths:
$offending_files
EOF
  exit 1
fi
