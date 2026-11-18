// GET /install.sh
//
// A small, inspectable, self-contained installer. It downloads the
// openwork-bootstrap CLI (a single dependency-free Node file served from this
// site) and installs it as the `openwork-bootstrap` command on the user's PATH.
//
// It is intentionally named `openwork-bootstrap` so setup guides can refer to a
// specific bootstrap command. It does not use npm or npx.
//
// This does NOT install the OpenWork desktop app. The script header and final
// output say so and print the app install commands, because agents asked to
// "install OpenWork" otherwise reach for this URL.
//
// Usage (the docs tell users to download + inspect before running):
//   curl -fsSLo /tmp/openwork-install.sh https://openworklabs.com/install.sh
//   less /tmp/openwork-install.sh
//   sh /tmp/openwork-install.sh
export const dynamic = "force-static";

const installScript = `#!/usr/bin/env sh
# OpenWork bootstrap installer.
# Installs the \`openwork-bootstrap\` command (org setup CLI for agents) into a
# user-writable bin dir. No admin privileges, no npm, no npx. Uses Node.js 24.x
# (24.22.1 or newer) when present; otherwise downloads the official build into the install
# dir (checksum-verified, user-local).
#
# This does NOT install the OpenWork desktop app. To install the app:
#   macOS:   brew install --cask openwork
#   Any OS:  https://openworklabs.com/download
#            (direct: https://openworklabs.com/download/<mac-arm64|mac-x64|win-x64|win-arm64|linux-x64|linux-arm64>)
#   Or, after this script: openwork-bootstrap install app --manifest https://openworklabs.com/install-manifest.json
# Agent setup guide: https://openworklabs.com/start.md
set -eu

echo "Installing the openwork-bootstrap CLI (org setup for agents)."
echo "This does not install the OpenWork desktop app; see the end of this script's output."

CLI_URL="\${OPENWORK_BOOTSTRAP_CLI_URL:-https://openworklabs.com/openwork-bootstrap.mjs}"
BIN_DIR="\${OPENWORK_BIN_DIR:-$HOME/.local/bin}"
INSTALL_DIR="\${OPENWORK_INSTALL_DIR:-$HOME/.openwork/bootstrap}"

if command -v curl >/dev/null 2>&1; then
  DOWNLOAD="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOAD="wget -qO-"
else
  echo "openwork-bootstrap installer requires curl or wget." >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$INSTALL_DIR"

# Only patched stable releases on Node 24 are supported. Do not silently accept
# a future major. Keep this check aligned with the bootstrap CLI runtime gate.
node_supported() {
  "$1" -e 'const m = /^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/.exec(process.versions.node); if (!m) process.exit(1); const [, major, minor, patch] = m.map(Number); process.exit(major === 24 && (minor > 22 || (minor === 22 && patch >= 1)) ? 0 : 1)' 2>/dev/null
}

# Otherwise fetch the official pinned Node.js release for this OS into
# $INSTALL_DIR/node (user-local, no admin rights), verified against
# nodejs.org's published SHA-256 checksums.
NODE_BIN="node"
if ! node_supported "$NODE_BIN"; then
  case "$(uname -s)" in
    Darwin) NODE_OS=darwin ;;
    Linux) NODE_OS=linux ;;
    *) echo "Node.js 24.x (24.22.1 or newer) is required. Install it from https://nodejs.org/ and re-run this script." >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) NODE_ARCH=arm64 ;;
    x86_64|amd64) NODE_ARCH=x64 ;;
    *) echo "Node.js 24.x (24.22.1 or newer) is required. Install it from https://nodejs.org/ and re-run this script." >&2; exit 1 ;;
  esac
  NODE_DIST="\${OPENWORK_NODE_DIST_URL:-https://nodejs.org/dist/v24.22.1}"
  echo "Node.js 24.x (24.22.1 or newer) not found; downloading a private copy from $NODE_DIST into $INSTALL_DIR/node ..."
  # shellcheck disable=SC2086
  NODE_SUMS="$($DOWNLOAD "$NODE_DIST/SHASUMS256.txt")"
  NODE_TARBALL="node-v24.22.1-$NODE_OS-$NODE_ARCH.tar.gz"
  NODE_SHA="$(printf '%s\\n' "$NODE_SUMS" | awk -v f="$NODE_TARBALL" '$2 == f {print $1}')"
  if [ -z "$NODE_TARBALL" ] || [ -z "$NODE_SHA" ]; then
    echo "Could not find a Node.js build for $NODE_OS-$NODE_ARCH. Install Node.js 24.x (24.22.1 or newer) from https://nodejs.org/ and re-run." >&2
    exit 1
  fi
  NODE_TMP="$(mktemp -d "\${TMPDIR:-/tmp}/openwork-node.XXXXXX")"
  # shellcheck disable=SC2086
  $DOWNLOAD "$NODE_DIST/$NODE_TARBALL" > "$NODE_TMP/$NODE_TARBALL"
  if command -v sha256sum >/dev/null 2>&1; then
    NODE_GOT="$(sha256sum "$NODE_TMP/$NODE_TARBALL" | awk '{print $1}')"
  else
    NODE_GOT="$(shasum -a 256 "$NODE_TMP/$NODE_TARBALL" | awk '{print $1}')"
  fi
  if [ "$NODE_GOT" != "$NODE_SHA" ]; then
    echo "Node.js download checksum mismatch; aborting." >&2
    rm -rf "$NODE_TMP"
    exit 1
  fi
  rm -rf "$INSTALL_DIR/node"
  mkdir -p "$INSTALL_DIR/node"
  tar -xzf "$NODE_TMP/$NODE_TARBALL" -C "$INSTALL_DIR/node" --strip-components 1
  rm -rf "$NODE_TMP"
  NODE_BIN="$INSTALL_DIR/node/bin/node"
  if ! node_supported "$NODE_BIN"; then
    echo "Downloaded runtime is not a supported Node.js 24.x release (24.22.1 or newer); aborting." >&2
    exit 1
  fi
  echo "Using private Node.js $("$NODE_BIN" --version) at $NODE_BIN"
fi

TMP_CLI="$(mktemp "\${TMPDIR:-/tmp}/openwork-bootstrap.XXXXXX.mjs")"
trap 'rm -f "$TMP_CLI"' EXIT

echo "Downloading openwork-bootstrap CLI from $CLI_URL ..."
# shellcheck disable=SC2086
$DOWNLOAD "$CLI_URL" > "$TMP_CLI"

if [ ! -s "$TMP_CLI" ]; then
  echo "Download failed or produced an empty file." >&2
  exit 1
fi
chmod 0755 "$TMP_CLI"

"$NODE_BIN" "$TMP_CLI" install --source "$TMP_CLI" --install-dir "$INSTALL_DIR" --bin-dir "$BIN_DIR" --json

echo
echo "Installed openwork-bootstrap into $BIN_DIR."
echo "If 'openwork-bootstrap' is not found, add $BIN_DIR to your PATH:"
echo "  export PATH=$BIN_DIR"':$PATH'
echo
echo "Verify with:"
echo "  openwork-bootstrap doctor --json"
echo
echo "The OpenWork desktop app is installed separately:"
echo "  macOS:   brew install --cask openwork"
echo "  Any OS:  https://openworklabs.com/download"
echo "  Or:      openwork-bootstrap install app --manifest https://openworklabs.com/install-manifest.json"
echo "Agent setup guide: https://openworklabs.com/start.md"
`;

export function GET() {
  return new Response(installScript, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}
