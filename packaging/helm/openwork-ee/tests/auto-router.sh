#!/usr/bin/env bash
set -euo pipefail

# AI Gateway Smart Model Router: the gateway reads the TypeSafe (Jev) key from
# the chart Secret (or the operator's existing Secret), optionally.
chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
rendered="$tmp_dir/rendered.yaml"
assertions=0
gateway=(--set gateway.enabled=true
  --set config.internal.gatewayProxyBaseUrl=http://openwork-ee-inference:8791
  --set config.public.gatewayPublicBaseUrl=https://gateway.example.com)
created=(--set secret.values.databaseUrl=mysql://test:fixture@mysql:3306/openwork
  --set secret.values.denDbEncryptionKey=fixture-encryption-key-at-least-32-characters)

render() {
  helm template openwork-ee "$chart_dir" "$@" > "$rendered"
}

contains() {
  if ! grep -F -q -- "$1" "$rendered"; then
    printf 'Expected rendered chart to contain %s\n' "$1" >&2
    return 1
  fi
  assertions=$((assertions + 1))
}

absent() {
  if grep -F -q -- "$1" "$rendered"; then
    printf 'Expected rendered chart not to contain %s\n' "$1" >&2
    return 1
  fi
  assertions=$((assertions + 1))
}

# Unset: the Secret has no key, and the gateway's optional reference stays harmless.
render "${gateway[@]}" "${created[@]}"
absent 'TYPESAFE_API_KEY: '
contains '- name: TYPESAFE_API_KEY'
contains 'optional: true'

# Set: rendered into the chart Secret under the configured key.
render "${gateway[@]}" "${created[@]}" --set-string secret.values.typesafeApiKey=tsk_chart_test
contains 'TYPESAFE_API_KEY: "tsk_chart_test"'

# A custom key name is used by both the Secret and the gateway reference.
render "${gateway[@]}" "${created[@]}" --set-string secret.values.typesafeApiKey=tsk_chart_test --set-string secret.keys.typesafeApiKey=JEV_KEY
contains 'JEV_KEY: "tsk_chart_test"'
contains 'key: "JEV_KEY"'

# An existing Secret is never written by the chart; the gateway still reads it.
render "${gateway[@]}" --set secret.create=false --set-string secret.existingSecret=operator-secret --set-string secret.values.typesafeApiKey=tsk_chart_test
absent 'tsk_chart_test'
contains 'name: "operator-secret"'

# Without the gateway there is nothing to configure.
render "${created[@]}" --set-string secret.values.typesafeApiKey=tsk_chart_test
absent '- name: TYPESAFE_API_KEY'

printf 'auto-router chart tests passed (%s assertions)\n' "$assertions"
