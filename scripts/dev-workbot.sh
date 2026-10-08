#!/usr/bin/env bash
# Workbot on this machine: Den (where people sign in), the headless runner, and the Workbot app, wired together
# and reloading on save.
#
#   pnpm dev:den:mysql        # once, starts MySQL and Redis in Docker
#   pnpm dev:workbot          # then open http://localhost:3020 and sign in with a Den account
#
# Workbot needs its capability on for your organization: Den's /admin panel, or the den_set_org_capability admin
# tool. The runner talks to Anthropic directly. It uses HEADLESS_MODEL_API_KEY when set, otherwise
# ANTHROPIC_API_KEY, otherwise the team's dev key from Infisical. Override the model with HEADLESS_MODEL.
# Files are kept on disk in .data/workbot-files; set HEADLESS_FILES=off to turn them off.
# Each conversation gets a Linux computer (a Freestyle VM) when FREESTYLE_API_KEY is set or Infisical has it
# (dev, /openwork-ops); HEADLESS_COMPUTER=off turns it off.
#
# Ports: DEN_WEB_PORT (3005), DEN_API_PORT (8788), HEADLESS_PORT (8795), WORKBOT_PORT (3020). DATABASE_URL picks
# Den's database, as for pnpm dev:den.
set -euo pipefail
cd "$(dirname "$0")/.."

RUNNER_PORT="${HEADLESS_PORT:-8795}"
API_PORT="${DEN_API_PORT:-8788}"
WEB_PORT="${DEN_WEB_PORT:-3005}"
WORKBOT_PORT="${WORKBOT_PORT:-3020}"
DATA_DIR="${WORKBOT_DATA_DIR:-$PWD/.data}"
# Local-only secrets between Workbot, the runner and Den; not secrets anywhere else.
RUNNER_TOKEN="local-workbot-runner-token-not-a-secret-0000"
SESSION_SECRET="local-workbot-session-secret-not-a-secret-00"

key="${HEADLESS_MODEL_API_KEY:-${ANTHROPIC_API_KEY:-}}"
if [ -z "$key" ] && command -v infisical >/dev/null; then
  key="$(infisical secrets get ANTHROPIC_API_KEY --env dev --plain --silent 2>/dev/null || true)"
  [ "$key" = "*not found*" ] && key=""
fi
if [ -z "$key" ]; then
  echo "dev-workbot: set ANTHROPIC_API_KEY (or log in to Infisical) so the runner can reach a model." >&2
  exit 1
fi

computer="${HEADLESS_COMPUTER:-}"
freestyle="${FREESTYLE_API_KEY:-}"
if [ "$computer" != "off" ] && [ -z "$freestyle" ] && command -v infisical >/dev/null; then
  freestyle="$(infisical secrets get FREESTYLE_API_KEY --env dev --path /openwork-ops --plain --silent 2>/dev/null || true)"
  [ "$freestyle" = "*not found*" ] && freestyle=""
fi
if [ -z "$computer" ]; then
  if [ -n "$freestyle" ]; then computer=freestyle; else computer=off; fi
fi
if [ "$computer" = "freestyle" ]; then
  # A no-op unless the computer image changed; then it builds the new snapshot (about three minutes).
  FREESTYLE_API_KEY="$freestyle" pnpm --filter @openwork-ee/headless-computer snapshot:build
fi

mkdir -p "$DATA_DIR"
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT INT TERM

HEADLESS_COMPUTER="$computer" \
FREESTYLE_API_KEY="$freestyle" \
HEADLESS_API_TOKEN="$RUNNER_TOKEN" \
HEADLESS_PORT="$RUNNER_PORT" \
HEADLESS_DB_PATH="${HEADLESS_DB_PATH:-$DATA_DIR/workbot-runner.sqlite}" \
HEADLESS_MODEL_PROTOCOL="${HEADLESS_MODEL_PROTOCOL:-anthropic}" \
HEADLESS_MODEL_BASE_URL="${HEADLESS_MODEL_BASE_URL:-https://api.anthropic.com/v1}" \
HEADLESS_MODEL="${HEADLESS_MODEL:-claude-sonnet-5-5}" \
HEADLESS_MODEL_API_KEY="$key" \
HEADLESS_MCP_URL="http://127.0.0.1:${API_PORT}/mcp/agent" \
HEADLESS_FILES="${HEADLESS_FILES:-disk}" \
HEADLESS_FILES_DIR="${HEADLESS_FILES_DIR:-$DATA_DIR/workbot-files}" \
  pnpm --filter @openwork-ee/headless-runner dev &
pids+=($!)

WORKBOT_PUBLIC_URL="http://localhost:${WORKBOT_PORT}" \
WORKBOT_PORT="$WORKBOT_PORT" \
WORKBOT_DEN_API_URL="http://localhost:${API_PORT}" \
WORKBOT_DEN_WEB_URL="http://localhost:${WEB_PORT}" \
WORKBOT_RUNNER_URL="http://127.0.0.1:${RUNNER_PORT}" \
WORKBOT_RUNNER_TOKEN="$RUNNER_TOKEN" \
WORKBOT_SESSION_SECRET="$SESSION_SECRET" \
  pnpm --filter @openwork-ee/workbot dev &
pids+=($!)

DEN_WORKBOT_URL="http://localhost:${WORKBOT_PORT}" \
DEN_HEADLESS_RUNNER_URL="http://127.0.0.1:${RUNNER_PORT}" \
DEN_HEADLESS_RUNNER_TOKEN="$RUNNER_TOKEN" \
  pnpm dev:den
