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

/**
 * `sudo openwork-install <package>...`: the only administrative step the agent's shell can take.
 * Plain package names from the image's own repositories; no apt options, sources, files or versions,
 * so it cannot be turned into a general root shell.
 */
const INSTALL_HELPER = `#!/bin/sh
set -eu
usage() { echo "usage: sudo openwork-install <package> [package...] (up to 20 package names)" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "Run it with sudo: sudo openwork-install <package>..." >&2; exit 1; }
[ "$#" -ge 1 ] && [ "$#" -le 20 ] || usage
for name in "$@"; do
  case "$name" in
    [a-z0-9]*) ;;
    *) echo "Not a package name: $name" >&2; usage ;;
  esac
  case "$name" in
    *[!a-z0-9+.-]*) echo "Not a package name: $name" >&2; usage ;;
  esac
  [ "\${#name}" -le 100 ] || usage
done
unset APT_CONFIG
export PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive
exec 9>/var/lock/openwork-install.lock
flock 9
apt-get update -qq
apt-get install -y -qq --no-install-recommends -- "$@"
`

/**
 * One import per package in requirements-desktop.in, by its module name. The desktop image imports them all
 * right after installing, so a package that will not load fails the image build instead of an assistant's
 * first script. The system Python, which is where the desktop installs them on every provider.
 */
export const DESKTOP_PYTHON_IMPORTS: Record<string, string> = {
  "openpyxl": "openpyxl", "xlsxwriter": "xlsxwriter", "xlrd": "xlrd", "python-docx": "docx", "python-pptx": "pptx",
  "markitdown": "markitdown", "defusedxml": "defusedxml", "pypdf": "pypdf", "pdfplumber": "pdfplumber",
  "pypdfium2": "pypdfium2", "pdf2image": "pdf2image", "reportlab": "reportlab", "img2pdf": "img2pdf",
  "pytesseract": "pytesseract", "numpy": "numpy", "pandas": "pandas", "pyarrow": "pyarrow", "scipy": "scipy",
  "scikit-learn": "sklearn", "statsmodels": "statsmodels", "sympy": "sympy", "matplotlib": "matplotlib",
  "seaborn": "seaborn", "pillow": "PIL", "opencv-python-headless": "cv2", "requests": "requests",
  "beautifulsoup4": "bs4", "tqdm": "tqdm", "pytz": "pytz",
}
const DESKTOP_PYTHON_CHECK = `MPLBACKEND=Agg /usr/bin/python3 -c "import ${Object.values(DESKTOP_PYTHON_IMPORTS).join(", ")}"`

/**
 * Where the desktop's preinstalled Node packages live (desktop-node-packages.json, installed exactly from its lock).
 * The command bridge sets NODE_PATH to it, so a script anywhere can require them, as Anthropic's skills expect.
 */
export const DESKTOP_NODE_PATH = "/usr/local/lib/openwork-node/node_modules"
export const DESKTOP_NODE_PACKAGES = ["docx", "pptxgenjs", "react", "react-dom", "react-icons", "sharp"]
const DESKTOP_NODE_INSTALL = `install -d /usr/local/lib/openwork-node
install -m 0644 /usr/local/share/openwork-computer/desktop-node-packages.json /usr/local/lib/openwork-node/package.json
install -m 0644 /usr/local/share/openwork-computer/desktop-node-packages.lock.json /usr/local/lib/openwork-node/package-lock.json
npm ci --prefix /usr/local/lib/openwork-node --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
NODE_PATH=${DESKTOP_NODE_PATH} node -e 'for (const name of ${JSON.stringify(DESKTOP_NODE_PACKAGES)}) require(name)'
chmod -R a+rX /usr/local/lib/openwork-node
rm -rf /root/.npm`

function installScript(officePackages: string, lockedPython = false) { return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \\
  ffmpeg imagemagick poppler-utils qpdf ghostscript tesseract-ocr pandoc \\
  jq ripgrep sqlite3 zip unzip p7zip-full file curl ca-certificates git xz-utils \\
  fonts-dejavu-core fonts-liberation fonts-noto-core \\
  ${officePackages}
# Official Node release checksums: https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
case "$(dpkg --print-architecture)" in
  amd64) node_arch=x64; node_sha256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6 ;;
  arm64) node_arch=arm64; node_sha256=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e ;;
  *) echo "Unsupported Node architecture" >&2; exit 1 ;;
esac
node_tmp=$(mktemp -d)
curl -fsSL -o "$node_tmp/node.tar.xz" "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-$node_arch.tar.xz"
echo "$node_sha256  $node_tmp/node.tar.xz" | sha256sum -c -
tar -xJf "$node_tmp/node.tar.xz" -C /usr/local --strip-components=1 --no-same-owner
rm -rf "$node_tmp"
test "$(node --version)" = v24.22.1
${lockedPython ? `python3 -m pip install --no-cache-dir --quiet --break-system-packages --require-hashes --only-binary=:all: -r /usr/local/share/openwork-computer/requirements-desktop.lock
${DESKTOP_PYTHON_CHECK}
${DESKTOP_NODE_INSTALL}` : `python3 -m pip install --no-cache-dir --quiet --break-system-packages \\
  pandas numpy matplotlib openpyxl xlsxwriter python-docx python-pptx pdfplumber pypdf pillow opencv-python-headless requests beautifulsoup4 \\
  || python3 -m pip install --no-cache-dir --quiet \\
  pandas numpy matplotlib openpyxl xlsxwriter python-docx python-pptx pdfplumber pypdf pillow opencv-python-headless requests beautifulsoup4`}
cat > /usr/local/bin/background <<'HELPER'
${BACKGROUND_HELPER}HELPER
chmod 755 /usr/local/bin/background
cat > /usr/local/sbin/openwork-install <<'HELPER'
${INSTALL_HELPER}HELPER
chown root:root /usr/local/sbin/openwork-install
chmod 755 /usr/local/sbin/openwork-install
mkdir -p /workspace/files /workspace/out /workspace/.jobs
chown -R 1000:1000 /workspace
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.cache
sync
echo 3 > /proc/sys/vm/drop_caches || true
` }

export const COMPUTER_INSTALL_SCRIPT = installScript("libreoffice-impress-nogui libreoffice-writer-nogui libreoffice-calc-nogui")
export const DESKTOP_COMPUTER_INSTALL_SCRIPT = installScript("libreoffice-impress libreoffice-writer libreoffice-calc libreoffice-draw", true)

/** The snapshot slug for the current install script. */
export function computerSnapshotSlug() {
  return `openwork-computer-${createHash("sha256").update(COMPUTER_INSTALL_SCRIPT).digest("hex").slice(0, 12)}`
}
