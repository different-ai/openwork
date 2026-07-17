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

assert_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -F -q -- "$needle" "$file"; then
    printf 'Expected rendered chart not to contain %s\n' "$needle" >&2
    return 1
  fi
}

assert_failure() {
  local values_file="$1"
  local expected="$2"
  local output_file="$tmp_dir/failure-output.yaml"
  local error_file="$tmp_dir/failure-error.txt"

  if helm template openwork-ee "$chart_dir" -f "$values_file" > "$output_file" 2> "$error_file"; then
    printf 'Expected helm template to fail for %s\n' "$values_file" >&2
    return 1
  fi
  assert_contains "$error_file" "$expected"
}

default_rendered="$tmp_dir/default.yaml"
disabled_values="$tmp_dir/disabled-values.yaml"
disabled_rendered="$tmp_dir/disabled.yaml"
helm template openwork-ee "$chart_dir" --set inference.enabled=true > "$default_rendered"
cat > "$disabled_values" <<'YAML'
inference:
  enabled: true
customCa:
  enabled: false
  existingSecret: ignored-ca-secret
  key: ignored.pem
YAML
helm template openwork-ee "$chart_dir" -f "$disabled_values" > "$disabled_rendered"
cmp -s "$default_rendered" "$disabled_rendered"
assert_not_contains "$default_rendered" 'name: NODE_EXTRA_CA_CERTS'
assert_not_contains "$default_rendered" '/etc/openwork/custom-ca'
assert_not_contains "$default_rendered" 'name: custom-ca'

secret_values="$tmp_dir/secret-values.yaml"
secret_rendered="$tmp_dir/secret.yaml"
cat > "$secret_values" <<'YAML'
customCa:
  enabled: true
  existingSecret: openwork-ca-secret
  key: corp-root.pem
YAML
helm template openwork-ee "$chart_dir" -f "$secret_values" > "$secret_rendered"
assert_count "$secret_rendered" 'name: NODE_EXTRA_CA_CERTS' 3
assert_count "$secret_rendered" 'value: "/etc/openwork/custom-ca/ca-bundle.pem"' 3
assert_count "$secret_rendered" 'name: custom-ca' 6
assert_count "$secret_rendered" 'secretName: "openwork-ca-secret"' 3
assert_count "$secret_rendered" 'key: "corp-root.pem"' 3
assert_count "$secret_rendered" 'path: ca-bundle.pem' 3
assert_count "$secret_rendered" 'mountPath: "/etc/openwork/custom-ca"' 3
assert_not_contains "$secret_rendered" 'subPath:'
assert_not_contains "$secret_rendered" 'name: "openwork-ca-config"'
assert_not_contains "$secret_rendered" 'name: openwork-ee-inference'

configmap_values="$tmp_dir/configmap-values.yaml"
configmap_rendered="$tmp_dir/configmap.yaml"
cat > "$configmap_values" <<'YAML'
inference:
  enabled: true
customCa:
  enabled: true
  existingConfigMap: openwork-ca-config
  key: ca.crt
YAML
helm template openwork-ee "$chart_dir" -f "$configmap_values" > "$configmap_rendered"
assert_contains "$configmap_rendered" 'name: openwork-ee-den-api'
assert_contains "$configmap_rendered" 'name: openwork-ee-den-web'
assert_contains "$configmap_rendered" 'name: openwork-ee-inference'
assert_contains "$configmap_rendered" 'name: openwork-ee-migrate'
assert_count "$configmap_rendered" 'name: NODE_EXTRA_CA_CERTS' 4
assert_count "$configmap_rendered" 'value: "/etc/openwork/custom-ca/ca-bundle.pem"' 4
assert_count "$configmap_rendered" 'name: custom-ca' 8
assert_count "$configmap_rendered" 'name: "openwork-ca-config"' 4
assert_count "$configmap_rendered" 'key: "ca.crt"' 4
assert_count "$configmap_rendered" 'path: ca-bundle.pem' 4
assert_count "$configmap_rendered" 'mountPath: "/etc/openwork/custom-ca"' 4
assert_not_contains "$configmap_rendered" 'subPath:'
assert_not_contains "$configmap_rendered" 'secretName: "openwork-ca-secret"'

installer_values="$tmp_dir/installer-values.yaml"
installer_rendered="$tmp_dir/installer.yaml"
cat > "$installer_values" <<'YAML'
customCa:
  enabled: true
  existingSecret: openwork-ca-secret
installerArtifacts:
  enabled: true
  existingClaim: installer-artifacts-pvc
YAML
helm template openwork-ee "$chart_dir" -f "$installer_values" > "$installer_rendered"
assert_contains "$installer_rendered" 'name: installer-artifacts'
assert_contains "$installer_rendered" 'claimName: "installer-artifacts-pvc"'
assert_contains "$installer_rendered" 'name: OPENWORK_INSTALLER_ARTIFACTS_DIR'
assert_contains "$installer_rendered" 'name: custom-ca'
assert_contains "$installer_rendered" 'name: NODE_EXTRA_CA_CERTS'

missing_source_values="$tmp_dir/missing-source-values.yaml"
cat > "$missing_source_values" <<'YAML'
customCa:
  enabled: true
YAML
assert_failure "$missing_source_values" 'customCa.existingSecret or customCa.existingConfigMap is required when customCa.enabled=true'

multiple_sources_values="$tmp_dir/multiple-sources-values.yaml"
cat > "$multiple_sources_values" <<'YAML'
customCa:
  enabled: true
  existingSecret: openwork-ca-secret
  existingConfigMap: openwork-ca-config
YAML
assert_failure "$multiple_sources_values" 'customCa.existingSecret and customCa.existingConfigMap are mutually exclusive when customCa.enabled=true'

empty_key_values="$tmp_dir/empty-key-values.yaml"
cat > "$empty_key_values" <<'YAML'
customCa:
  enabled: true
  existingSecret: openwork-ca-secret
  key: ""
YAML
assert_failure "$empty_key_values" 'customCa.key is required when customCa.enabled=true'

den_api_conflict_values="$tmp_dir/den-api-conflict-values.yaml"
cat > "$den_api_conflict_values" <<'YAML'
customCa:
  enabled: true
  existingSecret: openwork-ca-secret
denApi:
  env:
    NODE_EXTRA_CA_CERTS: /already/set.pem
YAML
assert_failure "$den_api_conflict_values" 'denApi.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead'

den_web_conflict_values="$tmp_dir/den-web-conflict-values.yaml"
cat > "$den_web_conflict_values" <<'YAML'
customCa:
  enabled: true
  existingSecret: openwork-ca-secret
denWeb:
  env:
    NODE_EXTRA_CA_CERTS: /already/set.pem
YAML
assert_failure "$den_web_conflict_values" 'denWeb.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead'

inference_conflict_values="$tmp_dir/inference-conflict-values.yaml"
cat > "$inference_conflict_values" <<'YAML'
customCa:
  enabled: true
  existingSecret: openwork-ca-secret
inference:
  env:
    NODE_EXTRA_CA_CERTS: /already/set.pem
YAML
assert_failure "$inference_conflict_values" 'inference.env.NODE_EXTRA_CA_CERTS conflicts with customCa.enabled=true; remove it and use customCa instead'

node "$chart_dir/tests/custom-ca-node-trust.mjs"
