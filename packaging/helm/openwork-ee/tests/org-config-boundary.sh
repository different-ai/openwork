#!/usr/bin/env bash
set -euo pipefail

chart="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helm lint "$chart"
helm template openwork "$chart" >/dev/null
helm lint "$chart" -f "$chart/examples/values.minimal-capabilities.yaml"
helm template openwork "$chart" -f "$chart/examples/values.minimal-capabilities.yaml" >/dev/null

expect_rejection() {
  local expected="$1" output
  shift
  if output=$(helm template openwork "$chart" "$@" 2>&1); then
    echo "Expected Helm to reject: $*" >&2
    return 1
  fi
  if ! grep -Fq "$expected" <<< "$output"; then
    printf '%s\nExpected error: %s\n' "$output" "$expected" >&2
    return 1
  fi
}

guidance='Use Organization Config Import (acme.config.json) instead.'
for capture_on in true false; do
  expect_rejection "config.audit.captureOn is not a Helm setting. Remove it from your Helm values and set settings.audit → spec.captureOn. $guidance" \
    --is-upgrade --set "config.audit.captureOn=$capture_on"
done
expect_rejection "An organization config file was passed as Helm values. Remove it from the Helm command. $guidance" \
  -f "$chart/examples/org-config.example.json"

# The deployment gate is still supported and keeps its install-wide meaning.
rendered=$(helm template openwork "$chart" --is-upgrade --set-string config.audit.captureEnabled=false)
grep -Fq 'DEN_AUDIT_CAPTURE_ENABLED: "false"' <<< "$rendered"
