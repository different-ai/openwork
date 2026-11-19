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
assert_contains "$default_rendered" 'DEN_AUTOMATIONS_ENABLED: "true"'
assert_contains "$default_rendered" 'DEN_AUTOMATIONS_RUNTIME_ENABLED: "true"'

off_values="$tmp_dir/off-values.yaml"
off_rendered="$tmp_dir/off.yaml"
printf '%s\n' 'config:' '  public:' '    automationsEnabled: "false"' > "$off_values"
helm template openwork-ee "$chart_dir" -f "$off_values" > "$off_rendered"
assert_contains "$off_rendered" 'DEN_AUTOMATIONS_ENABLED: "false"'

disabled_values="$tmp_dir/disabled-values.yaml"
disabled_rendered="$tmp_dir/disabled.yaml"
printf '%s\n' 'config:' '  public:' '    automationsRuntimeEnabled: "false"' > "$disabled_values"
helm template openwork-ee "$chart_dir" -f "$disabled_values" > "$disabled_rendered"
assert_contains "$disabled_rendered" 'DEN_AUTOMATIONS_RUNTIME_ENABLED: "false"'

printf 'automations-enabled chart checks passed\n'
