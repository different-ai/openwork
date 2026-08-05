// GET /install.sh
//
// A small, inspectable, self-contained installer. It downloads the
// micx-bootstrap CLI (a single dependency-free Node file served from this
// site) and installs it as the `micx-bootstrap` command on the user's PATH.
//
// It is intentionally named `micx-bootstrap` so setup guides can refer to a
// specific bootstrap command. It does not use npm or npx.
//
// Usage (the docs tell users to download + inspect before running):
//   curl -fsSLo /tmp/micx-install.sh https://micxlabs.com/install.sh
//   less /tmp/micx-install.sh
//   sh /tmp/micx-install.sh
export const dynamic = "force-static";

const installScript = `#!/usr/bin/env sh
# Micx bootstrap installer.
# Installs the \`micx-bootstrap\` command into a user-writable bin dir.
# No admin privileges, no npm, no npx.
set -eu

CLI_URL="\${MICX_BOOTSTRAP_CLI_URL:-https://micxlabs.com/micx-bootstrap.mjs}"
BIN_DIR="\${MICX_BIN_DIR:-$HOME/.local/bin}"
INSTALL_DIR="\${MICX_INSTALL_DIR:-$HOME/.micx/bootstrap}"

if ! command -v node >/dev/null 2>&1; then
  echo "micx-bootstrap requires Node.js 20+ (node not found on PATH)." >&2
  echo "Install Node from https://nodejs.org/ and re-run this script." >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
if [ "\${NODE_MAJOR:-0}" -lt 20 ]; then
  echo "micx-bootstrap requires Node.js 20+ (found $(node --version 2>/dev/null))." >&2
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  DOWNLOAD="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOAD="wget -qO-"
else
  echo "micx-bootstrap installer requires curl or wget." >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$INSTALL_DIR"

TMP_CLI="$(mktemp "\${TMPDIR:-/tmp}/micx-bootstrap.XXXXXX.mjs")"
trap 'rm -f "$TMP_CLI"' EXIT

echo "Downloading micx-bootstrap CLI from $CLI_URL ..."
# shellcheck disable=SC2086
$DOWNLOAD "$CLI_URL" > "$TMP_CLI"

if [ ! -s "$TMP_CLI" ]; then
  echo "Download failed or produced an empty file." >&2
  exit 1
fi
chmod 0755 "$TMP_CLI"

node "$TMP_CLI" install --source "$TMP_CLI" --install-dir "$INSTALL_DIR" --bin-dir "$BIN_DIR" --json

echo
echo "Installed micx-bootstrap into $BIN_DIR."
echo "If 'micx-bootstrap' is not found, add $BIN_DIR to your PATH:"
echo "  export PATH=$BIN_DIR"':$PATH'
echo
echo "Verify with:"
echo "  micx-bootstrap doctor --json"
`;

export function GET() {
  return new Response(installScript, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
}
