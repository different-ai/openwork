#!/usr/bin/env bash
set -euo pipefail

OWPENBOT_REF="${OWPENBOT_REF:-dev}"
OWPENBOT_REPO="${OWPENBOT_REPO:-https://github.com/different-ai/openwork.git}"
OWPENBOT_INSTALL_DIR="${OWPENBOT_INSTALL_DIR:-$HOME/.owpenbot/openwork}"

usage() {
  cat <<'EOF'
Owpenbot installer (WhatsApp-first)

Environment variables:
  OWPENBOT_INSTALL_DIR  Install directory (default: ~/.owpenbot/openwork)
  OWPENBOT_REPO         Git repo (default: https://github.com/different-ai/openwork.git)
  OWPENBOT_REF          Git ref/branch (default: dev)

Example:
  OWPENBOT_INSTALL_DIR=~/owpenbot curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/owpenbot/install.sh | bash
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing $1. Please install it and retry." >&2
    exit 1
  fi
}

require_bin git
require_bin node

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10.27.0 --activate
  else
    echo "pnpm is required. Install pnpm or enable corepack, then retry." >&2
    exit 1
  fi
fi

if [[ -d "$OWPENBOT_INSTALL_DIR/.git" ]]; then
  echo "Updating owpenbot source in $OWPENBOT_INSTALL_DIR"
  git -C "$OWPENBOT_INSTALL_DIR" fetch origin --prune
  git -C "$OWPENBOT_INSTALL_DIR" checkout "$OWPENBOT_REF"
  git -C "$OWPENBOT_INSTALL_DIR" pull --ff-only origin "$OWPENBOT_REF"
else
  echo "Cloning owpenbot source to $OWPENBOT_INSTALL_DIR"
  mkdir -p "$OWPENBOT_INSTALL_DIR"
  git clone --branch "$OWPENBOT_REF" --depth 1 "$OWPENBOT_REPO" "$OWPENBOT_INSTALL_DIR"
fi

echo "Installing dependencies..."
pnpm -C "$OWPENBOT_INSTALL_DIR" install

echo "Building owpenbot..."
pnpm -C "$OWPENBOT_INSTALL_DIR/packages/owpenbot" build

ENV_PATH="$OWPENBOT_INSTALL_DIR/packages/owpenbot/.env"
ENV_EXAMPLE="$OWPENBOT_INSTALL_DIR/packages/owpenbot/.env.example"
if [[ ! -f "$ENV_PATH" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_PATH"
  echo "Created $ENV_PATH"
fi

cat <<EOF

Owpenbot installed.

Next steps:
1) Edit $ENV_PATH
2) Pair WhatsApp: pnpm -C $OWPENBOT_INSTALL_DIR/packages/owpenbot whatsapp:login
3) Start bridge:   pnpm -C $OWPENBOT_INSTALL_DIR/packages/owpenbot start
EOF
