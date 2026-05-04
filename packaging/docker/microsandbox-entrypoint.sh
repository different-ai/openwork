#!/usr/bin/env sh
set -eu

OPENWORK_WORKSPACE="${OPENWORK_WORKSPACE:-/workspace}"
OPENWORK_DATA_DIR="${OPENWORK_DATA_DIR:-/data/openwork-orchestrator}"
OPENWORK_SIDECAR_DIR="${OPENWORK_SIDECAR_DIR:-/data/sidecars}"
OPENWORK_PORT="${OPENWORK_PORT:-8787}"
OPENWORK_OPENCODE_PORT="${OPENWORK_OPENCODE_PORT:-4096}"
OPENWORK_TOKEN="${OPENWORK_TOKEN:-microsandbox-token}"
OPENWORK_HOST_TOKEN="${OPENWORK_HOST_TOKEN:-microsandbox-host-token}"
OPENWORK_APPROVAL_MODE="${OPENWORK_APPROVAL_MODE:-auto}"
OPENWORK_CORS_ORIGINS="${OPENWORK_CORS_ORIGINS:-*}"
OPENWORK_CONNECT_HOST="${OPENWORK_CONNECT_HOST:-127.0.0.1}"
HOME="${HOME:-/root}"
USER="${USER:-root}"
SHELL="${SHELL:-/bin/sh}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

if [ "$HOME" = "/" ]; then
  HOME=/root
  XDG_CONFIG_HOME="$HOME/.config"
  XDG_CACHE_HOME="$HOME/.cache"
  XDG_DATA_HOME="$HOME/.local/share"
  XDG_STATE_HOME="$HOME/.local/state"
fi

export HOME USER SHELL XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME

mkdir -p "$OPENWORK_WORKSPACE" "$OPENWORK_DATA_DIR" "$OPENWORK_SIDECAR_DIR"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

printf '%s\n' "Starting OpenWork micro-sandbox"
printf '%s\n' "- workspace: $OPENWORK_WORKSPACE"
printf '%s\n' "- home: $HOME"
printf '%s\n' "- openwork url: http://$OPENWORK_CONNECT_HOST:$OPENWORK_PORT"
printf '%s\n' "- client token: $OPENWORK_TOKEN"
printf '%s\n' "- host token: $OPENWORK_HOST_TOKEN"
printf '%s\n' "- health: curl http://$OPENWORK_CONNECT_HOST:$OPENWORK_PORT/health"
printf '%s\n' "- auth test: curl -H \"Authorization: Bearer $OPENWORK_TOKEN\" http://$OPENWORK_CONNECT_HOST:$OPENWORK_PORT/workspaces"

exec openwork serve \
  --workspace "$OPENWORK_WORKSPACE" \
  --remote-access \
  --openwork-port "$OPENWORK_PORT" \
  --opencode-host 127.0.0.1 \
  --opencode-port "$OPENWORK_OPENCODE_PORT" \
  --openwork-token "$OPENWORK_TOKEN" \
  --openwork-host-token "$OPENWORK_HOST_TOKEN" \
  --approval "$OPENWORK_APPROVAL_MODE" \
  --cors "$OPENWORK_CORS_ORIGINS" \
  --connect-host "$OPENWORK_CONNECT_HOST" \
  --allow-external \
  --sidecar-source external \
  --opencode-source external \
  --openwork-server-bin /usr/local/bin/openwork-server \
  --opencode-bin /usr/local/bin/opencode \
  --no-opencode-router
