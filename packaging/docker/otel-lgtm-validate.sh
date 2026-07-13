#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
project="${OTEL_LGTM_PROJECT:-openwork-otel-lgtm-validate-$$}"
compose_file="${OTEL_LGTM_COMPOSE_FILE:-$repo_root/packaging/docker/docker-compose.otel-lgtm.yml}"
grafana_port="${OTEL_LGTM_GRAFANA_PORT:-3000}"
otlp_http_port="${OTEL_LGTM_OTLP_HTTP_PORT:-4318}"
keep_running="${OTEL_LGTM_KEEP_RUNNING:-0}"

if [[ ! "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "OTEL_LGTM_PROJECT must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores, or dashes" >&2
  exit 1
fi

case "$compose_file" in
  /*) ;;
  *) compose_file="$repo_root/$compose_file" ;;
esac

if [ ! -f "$compose_file" ]; then
  echo "Compose file not found: $compose_file" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to validate the OTEL LGTM stack" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to validate the OTLP HTTP receiver" >&2
  exit 1
fi

cleanup() {
  status=$?
  if [ "$keep_running" != "1" ]; then
    docker compose -p "$project" -f "$compose_file" down --volumes >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

docker compose -p "$project" -f "$compose_file" config >/dev/null
docker compose -p "$project" -f "$compose_file" up -d --wait otel-lgtm

container_id="$(docker compose -p "$project" -f "$compose_file" ps -q otel-lgtm)"
health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
if [ "$health_status" != "healthy" ]; then
  echo "otel-lgtm container is not healthy: $health_status" >&2
  exit 1
fi

curl -fsS "http://127.0.0.1:${grafana_port}/api/health" >/dev/null

for signal in traces metrics logs; do
  curl -fsS \
    -X POST \
    -H "Content-Type: application/x-protobuf" \
    --data-binary "" \
    "http://127.0.0.1:${otlp_http_port}/v1/${signal}" >/dev/null
done

echo "otel-lgtm is healthy and accepts OTLP/HTTP protobuf on port ${otlp_http_port}"
