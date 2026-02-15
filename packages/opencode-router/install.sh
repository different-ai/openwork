#!/usr/bin/env bash
set -euo pipefail

OPENCODE_ROUTER_REF="${OPENCODE_ROUTER_REF:-dev}"
OPENCODE_ROUTER_REPO="${OPENCODE_ROUTER_REPO:-https://github.com/different-ai/openwork.git}"
OPENCODE_ROUTER_INSTALL_DIR="${OPENCODE_ROUTER_INSTALL_DIR:-$HOME/.openwork/opencode-router/openwork}"
OPENCODE_ROUTER_BIN_DIR="${OPENCODE_ROUTER_BIN_DIR:-$HOME/.local/bin}"
OPENCODE_ROUTER_INSTALL_METHOD="${OPENCODE_ROUTER_INSTALL_METHOD:-npm}"

usage() {
  cat <<'EOF'
OpenCode Router installer

Environment variables:
  OPENCODE_ROUTER_INSTALL_DIR  Install directory (default: ~/.openwork/opencode-router/openwork)
  OPENCODE_ROUTER_REPO         Git repo (default: https://github.com/different-ai/openwork.git)
  OPENCODE_ROUTER_REF          Git ref/branch (default: dev)
  OPENCODE_ROUTER_BIN_DIR      Bin directory for shims (default: ~/.local/bin)
  OPENCODE_ROUTER_INSTALL_METHOD  Install method: npm|git (default: npm)

Example:
  OPENCODE_ROUTER_INSTALL_DIR=~/opencode-router curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/opencode-router/install.sh | bash
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

if [[ "$OPENCODE_ROUTER_INSTALL_METHOD" == "npm" ]]; then
  echo "Installing owpenwork via npm (provides opencode-router)..."
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

  if [[ -d "$OPENCODE_ROUTER_INSTALL_DIR/.git" ]]; then
    echo "Updating OpenCode Router source in $OPENCODE_ROUTER_INSTALL_DIR"
    git -C "$OPENCODE_ROUTER_INSTALL_DIR" fetch origin --prune
    if git -C "$OPENCODE_ROUTER_INSTALL_DIR" show-ref --verify --quiet "refs/remotes/origin/$OPENCODE_ROUTER_REF"; then
      git -C "$OPENCODE_ROUTER_INSTALL_DIR" checkout -B "$OPENCODE_ROUTER_REF" "origin/$OPENCODE_ROUTER_REF"
      git -C "$OPENCODE_ROUTER_INSTALL_DIR" pull --ff-only origin "$OPENCODE_ROUTER_REF"
    else
      git -C "$OPENCODE_ROUTER_INSTALL_DIR" checkout -f
      git -C "$OPENCODE_ROUTER_INSTALL_DIR" pull --ff-only
    fi
  else
    echo "Cloning OpenCode Router source to $OPENCODE_ROUTER_INSTALL_DIR"
    mkdir -p "$OPENCODE_ROUTER_INSTALL_DIR"
    git clone --depth 1 "$OPENCODE_ROUTER_REPO" "$OPENCODE_ROUTER_INSTALL_DIR"
    if git -C "$OPENCODE_ROUTER_INSTALL_DIR" show-ref --verify --quiet "refs/remotes/origin/$OPENCODE_ROUTER_REF"; then
      git -C "$OPENCODE_ROUTER_INSTALL_DIR" checkout -B "$OPENCODE_ROUTER_REF" "origin/$OPENCODE_ROUTER_REF"
    fi
  fi

  if [[ ! -d "$OPENCODE_ROUTER_INSTALL_DIR/packages/opencode-router" ]]; then
    echo "opencode-router package not found on ref '$OPENCODE_ROUTER_REF'. Trying dev/main..." >&2
    git -C "$OPENCODE_ROUTER_INSTALL_DIR" fetch origin --prune
    if git -C "$OPENCODE_ROUTER_INSTALL_DIR" show-ref --verify --quiet refs/remotes/origin/dev; then
      git -C "$OPENCODE_ROUTER_INSTALL_DIR" checkout -B dev origin/dev
    elif git -C "$OPENCODE_ROUTER_INSTALL_DIR" show-ref --verify --quiet refs/remotes/origin/main; then
      git -C "$OPENCODE_ROUTER_INSTALL_DIR" checkout -B main origin/main
    fi
  fi

  if [[ ! -d "$OPENCODE_ROUTER_INSTALL_DIR/packages/opencode-router" ]]; then
    echo "opencode-router package not found after checkout. Aborting." >&2
    exit 1
  fi

  echo "Installing dependencies..."
  pnpm -C "$OPENCODE_ROUTER_INSTALL_DIR" install

  echo "Building opencode-router..."
  pnpm -C "$OPENCODE_ROUTER_INSTALL_DIR/packages/opencode-router" build

  ENV_PATH="$OPENCODE_ROUTER_INSTALL_DIR/packages/opencode-router/.env"
  ENV_EXAMPLE="$OPENCODE_ROUTER_INSTALL_DIR/packages/opencode-router/.env.example"
  if [[ ! -f "$ENV_PATH" ]]; then
    if [[ -f "$ENV_EXAMPLE" ]]; then
      cp "$ENV_EXAMPLE" "$ENV_PATH"
      echo "Created $ENV_PATH"
    else
      cat <<EOF > "$ENV_PATH"
OPENCODE_URL=http://127.0.0.1:4096
OPENCODE_DIRECTORY=
TELEGRAM_BOT_TOKEN=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
EOF
      echo "Created $ENV_PATH (minimal)"
    fi
  fi

  mkdir -p "$OPENCODE_ROUTER_BIN_DIR"
  cat <<EOF > "$OPENCODE_ROUTER_BIN_DIR/opencode-router"
#!/usr/bin/env bash
set -euo pipefail
node "$OPENCODE_ROUTER_INSTALL_DIR/packages/opencode-router/dist/cli.js" "$@"
EOF
  chmod 755 "$OPENCODE_ROUTER_BIN_DIR/opencode-router"
fi

if ! echo ":$PATH:" | grep -q ":$OPENCODE_ROUTER_BIN_DIR:"; then
  shell_name="$(basename "${SHELL:-}" 2>/dev/null || true)"
  case "$shell_name" in
    fish)
      echo "Add to PATH (fish): set -Ux PATH $OPENCODE_ROUTER_BIN_DIR \$PATH"
      ;;
    zsh)
      echo "Add to PATH (zsh):  echo 'export PATH=\"$OPENCODE_ROUTER_BIN_DIR:\$PATH\"' >> ~/.zshrc"
      ;;
    bash)
      echo "Add to PATH (bash): echo 'export PATH=\"$OPENCODE_ROUTER_BIN_DIR:\$PATH\"' >> ~/.bashrc"
      ;;
    *)
      echo "Add to PATH: export PATH=\"$OPENCODE_ROUTER_BIN_DIR:\$PATH\""
      ;;
  esac
fi

cat <<EOF

OpenCode Router installed.

Next steps:
1) Edit: $ENV_PATH
2) Run: opencode-router start
EOF
