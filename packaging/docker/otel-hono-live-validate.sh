#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
project_default="openwork-otel-hono-live-$$"
project="${OTEL_HONO_PROJECT:-$project_default}"
den_compose_file="${OTEL_HONO_DEN_COMPOSE_FILE:-$repo_root/packaging/docker/docker-compose.den-dev.yml}"
otel_compose_file="${OTEL_HONO_LGTM_COMPOSE_FILE:-$repo_root/packaging/docker/docker-compose.otel-lgtm.yml}"
keep_stack="${KEEP_STACK:-0}"
skip_build="${SKIP_BUILD:-0}"
wait_seconds="${OTEL_HONO_COMPOSE_WAIT_SECONDS:-420}"
port_base="${OTEL_HONO_PORT_BASE:-$((22000 + ($$ % 1000) * 20))}"

case "$den_compose_file" in
  /*) ;;
  *) den_compose_file="$repo_root/$den_compose_file" ;;
esac
case "$otel_compose_file" in
  /*) ;;
  *) otel_compose_file="$repo_root/$otel_compose_file" ;;
esac

if [[ ! "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "OTEL_HONO_PROJECT must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores, or dashes" >&2
  exit 1
fi

for file in "$den_compose_file" "$otel_compose_file" "$script_dir/otel-hono-live-validate.mjs"; do
  if [ ! -f "$file" ]; then
    echo "Required file not found: $file" >&2
    exit 1
  fi
done

for command in docker node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required for live OTEL/Hono validation" >&2
    exit 1
  fi
done

export DEN_API_PORT="${DEN_API_PORT:-$((port_base + 1))}"
export DEN_WEB_PORT="${DEN_WEB_PORT:-$((port_base + 2))}"
export DEN_MYSQL_PORT="${DEN_MYSQL_PORT:-$((port_base + 3))}"
export OTEL_LGTM_GRAFANA_PORT="${OTEL_LGTM_GRAFANA_PORT:-$((port_base + 4))}"
export OTEL_LGTM_OTLP_GRPC_PORT="${OTEL_LGTM_OTLP_GRPC_PORT:-$((port_base + 5))}"
export OTEL_LGTM_OTLP_HTTP_PORT="${OTEL_LGTM_OTLP_HTTP_PORT:-$((port_base + 6))}"

export DEN_OBSERVABILITY_BACKEND="${DEN_OBSERVABILITY_BACKEND:-otel}"
export NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND="${NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND:-otel}"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://otel-lgtm:4318}"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-http://otel-lgtm:4318/v1/traces}"
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="${OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:-http://otel-lgtm:4318/v1/metrics}"
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="${OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:-http://otel-lgtm:4318/v1/logs}"
export OTEL_EXPORTER_OTLP_PROTOCOL="${OTEL_EXPORTER_OTLP_PROTOCOL:-http/protobuf}"
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL="${OTEL_EXPORTER_OTLP_TRACES_PROTOCOL:-http/protobuf}"
export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL="${OTEL_EXPORTER_OTLP_METRICS_PROTOCOL:-http/protobuf}"
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL="${OTEL_EXPORTER_OTLP_LOGS_PROTOCOL:-http/protobuf}"
export OTEL_TRACES_EXPORTER="${OTEL_TRACES_EXPORTER:-otlp}"
export OTEL_METRICS_EXPORTER="${OTEL_METRICS_EXPORTER:-otlp}"
export OTEL_LOGS_EXPORTER="${OTEL_LOGS_EXPORTER:-otlp}"
export OTEL_TRACES_SAMPLER="${OTEL_TRACES_SAMPLER:-parentbased_always_on}"
export DEN_API_OTEL_SERVICE_NAME="${DEN_API_OTEL_SERVICE_NAME:-den-api}"
export DEN_WEB_OTEL_SERVICE_NAME="${DEN_WEB_OTEL_SERVICE_NAME:-den-web}"
export DEN_BETTER_AUTH_URL="${DEN_BETTER_AUTH_URL:-http://127.0.0.1:${DEN_WEB_PORT}}"
export DEN_API_PUBLIC_URL="${DEN_API_PUBLIC_URL:-http://127.0.0.1:${DEN_API_PORT}}"
export DEN_MCP_RESOURCE_URL="${DEN_MCP_RESOURCE_URL:-http://127.0.0.1:${DEN_API_PORT}/mcp}"
export DEN_CORS_ORIGINS="${DEN_CORS_ORIGINS:-http://127.0.0.1:${DEN_WEB_PORT},http://localhost:${DEN_WEB_PORT},http://127.0.0.1:${DEN_API_PORT},http://localhost:${DEN_API_PORT}}"
export DEN_BETTER_AUTH_TRUSTED_ORIGINS="${DEN_BETTER_AUTH_TRUSTED_ORIGINS:-$DEN_CORS_ORIGINS}"

report_dir="${OTEL_HONO_REPORT_DIR:-$repo_root/tmp/otel-hono-live-$project}"
report_json="${OTEL_HONO_REPORT_JSON:-$report_dir/report.json}"
docker_log="$report_dir/docker.log"
mkdir -p "$report_dir"

cleanup() {
  status=$?
  if [ "$keep_stack" != "1" ]; then
    docker compose -p "$project" -f "$den_compose_file" -f "$otel_compose_file" down --volumes >>"$docker_log" 2>&1 || true
  else
    echo "KEEP_STACK=1; leaving Compose project $project running" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_step() {
  label="$1"
  shift
  echo "==> $label"
  if "$@" >>"$docker_log" 2>&1; then
    echo "ok: $label"
    return
  fi
  echo "failed: $label (see $docker_log)" >&2
  tail -n 120 "$docker_log" >&2 || true
  exit 1
}

echo "report_json=$report_json"
echo "project=$project"
echo "ports den_web=$DEN_WEB_PORT den_api=$DEN_API_PORT mysql=$DEN_MYSQL_PORT grafana=$OTEL_LGTM_GRAFANA_PORT otlp_http=$OTEL_LGTM_OTLP_HTTP_PORT"

run_step "render merged compose config" docker compose -p "$project" -f "$den_compose_file" -f "$otel_compose_file" config

if [ "$skip_build" != "1" ]; then
  run_step "build Den API and Den Web images" docker compose -p "$project" -f "$den_compose_file" -f "$otel_compose_file" build den web
else
  echo "SKIP_BUILD=1; reusing existing images"
fi

run_step "start and wait for live Den + OTEL LGTM stack" docker compose -p "$project" -f "$den_compose_file" -f "$otel_compose_file" up -d --wait --wait-timeout "$wait_seconds" mysql otel-lgtm den web

node "$script_dir/otel-hono-live-validate.mjs" \
  --project "$project" \
  --den-compose-file "$den_compose_file" \
  --otel-compose-file "$otel_compose_file" \
  --grafana-url "http://127.0.0.1:${OTEL_LGTM_GRAFANA_PORT}" \
  --web-url "http://127.0.0.1:${DEN_WEB_PORT}" \
  --report-json "$report_json"
