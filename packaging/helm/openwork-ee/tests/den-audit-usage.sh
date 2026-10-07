#!/usr/bin/env bash
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
rendered="$tmp_dir/rendered.yaml"
assertions=0
token="maintenance-token-for-chart-tests-0123456789"

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

count() {
  local actual
  actual="$(grep -F -c -- "$1" "$rendered" || true)"
  if [ "$actual" != "$2" ]; then
    printf 'Expected %s occurrences of %s, found %s\n' "$2" "$1" "$actual" >&2
    return 1
  fi
  assertions=$((assertions + 1))
}

fails_with() {
  local message="$1"
  shift
  if helm template openwork-ee "$chart_dir" "$@" > "$tmp_dir/failed.yaml" 2> "$tmp_dir/error.txt"; then
    printf 'Expected render to fail with %s\n' "$message" >&2
    return 1
  fi
  if ! grep -F -q -- "$message" "$tmp_dir/error.txt"; then
    printf 'Expected render error %s, got:\n' "$message" >&2
    cat "$tmp_dir/error.txt" >&2
    return 1
  fi
  assertions=$((assertions + 1))
}

# Off by default: no CronJob, no token on den-api, no token key in the Secret.
render
absent 'name: openwork-ee-den-audit-usage'
absent 'DEN_MAINTENANCE_TOKEN'

# Token in the chart Secret: CronJob calls the den-api Service, den-api gets the same key.
render --set denApi.auditUsage.enabled=true --set-string secret.values.maintenanceToken="$token"
contains 'kind: CronJob'
contains 'name: openwork-ee-den-audit-usage'
contains 'schedule: "30 3 * * *"'
contains 'timeZone: "Etc/UTC"'
contains 'concurrencyPolicy: Forbid'
contains 'value: "http://openwork-ee-den-api:8788/internal/audit/usage/refresh"'
contains "DEN_MAINTENANCE_TOKEN: \"$token\""
count 'name: "openwork-ee-secret"' 2
count 'key: "DEN_MAINTENANCE_TOKEN"' 2

# Token from an operator-managed Secret.
render --set denApi.auditUsage.enabled=true --set denApi.auditUsage.tokenSecret=den-maintenance \
  --set denApi.auditUsage.tokenKey=token --set denApi.auditUsage.schedule="5 2 * * *"
contains 'schedule: "5 2 * * *"'
count 'name: "den-maintenance"' 2
count 'key: "token"' 2
absent 'DEN_MAINTENANCE_TOKEN: "'

# Enabled without any token source, or with a short token, fails at render time.
fails_with 'denApi.auditUsage.enabled=true needs a maintenance token' --set denApi.auditUsage.enabled=true
fails_with 'secret.values.maintenanceToken must contain at least 24 characters' --set-string secret.values.maintenanceToken=short

printf 'den-audit-usage chart checks passed (%s assertions)\n' "$assertions"
