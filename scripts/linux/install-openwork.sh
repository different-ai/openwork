#!/usr/bin/env bash
# Install helper that uses artifacts from target/release/bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE="$ROOT/packages/desktop/src-tauri/target/release/bundle"

log() { printf "[install] %s\n" "$*"; }
die() { printf "[install] ERROR: %s\n" "$*" >&2; exit 1; }
latest_file() {
  local pattern="$1"
  ls -t ${pattern} 2>/dev/null | head -n1 || true
}

install_linux() {
  local deb appimage
  deb="$(latest_file "$BUNDLE/deb/*.deb")"
  appimage="$(latest_file "$BUNDLE/appimage/*.AppImage")"

  if [ -n "$deb" ] && command -v dpkg >/dev/null 2>&1; then
    log "Installing Debian package: $deb"
    sudo dpkg -i "$deb"
    log "Done. OpenWork should now appear in your application menu."
    return
  fi

  if [ -n "$appimage" ]; then
    log "No usable .deb found - falling back to AppImage: $appimage"
    mkdir -p "$HOME/.local/bin"
    cp "$appimage" "$HOME/.local/bin/openwork.AppImage"
    chmod +x "$HOME/.local/bin/openwork.AppImage"
    cat > "$HOME/.local/bin/openwork" <<'EOF'
#!/usr/bin/env bash
exec "$(dirname "$0")/openwork.AppImage" "$@"
EOF
    chmod +x "$HOME/.local/bin/openwork"
    log "AppImage installed to $HOME/.local/bin. Ensure $HOME/.local/bin is on PATH (for example via ~/.profile). Launch with: openwork"
    return
  fi

  die "No Linux artifacts found. Run scripts/linux/build-openwork.sh first."
}

install_macos() {
  local dmg
  dmg="$(latest_file "$BUNDLE/macos/OpenWork_*.dmg")"
  [ -n "$dmg" ] || die "No DMG found. Run the build script first."

  local mnt="/Volumes/OpenWorkInstaller"
  log "Mounting DMG: $dmg"
  hdiutil attach "$dmg" -mountpoint "$mnt" -quiet
  trap 'hdiutil detach "$mnt" -quiet || true' EXIT

  if [ -d "$mnt/OpenWork.app" ]; then
    log "Copying to /Applications..."
    rm -rf /Applications/OpenWork.app
    cp -R "$mnt/OpenWork.app" /Applications/
  else
    die "OpenWork.app not found inside the DMG."
  fi

  hdiutil detach "$mnt" -quiet
  trap - EXIT
  log "Installed. Launch OpenWork from /Applications."
}

install_windows() {
  local msi exe
  msi="$(latest_file "$BUNDLE/msi/*.msi")"
  exe="$(latest_file "$BUNDLE/nsis/*setup*.exe")"
  if [ -z "$msi" ] && [ -z "$exe" ]; then
    die "No Windows installers found. Run the build script first."
  fi
  log "Please run the installer manually (double-click): ${msi:-$exe}"
}

main() {
  case "$(uname -s)" in
    Linux) install_linux ;;
    Darwin) install_macos ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) install_windows ;;
    *) die "Unsupported OS: $(uname -s)" ;;
  esac
}

main "$@"
