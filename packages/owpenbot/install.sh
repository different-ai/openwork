#!/usr/bin/env bash
set -euo pipefail

OWPENBOT_REF="${OWPENBOT_REF:-dev}"
OWPENBOT_REPO="${OWPENBOT_REPO:-https://github.com/different-ai/openwork.git}"
OWPENBOT_INSTALL_DIR="${OWPENBOT_INSTALL_DIR:-$HOME/.owpenbot/openwork}"
OWPENBOT_BIN_DIR="${OWPENBOT_BIN_DIR:-$HOME/.local/bin}"
OWPENBOT_INSTALL_METHOD="${OWPENBOT_INSTALL_METHOD:-npm}"

usage() {
  cat <<'EOF'
Owpenbot installer (WhatsApp-first)

Environment variables:
  OWPENBOT_INSTALL_DIR  Install directory (default: ~/.owpenbot/openwork)
  OWPENBOT_REPO         Git repo (default: https://github.com/different-ai/openwork.git)
  OWPENBOT_REF          Git ref/branch (default: dev)
  OWPENBOT_BIN_DIR      Bin directory for owpenbot shim (default: ~/.local/bin)
  OWPENBOT_INSTALL_METHOD  Install method: npm|git (default: npm)

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

require_bin node

if [[ "$OWPENBOT_INSTALL_METHOD" == "npm" ]]; then
  echo "Installing owpenwork via npm..."
  npm install -g owpenwork
else
  require_bin git
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
    if git -C "$OWPENBOT_INSTALL_DIR" show-ref --verify --quiet "refs/remotes/origin/$OWPENBOT_REF"; then
      git -C "$OWPENBOT_INSTALL_DIR" checkout -B "$OWPENBOT_REF" "origin/$OWPENBOT_REF"
      git -C "$OWPENBOT_INSTALL_DIR" pull --ff-only origin "$OWPENBOT_REF"
    else
      git -C "$OWPENBOT_INSTALL_DIR" checkout -f
      git -C "$OWPENBOT_INSTALL_DIR" pull --ff-only
    fi
  else
    echo "Cloning owpenbot source to $OWPENBOT_INSTALL_DIR"
    mkdir -p "$OWPENBOT_INSTALL_DIR"
    git clone --depth 1 "$OWPENBOT_REPO" "$OWPENBOT_INSTALL_DIR"
    if git -C "$OWPENBOT_INSTALL_DIR" show-ref --verify --quiet "refs/remotes/origin/$OWPENBOT_REF"; then
      git -C "$OWPENBOT_INSTALL_DIR" checkout -B "$OWPENBOT_REF" "origin/$OWPENBOT_REF"
    fi
  fi

  if [[ ! -d "$OWPENBOT_INSTALL_DIR/packages/owpenbot" ]]; then
    echo "owpenbot package not found on ref '$OWPENBOT_REF'. Trying dev/main..." >&2
    git -C "$OWPENBOT_INSTALL_DIR" fetch origin --prune
    if git -C "$OWPENBOT_INSTALL_DIR" show-ref --verify --quiet refs/remotes/origin/dev; then
      git -C "$OWPENBOT_INSTALL_DIR" checkout -B dev origin/dev
    elif git -C "$OWPENBOT_INSTALL_DIR" show-ref --verify --quiet refs/remotes/origin/main; then
      git -C "$OWPENBOT_INSTALL_DIR" checkout -B main origin/main
    fi
  fi

  if [[ ! -d "$OWPENBOT_INSTALL_DIR/packages/owpenbot" ]]; then
    echo "owpenbot package not found after checkout. Aborting." >&2
    exit 1
  fi

  echo "Installing dependencies..."
  pnpm -C "$OWPENBOT_INSTALL_DIR" install

  echo "Building owpenbot..."
  pnpm -C "$OWPENBOT_INSTALL_DIR/packages/owpenbot" build

  ENV_PATH="$OWPENBOT_INSTALL_DIR/packages/owpenbot/.env"
  ENV_EXAMPLE="$OWPENBOT_INSTALL_DIR/packages/owpenbot/.env.example"
  if [[ ! -f "$ENV_PATH" ]]; then
    if [[ -f "$ENV_EXAMPLE" ]]; then
      cp "$ENV_EXAMPLE" "$ENV_PATH"
      echo "Created $ENV_PATH"
    else
      cat <<EOF > "$ENV_PATH"
OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_DIRECTORY=
WHATSAPP_AUTH_DIR=~/.owpenbot/whatsapp
EOF
      echo "Created $ENV_PATH (minimal)"
    fi
  fi

  mkdir -p "$OWPENBOT_BIN_DIR"
  cat <<EOF > "$OWPENBOT_BIN_DIR/owpenbot"
#!/usr/bin/env bash
set -euo pipefail
node "$OWPENBOT_INSTALL_DIR/packages/owpenbot/dist/cli.js" "$@"
EOF
  chmod 755 "$OWPENBOT_BIN_DIR/owpenbot"
fi

if ! echo ":$PATH:" | grep -q ":$OWPENBOT_BIN_DIR:"; then
  shell_name="$(basename "${SHELL:-}" 2>/dev/null || true)"
  case "$shell_name" in
    fish)
      echo "Add to PATH (fish): set -Ux PATH $OWPENBOT_BIN_DIR \$PATH"
      ;;
    zsh)
      echo "Add to PATH (zsh):  echo 'export PATH=\"$OWPENBOT_BIN_DIR:\$PATH\"' >> ~/.zshrc"
      ;;
    bash)
      echo "Add to PATH (bash): echo 'export PATH=\"$OWPENBOT_BIN_DIR:\$PATH\"' >> ~/.bashrc"
      ;;
    *)
      echo "Add to PATH: export PATH=\"$OWPENBOT_BIN_DIR:\$PATH\""
      ;;
  esac
fi

cat <<EOF

Owpenbot installed.

Next steps:
1) Run owpenwork: owpenwork
2) Follow the guided setup + QR login

Owpenbot will print a QR code during login and keep the session alive.
EOF
