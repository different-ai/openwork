#!/usr/bin/env bash
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

assert_contains() {
  if ! grep -F -q -- "$2" "$1"; then
    printf 'Expected rendered chart to contain %s\n' "$2" >&2
    return 1
  fi
}

helm template openwork-ee "$chart_dir" > "$tmp_dir/default.yaml"
assert_contains "$tmp_dir/default.yaml" 'DEN_AUDIT_SELF_HOSTED_ENABLED: "false"'
assert_contains "$tmp_dir/default.yaml" 'DEN_AUDIT_CAPTURE_ENABLED: "true"'
assert_contains "$tmp_dir/default.yaml" 'DEN_AUDIT_VISIBILITY_ENABLED: "true"'

helm template openwork-ee "$chart_dir" --set-string config.audit.captureEnabled=false --set-string config.audit.visibilityEnabled=false --set-string config.audit.selfHostedEnabled=true > "$tmp_dir/disabled.yaml"
assert_contains "$tmp_dir/disabled.yaml" 'DEN_AUDIT_SELF_HOSTED_ENABLED: "true"'
assert_contains "$tmp_dir/disabled.yaml" 'DEN_AUDIT_CAPTURE_ENABLED: "false"'
assert_contains "$tmp_dir/disabled.yaml" 'DEN_AUDIT_VISIBILITY_ENABLED: "false"'
printf 'audit-enabled chart checks passed (6 assertions)\n'
