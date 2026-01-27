#!/usr/bin/env bash
# Build helper for OpenWork on Linux/macOS.
# Checks required tooling and then runs `pnpm build`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

log() { printf "[build] %s\n" "$*"; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

load_nvm() {
  # shellcheck disable=SC1091
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
  fi
}

install_node() {
  log "Installing Node via nvm..."
  if [ ! -d "$NVM_DIR" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  fi
  load_nvm
  nvm install 20 --latest-npm
  nvm use 20
  nvm alias default 20 >/dev/null
}

ensure_node() {
  if command_exists node; then
    local ver major
    ver="$(node -v | sed 's/^v//')"
    major="${ver%%.*}"
    if [ "$major" -ge 20 ]; then
      return
    fi
    log "Found Node version v${ver} (<20) - upgrading."
  else
    log "Node not found."
  fi
  install_node
}

ensure_pnpm() {
  load_nvm
  log "Activating pnpm@10.27.0 via corepack..."
  export COREPACK_HOME="${COREPACK_HOME:-$ROOT/.cache/corepack}"
  mkdir -p "$COREPACK_HOME"
  corepack enable >/dev/null 2>&1 || true
  if corepack prepare pnpm@10.27.0 --activate; then
    return
  fi
  log "corepack prepare failed - fallback: npm install --prefix \"$ROOT/.cache/npm-global\" pnpm@10.27.0"
  mkdir -p "$ROOT/.cache/npm-global"
  npm install --prefix "$ROOT/.cache/npm-global" pnpm@10.27.0
  export PATH="$ROOT/.cache/npm-global/bin:$PATH"
}

ensure_rust() {
  if ! command_exists rustup; then
    log "rustup not found - installing Rust toolchain..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  fi
  # shellcheck disable=SC1091
  if [ -s "$HOME/.cargo/env" ]; then
    . "$HOME/.cargo/env"
  fi
}

ensure_tauri_cli() {
  local required="2.0.0"
  if command_exists tauri; then
    local current
    current="$(tauri -V | awk '{print $2}')"
    if printf '%s\n%s\n' "$required" "$current" | sort -C -V 2>/dev/null; then
      return
    fi
    log "Updating tauri-cli (found v${current}, need >= ${required})..."
  else
    log "tauri-cli not found - installing..."
  fi
  cargo install tauri-cli --locked --version "${required}"
}

ensure_opencode() {
  if command_exists opencode; then
    return
  fi
  local sidecar="$ROOT/packages/desktop/src-tauri/sidecars/opencode-x86_64-unknown-linux-gnu"
  if [ -x "$sidecar" ]; then
    log "Installing opencode CLI from bundled sidecar..."
    mkdir -p "$HOME/.local/bin"
    cp "$sidecar" "$HOME/.local/bin/opencode"
    chmod +x "$HOME/.local/bin/opencode"
  else
    log "Warning: opencode CLI missing and sidecar not found. Install manually: https://github.com/anomalyco/opencode/releases"
  fi
}

main() {
  if [ "$(uname -s)" != "Linux" ] && [ "$(uname -s)" != "Darwin" ]; then
    log "Warning: this script primarily targets Linux/macOS."
  fi

  ensure_node
  ensure_pnpm
  ensure_rust
  ensure_tauri_cli
  ensure_opencode

  log "Installing JS dependencies (pnpm install)..."
  cd "$ROOT"
  pnpm install

  log "Starting build (pnpm build)..."
  pnpm build
  log "Build finished. Artifacts: packages/desktop/src-tauri/target/release/bundle/"
}

main "$@"
