#!/usr/bin/env bash
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$chart_dir/../../.." && pwd)"
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

assert_file_contains() {
  assert_contains "$1" "$2"
}

assert_file_not_contains() {
  assert_not_contains "$1" "$2"
}

default_rendered="$tmp_dir/default.yaml"
helm template openwork-ee "$chart_dir" --set inference.enabled=true > "$default_rendered"
assert_count "$default_rendered" 'name: DEN_OBSERVABILITY_BACKEND' 2
assert_count "$default_rendered" 'value: "none"' 2
assert_not_contains "$default_rendered" 'name: OTEL_EXPORTER_OTLP_HEADERS'
assert_not_contains "$default_rendered" 'name: SENTRY_DSN'

otel_values="$tmp_dir/otel-values.yaml"
otel_rendered="$tmp_dir/otel.yaml"
cat > "$otel_values" <<'YAML'
inference:
  enabled: true
observability:
  backend: otel
  otel:
    endpoint: https://otel.example.test/otlp
    tracesEndpoint: https://otel.example.test/v1/traces
    metricsEndpoint: https://otel.example.test/v1/metrics
    logsEndpoint: https://otel.example.test/v1/logs
    exporters:
      metrics: none
    tracesSampler: parentbased_always_on
    headers:
      existingSecret: otel-runtime
      key: otlp-headers
denApi:
  env:
    CUSTOM_DEN_API_ENV: api
denWeb:
  env:
    CUSTOM_DEN_WEB_ENV: web
YAML
helm template openwork-ee "$chart_dir" -f "$otel_values" > "$otel_rendered"
assert_count "$otel_rendered" 'name: DEN_OBSERVABILITY_BACKEND' 2
assert_count "$otel_rendered" 'value: "otel"' 2
assert_count "$otel_rendered" 'name: OTEL_EXPORTER_OTLP_HEADERS' 2
assert_count "$otel_rendered" 'name: OTEL_SERVICE_NAME' 2
assert_count "$otel_rendered" 'name: OTEL_METRICS_EXPORTER' 2
assert_count "$otel_rendered" 'value: "parentbased_always_on"' 2
assert_not_contains "$otel_rendered" 'name: OTEL_TRACES_SAMPLER_ARG'
assert_contains "$otel_rendered" 'value: "den-api"'
assert_contains "$otel_rendered" 'value: "den-web"'
assert_contains "$otel_rendered" 'name: "otel-runtime"'
assert_contains "$otel_rendered" 'key: "otlp-headers"'
assert_contains "$otel_rendered" 'name: CUSTOM_DEN_API_ENV'
assert_contains "$otel_rendered" 'name: CUSTOM_DEN_WEB_ENV'
assert_not_contains "$otel_rendered" 'name: SENTRY_AUTH_TOKEN'

sentry_values="$tmp_dir/sentry-values.yaml"
sentry_rendered="$tmp_dir/sentry.yaml"
cat > "$sentry_values" <<'YAML'
inference:
  enabled: true
observability:
  backend: sentry
  sentry:
    dsnSecret:
      existingSecret: sentry-runtime
      key: dsn
    tracesSampleRate: "0.75"
    environment: production
    release: "2026.07.11"
    dist: web
YAML
helm template openwork-ee "$chart_dir" -f "$sentry_values" > "$sentry_rendered"
assert_count "$sentry_rendered" 'name: DEN_OBSERVABILITY_BACKEND' 2
assert_count "$sentry_rendered" 'value: "sentry"' 2
assert_count "$sentry_rendered" 'name: SENTRY_DSN' 2
assert_contains "$sentry_rendered" 'name: "sentry-runtime"'
assert_not_contains "$sentry_rendered" 'SENTRY_AUTH_TOKEN'
assert_not_contains "$sentry_rendered" 'SENTRY_ORG'
assert_not_contains "$sentry_rendered" 'SENTRY_PROJECT'
assert_not_contains "$sentry_rendered" 'SENTRY_URL'
assert_not_contains "$sentry_rendered" 'name: OTEL_EXPORTER_OTLP_HEADERS'

assert_file_contains "$repo_root/packaging/docker/Dockerfile.den" '/app/ee/apps/den-api/dist/main.js'
assert_file_not_contains "$repo_root/packaging/docker/Dockerfile.den" '/app/ee/apps/den-api/dist/server.js'
assert_file_contains "$repo_root/packaging/docker/docker-compose.den-dev.yml" '/app/ee/apps/den-api/dist/main.js'
assert_file_not_contains "$repo_root/packaging/docker/docker-compose.den-dev.yml" '/app/ee/apps/den-api/dist/server.js'
assert_file_contains "$repo_root/.devcontainer/start-daytona-server.sh" 'pnpm --filter @openwork-ee/den-api exec tsx watch src/main.ts'
assert_file_not_contains "$repo_root/.devcontainer/start-daytona-server.sh" 'ee/apps/den-api/src/server.ts'
assert_file_contains "$repo_root/evals/runner/den-stack.mjs" '["tsx", "src/main.ts"]'
assert_file_not_contains "$repo_root/evals/runner/den-stack.mjs" '["tsx", "src/server.ts"]'
