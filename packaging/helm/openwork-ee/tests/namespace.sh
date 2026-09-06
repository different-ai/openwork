#!/usr/bin/env bash
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

assert_count() {
  local file="$1"
  local needle="$2"
  local expected="$3"
  local count
  count="$(grep -F -c -- "$needle" "$file" || true)"
  if [[ "$count" != "$expected" ]]; then
    printf 'Expected %s occurrences of %s, found %s\n' "$expected" "$needle" "$count" >&2
    return 1
  fi
}

# Default render: every namespaced resource lands in "openwork".
# 8 resources: Secret, ConfigMap, den-api/den-web Services+Deployments,
# migration Job, env-probe test Job.
default_rendered="$tmp_dir/default.yaml"
helm template openwork-ee "$chart_dir" > "$default_rendered"
assert_count "$default_rendered" '  namespace: "openwork"' 8
assert_count "$default_rendered" '  namespace: "kube-system"' 0

# Full render (ingress + inference enabled): 11 namespaced resources.
full_rendered="$tmp_dir/full.yaml"
helm template openwork-ee "$chart_dir" \
  --set ingress.enabled=true --set inference.enabled=true > "$full_rendered"
assert_count "$full_rendered" '  namespace: "openwork"' 11

# Explicit override wins on every resource.
override_rendered="$tmp_dir/override.yaml"
helm template openwork-ee "$chart_dir" --set namespace=platform > "$override_rendered"
assert_count "$override_rendered" '  namespace: "platform"' 8
assert_count "$override_rendered" '  namespace: "openwork"' 0

# Cleared value falls back to the release namespace.
fallback_rendered="$tmp_dir/fallback.yaml"
helm template openwork-ee "$chart_dir" --namespace rel-ns --set namespace= > "$fallback_rendered"
assert_count "$fallback_rendered" '  namespace: "rel-ns"' 8

# Numeric and YAML-keyword overrides stay quoted strings: --set types these as
# number/bool, and metadata.namespace must render as a quoted string.
numeric_rendered="$tmp_dir/numeric.yaml"
helm template openwork-ee "$chart_dir" --set namespace=123 > "$numeric_rendered"
assert_count "$numeric_rendered" '  namespace: "123"' 8
assert_count "$numeric_rendered" '  namespace: 123' 0

keyword_rendered="$tmp_dir/keyword.yaml"
helm template openwork-ee "$chart_dir" --set namespace=yes > "$keyword_rendered"
assert_count "$keyword_rendered" '  namespace: "yes"' 8
assert_count "$keyword_rendered" '  namespace: yes' 0

printf 'namespace chart checks passed\n'
