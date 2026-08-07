#!/usr/bin/env bash
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -F -q -- "$needle" "$file"; then
    printf 'Expected rendered chart to contain %s\n' "$needle" >&2
    return 1
  fi
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -F -q -- "$needle" "$file"; then
    printf 'Expected rendered chart not to contain %s\n' "$needle" >&2
    return 1
  fi
}

enabled_values="$tmp_dir/enabled-values.yaml"
enabled_rendered="$tmp_dir/enabled.yaml"
cat > "$enabled_values" <<'YAML'
ingress:
  enabled: true
  web:
    host: openwork.example.com
  api:
    enabled: true
    host: api.openwork.example.com
  tls:
    - secretName: openwork-tls
      hosts:
        - openwork.example.com
        - api.openwork.example.com
YAML
helm template openwork-ee "$chart_dir" -f "$enabled_values" > "$enabled_rendered"
assert_contains "$enabled_rendered" 'name: openwork-ee-tls-chain-check'
assert_contains "$enabled_rendered" '"helm.sh/hook": test'
assert_contains "$enabled_rendered" 'image: "alpine/openssl:latest"'
assert_contains "$enabled_rendered" 'value: "openwork.example.com api.openwork.example.com"'
assert_contains "$enabled_rendered" 'TLS chain incomplete:'
assert_contains "$enabled_rendered" 'serve the full chain (leaf + intermediate, fullchain.pem)'
assert_contains "$enabled_rendered" 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'

disabled_values="$tmp_dir/disabled-values.yaml"
disabled_rendered="$tmp_dir/disabled.yaml"
cat > "$disabled_values" <<'YAML'
tests:
  tlsChainCheck:
    enabled: false
ingress:
  enabled: true
  tls:
    - secretName: openwork-tls
      hosts:
        - openwork.example.com
YAML
helm template openwork-ee "$chart_dir" -f "$disabled_values" > "$disabled_rendered"
assert_not_contains "$disabled_rendered" 'openwork-ee-tls-chain-check'
assert_not_contains "$disabled_rendered" 'TLS chain incomplete:'

ingress_disabled_values="$tmp_dir/ingress-disabled-values.yaml"
ingress_disabled_rendered="$tmp_dir/ingress-disabled.yaml"
cat > "$ingress_disabled_values" <<'YAML'
ingress:
  enabled: false
  tls:
    - secretName: openwork-tls
      hosts:
        - openwork.example.com
YAML
helm template openwork-ee "$chart_dir" -f "$ingress_disabled_values" > "$ingress_disabled_rendered"
assert_not_contains "$ingress_disabled_rendered" 'openwork-ee-tls-chain-check'
assert_not_contains "$ingress_disabled_rendered" 'TLS chain incomplete:'

printf 'tls-chain-check chart checks passed\n'
