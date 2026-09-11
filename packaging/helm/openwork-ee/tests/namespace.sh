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

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -F -q -- "$needle" "$file"; then
    printf 'Expected rendered chart to contain %s\n' "$needle" >&2
    return 1
  fi
}

# Default render: every namespaced resource lands in "openwork".
# 9 resources: Namespace, Secret, ConfigMap, den-api/den-web
# Services+Deployments, migration Job, env-probe test Job.
default_rendered="$tmp_dir/default.yaml"
helm template openwork-ee "$chart_dir" > "$default_rendered"
assert_count "$default_rendered" 'kind: Namespace' 1
assert_contains "$default_rendered" 'name: "openwork"'
assert_count "$default_rendered" '  namespace: "openwork"' 8
assert_count "$default_rendered" '  namespace: "kube-system"' 0

# With the migration hook enabled (default), the Namespace renders as the
# earliest hook so first-time installs into a fresh namespace work: hook
# resources (ExternalSecret, migration RBAC/Job) are namespaced and would
# otherwise be created before a normal-manifest Namespace exists.
assert_contains "$default_rendered" 'helm.sh/hook-weight": "-11"'
# The Namespace hook must never carry before-hook-creation: a hook re-run
# would delete and recreate the Namespace, cascade-deleting everything in it.
# (The env-probe test Job legitimately uses before-hook-creation, so scope the
# check to the Namespace document.)
assert_namespace_hook_safe() {
  local file="$1"
  local in_ns=0
  local line
  while IFS= read -r line; do
    if [[ "$line" == 'kind: Namespace' ]]; then
      in_ns=1
    elif [[ "$line" == '---' ]]; then
      in_ns=0
    fi
    if [[ "$in_ns" == 1 && "$line" == *'hook-delete-policy'*'before-hook-creation'* ]]; then
      printf 'Namespace must not use before-hook-creation (cascade-deletes contents on re-run)\n' >&2
      return 1
    fi
  done < "$file"
}
assert_namespace_hook_safe "$default_rendered"

# With the migration hook disabled, the Namespace is a plain manifest.
nohook_rendered="$tmp_dir/nohook.yaml"
helm template openwork-ee "$chart_dir" --set migrations.hook=false > "$nohook_rendered"
assert_count "$nohook_rendered" 'kind: Namespace' 1
assert_count "$nohook_rendered" 'helm.sh/hook-weight": "-11"' 0

# createNamespace=false skips the Namespace object (out-of-band provisioning).
no_nsdef_rendered="$tmp_dir/no-nsdef.yaml"
helm template openwork-ee "$chart_dir" --set createNamespace=false > "$no_nsdef_rendered"
assert_count "$no_nsdef_rendered" 'kind: Namespace' 0

# Full render (ingress + inference enabled): Namespace + 11 namespaced resources.
full_rendered="$tmp_dir/full.yaml"
helm template openwork-ee "$chart_dir" \
  --set ingress.enabled=true --set inference.enabled=true > "$full_rendered"
assert_count "$full_rendered" 'kind: Namespace' 1
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

# The Namespace object name follows the namespace value.
nsdef_override_rendered="$tmp_dir/nsdef-override.yaml"
helm template openwork-ee "$chart_dir" --set namespace=platform > "$nsdef_override_rendered"
assert_count "$nsdef_override_rendered" 'kind: Namespace' 1
assert_contains "$nsdef_override_rendered" 'name: "platform"'

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
