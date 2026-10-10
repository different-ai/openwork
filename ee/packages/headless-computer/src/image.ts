import { createHash } from "node:crypto"

/**
 * The prepared computer every conversation's VM boots from: Ubuntu (Freestyle's base snapshot) plus the tools
 * an assistant reaches for on real files. The snapshot's slug is derived from this script, so changing the
 * tool list names a new snapshot; build it with `pnpm --filter @openwork-ee/headless-computer snapshot:build`.
 */

/** `background <name> <command>`: runs a long command detached, so it outlives the 5-minute command limit. */
const BACKGROUND_HELPER = `#!/bin/bash
# background <name> <command...>: run a long command in the background.
# Output goes to /workspace/.jobs/<name>.log; the last line is [exit N] when it finishes.
set -euo pipefail
if [ $# -lt 2 ]; then echo "usage: background <name> <command...>" >&2; exit 2; fi
name="$1"; shift
jobs=/workspace/.jobs
mkdir -p "$jobs"
log="$jobs/$name.log"
touch "$jobs/$name.running"
setsid nohup bash -c 'cd /workspace; bash -c "$1"; code=$?; echo "[exit $code]"; rm -f "$2"' _ "$*" "$jobs/$name.running" > "$log" 2>&1 < /dev/null &
echo "Started $name in the background. Follow it with: tail -n 20 $log"
`

export const COMPUTER_INSTALL_SCRIPT = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \\
  ffmpeg imagemagick poppler-utils qpdf ghostscript tesseract-ocr pandoc \\
  jq ripgrep sqlite3 zip unzip p7zip-full file curl ca-certificates git \\
  nodejs npm fonts-dejavu-core fonts-liberation fonts-noto-core \\
  libreoffice-impress-nogui libreoffice-writer-nogui libreoffice-calc-nogui
python3 -m pip install --no-cache-dir --quiet --break-system-packages \\
  pandas numpy matplotlib openpyxl xlsxwriter python-docx python-pptx pdfplumber pypdf pillow opencv-python-headless requests beautifulsoup4 \\
  || python3 -m pip install --no-cache-dir --quiet \\
  pandas numpy matplotlib openpyxl xlsxwriter python-docx python-pptx pdfplumber pypdf pillow opencv-python-headless requests beautifulsoup4
cat > /usr/local/bin/background <<'HELPER'
${BACKGROUND_HELPER}HELPER
chmod 755 /usr/local/bin/background
mkdir -p /workspace/files /workspace/out /workspace/.jobs
chown -R 1000:1000 /workspace
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.cache
sync
echo 3 > /proc/sys/vm/drop_caches || true
`

/** The snapshot slug for the current install script. */
export function computerSnapshotSlug() {
  return `openwork-computer-${createHash("sha256").update(COMPUTER_INSTALL_SCRIPT).digest("hex").slice(0, 12)}`
}
