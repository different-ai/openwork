#!/usr/bin/env bash
# Uninstall helper for OpenWork artifacts and packages.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE="$ROOT/packages/desktop/src-tauri/target/release/bundle"

log() { printf "[uninstall] %s\n" "$*"; }
die() { printf "[uninstall] ERROR: %s\n" "$*" >&2; exit 1; }
latest_file() {
  local pattern="$1"
  ls -t ${pattern} 2>/dev/null | head -n1 || true
}

detect_deb_package_name() {
  local control_file pkg
  control_file="$(latest_file "$BUNDLE/deb/"*/control/control)"
  if [ -n "$control_file" ]; then
    pkg="$(awk -F': ' '/^Package:/{print $2; exit}' "$control_file")"
    if [ -n "$pkg" ]; then
      printf "%s" "$pkg"
      return
    fi
  fi
  # Fallback for older builds or missing bundle metadata.
  printf "open-work"
}

remove_appimage_install() {
  local removed=0
  if [ -f "$HOME/.local/bin/openwork" ]; then
    rm -f "$HOME/.local/bin/openwork"
    removed=1
  fi
  if [ -f "$HOME/.local/bin/openwork.AppImage" ]; then
    rm -f "$HOME/.local/bin/openwork.AppImage"
    removed=1
  fi
  if [ "$removed" -eq 1 ]; then
    log "Removed AppImage launchers from $HOME/.local/bin."
  fi
}

uninstall_linux() {
  command -v dpkg >/dev/null 2>&1 || die "dpkg not found."

  local pkg="open-work"
  pkg="$(detect_deb_package_name)"
  log "Detected Debian package name: $pkg"

  if dpkg -s "$pkg" >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      log "Removing package via apt-get..."
      sudo apt-get remove -y "$pkg" || sudo dpkg -r "$pkg"
    else
      log "Removing package via dpkg..."
      sudo dpkg -r "$pkg"
    fi
    log "Package removed: $pkg"
  else
    log "Package not installed: $pkg"
  fi

  remove_appimage_install
  log "Linux uninstall complete."
}

uninstall_macos() {
  if [ -d "/Applications/OpenWork.app" ]; then
    log "Removing /Applications/OpenWork.app..."
    rm -rf /Applications/OpenWork.app
    log "Removed /Applications/OpenWork.app"
  else
    log "OpenWork.app not found in /Applications."
  fi
}

uninstall_windows() {
  log "Please uninstall OpenWork from Settings > Apps on Windows."
}

main() {
  case "$(uname -s)" in
    Linux) uninstall_linux ;;
    Darwin) uninstall_macos ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) uninstall_windows ;;
    *) die "Unsupported OS: $(uname -s)" ;;
  esac
}

main "$@"
