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

assert_source_contains() {
  local file="$1"
  local source="$2"
  local needle="$3"
  local in_source=0
  local found=0
  local line

  while IFS= read -r line; do
    if [[ "$line" == '# Source: openwork-ee/templates/'* ]]; then
      if [[ "$line" == "# Source: openwork-ee/templates/$source" ]]; then
        in_source=1
      else
        in_source=0
      fi
    fi
    if [[ "$in_source" == 1 && "$line" == *"$needle"* ]]; then
      found=1
      break
    fi
  done < "$file"

  if [[ "$found" != 1 ]]; then
    printf 'Expected %s to contain %s\n' "$source" "$needle" >&2
    return 1
  fi
}

assert_source_not_contains() {
  local file="$1"
  local source="$2"
  local needle="$3"
  local in_source=0
  local line

  while IFS= read -r line; do
    if [[ "$line" == '# Source: openwork-ee/templates/'* ]]; then
      if [[ "$line" == "# Source: openwork-ee/templates/$source" ]]; then
        in_source=1
      else
        in_source=0
      fi
    fi
    if [[ "$in_source" == 1 && "$line" == *"$needle"* ]]; then
      printf 'Expected %s not to contain %s\n' "$source" "$needle" >&2
      return 1
    fi
  done < "$file"
}

default_rendered="$tmp_dir/default.yaml"
helm template openwork-ee "$chart_dir" > "$default_rendered"
assert_count "$default_rendered" 'DEN_ALLOW_PRIVATE_MCP_URLS' 0
assert_not_contains "$default_rendered" 'openwork-ee-den-api-private-mcp-urls'

enabled_values="$tmp_dir/enabled-values.yaml"
enabled_rendered="$tmp_dir/enabled.yaml"
cat > "$enabled_values" <<'YAML'
inference:
  enabled: true
config:
  public:
    allowPrivateMcpUrls: "1"
YAML
helm template openwork-ee "$chart_dir" -f "$enabled_values" > "$enabled_rendered"
assert_count "$enabled_rendered" 'DEN_ALLOW_PRIVATE_MCP_URLS' 2
assert_count "$enabled_rendered" 'name: DEN_ALLOW_PRIVATE_MCP_URLS' 2
assert_count "$enabled_rendered" 'value: "1"' 2
assert_not_contains "$enabled_rendered" 'key: DEN_ALLOW_PRIVATE_MCP_URLS'
assert_not_contains "$enabled_rendered" 'configMapKeyRef:'
assert_not_contains "$enabled_rendered" 'openwork-ee-den-api-private-mcp-urls'
assert_source_contains "$enabled_rendered" 'den-api.yaml' 'name: DEN_ALLOW_PRIVATE_MCP_URLS'
assert_source_contains "$enabled_rendered" 'den-api.yaml' 'value: "1"'
assert_source_not_contains "$enabled_rendered" 'den-web.yaml' 'DEN_ALLOW_PRIVATE_MCP_URLS'
assert_source_not_contains "$enabled_rendered" 'inference.yaml' 'DEN_ALLOW_PRIVATE_MCP_URLS'

disabled_values="$tmp_dir/disabled-values.yaml"
disabled_rendered="$tmp_dir/disabled.yaml"
cat > "$disabled_values" <<'YAML'
config:
  public:
    allowPrivateMcpUrls: "0"
YAML
helm template openwork-ee "$chart_dir" -f "$disabled_values" > "$disabled_rendered"
assert_count "$disabled_rendered" 'DEN_ALLOW_PRIVATE_MCP_URLS' 0

false_values="$tmp_dir/false-values.yaml"
false_rendered="$tmp_dir/false.yaml"
cat > "$false_values" <<'YAML'
config:
  public:
    allowPrivateMcpUrls: "false"
YAML
helm template openwork-ee "$chart_dir" -f "$false_values" > "$false_rendered"
assert_count "$false_rendered" 'DEN_ALLOW_PRIVATE_MCP_URLS' 0

blank_values="$tmp_dir/blank-values.yaml"
blank_rendered="$tmp_dir/blank.yaml"
cat > "$blank_values" <<'YAML'
config:
  public:
    allowPrivateMcpUrls: ""
YAML
helm template openwork-ee "$chart_dir" -f "$blank_values" > "$blank_rendered"
assert_count "$blank_rendered" 'DEN_ALLOW_PRIVATE_MCP_URLS' 0

invalid_true_values="$tmp_dir/invalid-true-values.yaml"
cat > "$invalid_true_values" <<'YAML'
config:
  public:
    allowPrivateMcpUrls: "true"
YAML
assert_failure "$invalid_true_values" 'config.public.allowPrivateMcpUrls must be blank, 0, false, or "1"'

invalid_yes_values="$tmp_dir/invalid-yes-values.yaml"
cat > "$invalid_yes_values" <<'YAML'
config:
  public:
    allowPrivateMcpUrls: "yes"
YAML
assert_failure "$invalid_yes_values" 'config.public.allowPrivateMcpUrls must be blank, 0, false, or "1"'

printf 'private-mcp-urls chart checks passed\n'
