#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_COMPOSE_FILE="$ROOT_DIR/.devcontainer/docker-compose.yml"
SANDBOX_COMPOSE_FILE="$ROOT_DIR/.devcontainer/docker-compose.local-sandbox.yml"
WORKSPACE_SERVICE="workspace"

compose() {
  docker compose -f "$BASE_COMPOSE_FILE" -f "$SANDBOX_COMPOSE_FILE" "$@"
}

require_running() {
  if ! compose ps --status running --services | grep -qx "$WORKSPACE_SERVICE"; then
    echo "The sandbox is not running. Start it with: scripts/local-sandbox.sh up" >&2
    exit 1
  fi
}

workspace_exec() {
  require_running
  compose exec -T "$WORKSPACE_SERVICE" bash -lc "cd /workspace && $1"
}

print_urls() {
  cat <<'EOF'
Sandbox endpoints:
  Desktop App (noVNC): http://localhost:6080
  CDP Debug:           ws://127.0.0.1:9825
  Vite HMR:            http://localhost:5173
  Den Web:             http://localhost:3005
  Den API:             http://localhost:8788
EOF
}

usage() {
  cat <<'EOF'
Usage: scripts/local-sandbox.sh <command> [args]

Commands:
  up               Build and start the local Docker sandbox
  safe-install     Install dependencies in the container with scripts disabled
  enable-runtime   Re-enable a minimal runtime package set inside the container
  start            Start the OpenWork dev stack inside the running container
  status           Show container status and local endpoints
  logs [target]    Show logs: compose | sandbox | vite | electron | den-api | den-web
  shell            Open a shell inside the workspace container
  down             Stop the sandbox containers
  nuke             Stop containers and remove sandbox volumes
  help             Show this message

Examples:
  scripts/local-sandbox.sh up
  scripts/local-sandbox.sh safe-install
  scripts/local-sandbox.sh enable-runtime
  scripts/local-sandbox.sh start
  scripts/local-sandbox.sh logs electron
EOF
}

command="${1:-help}"
shift || true

case "$command" in
  up)
    compose up -d --build mysql "$WORKSPACE_SERVICE"
    print_urls
    ;;
  safe-install)
    workspace_exec 'CI=1 pnpm install --ignore-scripts --frozen-lockfile || CI=1 pnpm install --ignore-scripts'
    ;;
  enable-runtime)
    packages=("$@")
    if [ "${#packages[@]}" -eq 0 ]; then
      packages=(electron better-sqlite3 esbuild protobufjs)
    fi
    workspace_exec "CI=1 pnpm rebuild ${packages[*]}"
    ;;
  start)
    require_running
    compose exec -d "$WORKSPACE_SERVICE" bash -lc 'cd /workspace && bash .devcontainer/start-services.sh >/tmp/openwork-sandbox.log 2>&1'
    print_urls
    echo "Use 'scripts/local-sandbox.sh logs sandbox' if the app does not come up cleanly."
    ;;
  status)
    compose ps
    echo ""
    print_urls
    ;;
  logs)
    target="${1:-compose}"
    case "$target" in
      compose)
        compose logs --tail 200
        ;;
      sandbox)
        workspace_exec 'tail -200 /tmp/openwork-sandbox.log'
        ;;
      vite)
        workspace_exec 'tail -200 /tmp/vite.log'
        ;;
      electron)
        workspace_exec 'tail -200 /tmp/electron.log'
        ;;
      den-api)
        workspace_exec 'tail -200 /tmp/den-api.log'
        ;;
      den-web)
        workspace_exec 'tail -200 /tmp/den-web.log'
        ;;
      *)
        echo "Unknown log target: $target" >&2
        exit 1
        ;;
    esac
    ;;
  shell)
    require_running
    compose exec "$WORKSPACE_SERVICE" bash
    ;;
  down)
    compose down
    ;;
  nuke)
    compose down -v --remove-orphans
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $command" >&2
    echo "" >&2
    usage >&2
    exit 1
    ;;
esac
