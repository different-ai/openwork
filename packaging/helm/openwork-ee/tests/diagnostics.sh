#!/usr/bin/env bash
set -euo pipefail
chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rendered="$(helm template openwork-ee "$chart_dir")"
if grep -q DEN_DIAGNOSTICS <<< "$rendered"; then
  echo "Default chart must not configure diagnostic output" >&2
  exit 1
fi
rendered="$(helm template openwork-ee "$chart_dir" --set config.diagnostics.enabled=true --set config.diagnostics.intervalMinutes=5)"
[[ "$(grep -c 'name: DEN_DIAGNOSTICS' <<< "$rendered")" == 1 ]]
grep -Fq '\"enabled\":true' <<< "$rendered"
grep -Fq '\"intervalMinutes\":5' <<< "$rendered"
grep -Fq '\"output\":\"stdout\"' <<< "$rendered"
for invalid in 'config.diagnostics.intervalMinutes=4' 'config.diagnostics.intervalMinutes=1441' 'config.diagnostics.output=remote' 'config.diagnostics.extra=true'; do
  if helm template openwork-ee "$chart_dir" --set "$invalid" >/dev/null 2>&1; then
    echo "Invalid diagnostics config was accepted: $invalid" >&2
    exit 1
  fi
done
echo "Operational diagnostics Helm checks passed (default, enabled, 4 invalid blocks)"
