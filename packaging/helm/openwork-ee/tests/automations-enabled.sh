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

default_rendered="$tmp_dir/default.yaml"
helm template openwork-ee "$chart_dir" > "$default_rendered"
assert_contains "$default_rendered" 'DEN_AUTOMATIONS_ENABLED: "false"'
assert_contains "$default_rendered" 'DEN_AUTOMATIONS_RUNTIME_ENABLED: "true"'

enabled_values="$tmp_dir/enabled-values.yaml"
enabled_rendered="$tmp_dir/enabled.yaml"
printf '%s\n' 'config:' '  public:' '    automationsEnabled: "true"' > "$enabled_values"
helm template openwork-ee "$chart_dir" -f "$enabled_values" > "$enabled_rendered"
assert_contains "$enabled_rendered" 'DEN_AUTOMATIONS_ENABLED: "true"'

disabled_values="$tmp_dir/disabled-values.yaml"
disabled_rendered="$tmp_dir/disabled.yaml"
printf '%s\n' 'config:' '  public:' '    automationsRuntimeEnabled: "false"' > "$disabled_values"
helm template openwork-ee "$chart_dir" -f "$disabled_values" > "$disabled_rendered"
assert_contains "$disabled_rendered" 'DEN_AUTOMATIONS_RUNTIME_ENABLED: "false"'

printf 'automations-enabled chart checks passed\n'
