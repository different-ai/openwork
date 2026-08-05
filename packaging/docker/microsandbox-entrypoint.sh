#!/usr/bin/env sh
set -eu

MICX_WORKSPACE="${MICX_WORKSPACE:-/workspace}"
MICX_DATA_DIR="${MICX_DATA_DIR:-/data/micx-server}"
MICX_SIDECAR_DIR="${MICX_SIDECAR_DIR:-/data/sidecars}"
MICX_PORT="${MICX_PORT:-8787}"
MICX_TOKEN="${MICX_TOKEN:-microsandbox-token}"
MICX_HOST_TOKEN="${MICX_HOST_TOKEN:-microsandbox-host-token}"
MICX_APPROVAL_MODE="${MICX_APPROVAL_MODE:-auto}"
MICX_CORS_ORIGINS="${MICX_CORS_ORIGINS:-*}"
MICX_CONNECT_HOST="${MICX_CONNECT_HOST:-127.0.0.1}"
MICX_EXTENSIONS_PLUGIN_DIR="${MICX_EXTENSIONS_PLUGIN_DIR:-/opt/micx/opencode-plugins}"
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
export MICX_DATA_DIR MICX_TOKEN MICX_HOST_TOKEN MICX_EXTENSIONS_PLUGIN_DIR
export MICX_MANAGE_OPENCODE=1
export MICX_OPENCODE_BIN=/usr/local/bin/opencode

mkdir -p "$MICX_WORKSPACE" "$MICX_DATA_DIR" "$MICX_SIDECAR_DIR"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

printf '%s\n' "Starting Micx micro-sandbox"
printf '%s\n' "- workspace: $MICX_WORKSPACE"
printf '%s\n' "- home: $HOME"
printf '%s\n' "- micx url: http://$MICX_CONNECT_HOST:$MICX_PORT"
printf '%s\n' "- client token: $MICX_TOKEN"
printf '%s\n' "- host token: $MICX_HOST_TOKEN"
printf '%s\n' "- health: curl http://$MICX_CONNECT_HOST:$MICX_PORT/health"
printf '%s\n' "- auth test: curl -H \"Authorization: Bearer $MICX_TOKEN\" http://$MICX_CONNECT_HOST:$MICX_PORT/workspaces"

exec micx-server \
  --workspace "$MICX_WORKSPACE" \
  --host 0.0.0.0 \
  --port "$MICX_PORT" \
  --token "$MICX_TOKEN" \
  --host-token "$MICX_HOST_TOKEN" \
  --approval "$MICX_APPROVAL_MODE" \
  --cors "$MICX_CORS_ORIGINS" \
  --verbose
