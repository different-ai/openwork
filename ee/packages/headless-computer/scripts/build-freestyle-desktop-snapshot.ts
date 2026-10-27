/**
 * Builds the Freestyle snapshot desktop computers boot from: the same desktop as
 * Dockerfile.desktop, installed on Freestyle's Ubuntu base and captured while running,
 * so each new computer resumes with its desktop already up instead of booting it.
 *
 *   pnpm --filter @openwork-ee/headless-computer build
 *   FREESTYLE_API_KEY=... pnpm --filter @openwork-ee/headless-computer snapshot:build:freestyle-desktop
 *
 * Then run the runner with HEADLESS_COMPUTER=freestyle, HEADLESS_COMPUTER_DESKTOP=true and
 * HEADLESS_COMPUTER_SNAPSHOT=<printed slug>. The slug follows the desktop guest's version, so a
 * runner and its snapshot always match; re-running with an unchanged guest is a no-op.
 * The API key stays on this machine; it never enters the VM.
 */
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { Freestyle, FreestyleApiError } from "freestyle"
import { DESKTOP_COMPUTER_INSTALL_SCRIPT } from "../src/image.js"

const apiKey = process.env.FREESTYLE_API_KEY
if (!apiKey) {
  console.error("Set FREESTYLE_API_KEY (see the get-env-var skill: dev, /openwork-ops).")
  process.exit(1)
}
const root = new URL("../", import.meta.url)
const repo = new URL("../../../../", import.meta.url)
const text = (path: string, base = root) => readFile(new URL(path, base), "utf8")
const guestVersion = await text("dist/desktop-guest.version").catch(() => {
  console.error("Build the desktop guest first: pnpm --filter @openwork-ee/headless-computer build")
  process.exit(1)
})
// What the runner asks the bridge for (desktop.ts): the guest's version, without private browsing.
const desktopVersion = createHash("sha256").update(await readFile(new URL("dist/desktop-guest.version", root))).digest("hex")
const base = process.env.FREESTYLE_DESKTOP_BASE ?? "freestyle/ubuntu"
// Chromium for Testing through Playwright: Ubuntu ships Chromium only as a snap.
const playwright = "1.56.1"
// A fixed Node release, checked against its published SHA-256 (nodejs.org/dist/v24.22.1/SHASUMS256.txt.asc).
const node = { version: "24.22.1", sha256: "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6" }
const slug = process.env.HEADLESS_COMPUTER_SNAPSHOT ?? `workbot-desktop-freestyle-${guestVersion.trim().slice(0, 16)}`
const api = new Freestyle({ apiKey })

const exists = await api.vms.snapshots.get(slug).then(() => true, (error: unknown) => {
  if (error instanceof FreestyleApiError && error.status === 404) return false
  throw error
})
if (exists) {
  console.log(`Snapshot ${slug} already exists.`)
  process.exit(0)
}

// The lock's hashes name Debian's Python 3.11 wheels; Freestyle's Ubuntu has 3.12. Install the
// same pinned versions as binary wheels into the system Python (/usr/bin/python3) instead.
const lock = await text("requirements-desktop.lock")
const pinned = [...lock.matchAll(/^([A-Za-z0-9._-]+==[^\s\\]+)/gm)].map(match => match[1]).join("\n") + "\n"
const lockedInstall = "python3 -m pip install --no-cache-dir --quiet --break-system-packages --require-hashes --only-binary=:all: -r /usr/local/share/openwork-computer/requirements-desktop.lock"
if (!DESKTOP_COMPUTER_INSTALL_SCRIPT.includes(lockedInstall)) throw new Error("The desktop install script's Python step changed; update this builder.")
const installComputer = DESKTOP_COMPUTER_INSTALL_SCRIPT.replace(lockedInstall,
  "/usr/bin/python3 -m pip install --no-cache-dir --quiet --break-system-packages --only-binary=:all: -r /usr/local/share/openwork-computer/requirements-desktop.lock")

// Everything Dockerfile.desktop copies into its image, from this checkout.
const build = "/opt/openwork-desktop-build"
const files: Record<string, string> = {
  "install-computer.sh": installComputer,
  "requirements-desktop.lock": pinned,
  "apps.mjs": await text("src/desktop-apps.mjs"),
  "desktop-scripting.mjs": await text("src/desktop-scripting.mjs"),
  "configure-files.sh": await text("scripts/configure-desktop-files.sh"),
  "install-desktop-apps.sh": await text("scripts/install-desktop-apps.sh"),
  "build-desktop-vnc.sh": await text("scripts/build-desktop-vnc.sh"),
  "guest.mjs": await text("dist/desktop-guest.mjs"),
  "guest.version": guestVersion,
  "start.sh": await text("ee/apps/den-worker-runtime/scripts/cloud-desktop.sh", repo),
  "openwork-desktop-bridge": await text("scripts/desktop-bridge.py"),
  "vnc-stdio.py": await text("scripts/vnc-stdio.py"),
}
for (const name of await readdir(new URL("src/scripting/", root))) files[`scripting/${name}`] = await text(`src/scripting/${name}`)

const install = `#!/bin/bash
set -euo pipefail
exec > ${build}/install.log 2>&1
trap 'touch ${build}/failed' ERR
export DEBIAN_FRONTEND=noninteractive
B=${build}
apt-get update -qq
apt-get install -y -qq --no-install-recommends \\
  bash sudo python3 python3-pip ca-certificates curl xz-utils xvfb xauth x11-utils \\
  openbox xdotool util-linux dbus-x11 iptables nftables
# The bridge runs the guest with /usr/local/bin/node, as the Daytona image's Node base provides.
cd /tmp
curl -fsSLO https://nodejs.org/dist/v${node.version}/node-v${node.version}-linux-x64.tar.xz
echo "${node.sha256}  node-v${node.version}-linux-x64.tar.xz" | sha256sum -c -
tar -xJf node-v${node.version}-linux-x64.tar.xz -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude LICENSE --exclude README.md
rm -f node-v${node.version}-linux-x64.tar.xz
id ubuntu >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ubuntu
for user in openwork-browser openwork-app; do id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/sh "$user"; done
id openwork-command >/dev/null 2>&1 || useradd --create-home --shell /bin/bash openwork-command
printf 'ubuntu ALL=(root) NOPASSWD: /usr/local/sbin/openwork-desktop-bridge\\n' > /etc/sudoers.d/ubuntu
printf 'openwork-command ALL=(root) NOPASSWD: /usr/local/sbin/openwork-install\\n' > /etc/sudoers.d/openwork-command
chmod 0440 /etc/sudoers.d/ubuntu /etc/sudoers.d/openwork-command
mkdir -p /usr/local/share/openwork-computer /usr/local/share/openwork-desktop/scripting /workspace
install -m 0644 $B/requirements-desktop.lock /usr/local/share/openwork-computer/requirements-desktop.lock
bash $B/install-computer.sh
# Freestyle's base puts its own Python first on PATH (/usr/local/bin -> /opt/freestyle/python); the
# computer's packages are in the system Python, so python and pip there must be the system ones.
for name in python python3 python3.12; do ln -sfn /usr/bin/python3 /usr/local/bin/$name; done
for name in pip pip3 pip3.12; do ln -sfn /usr/bin/pip3 /usr/local/bin/$name; done
PLAYWRIGHT_BROWSERS_PATH=/opt/openwork-chromium /usr/local/bin/npx -y playwright@${playwright} install --with-deps chromium
ln -sfn "$(ls -d /opt/openwork-chromium/chromium-*/chrome-linux/chrome | head -n 1)" /usr/local/bin/chromium
chmod -R a+rX /opt/openwork-chromium
install -m 0644 $B/apps.mjs /usr/local/share/openwork-desktop/apps.mjs
install -m 0644 $B/desktop-scripting.mjs /usr/local/share/openwork-desktop/desktop-scripting.mjs
install -m 0644 $B/configure-files.sh /usr/local/share/openwork-desktop/configure-files.sh
bash $B/install-desktop-apps.sh
install -m 0644 $B/scripting/* /usr/local/share/openwork-desktop/scripting/
chmod 0755 /usr/local/share/openwork-desktop/scripting
install -m 0644 $B/guest.mjs /usr/local/share/openwork-desktop/guest.mjs
install -m 0644 $B/guest.version /usr/local/share/openwork-desktop/guest.version
install -m 0644 $B/start.sh /usr/local/share/openwork-desktop/start.sh
install -m 0644 $B/vnc-stdio.py /usr/local/share/openwork-desktop/vnc-stdio.py
install -m 0755 $B/openwork-desktop-bridge /usr/local/sbin/openwork-desktop-bridge
bash $B/build-desktop-vnc.sh
chown -R root:root /usr/local/share/openwork-desktop /usr/local/sbin/openwork-desktop-bridge
chmod -R go-w /usr/local/share/openwork-desktop
chown ubuntu:ubuntu /workspace
touch $B/ready
`

const started = Date.now()
console.log(`Building ${slug} from ${base}…`)
const { vm } = await api.vms.create({
  snapshotId: base,
  slug: `${slug}-build`.slice(0, 63),
  displayName: `Workbot desktop build ${slug}`,
  metadata: { kind: "headless-computer-build" },
  ttlSeconds: 2 * 3600,
  firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
})

try {
  await vm.exec({ command: `sudo mkdir -p ${build}/scripting && sudo chown -R 1000:1000 ${build}`, timeoutMs: 30_000 })
  for (const [name, content] of Object.entries(files)) await vm.fs.writeTextFile(`${build}/${name}`, content)
  await vm.fs.writeTextFile(`${build}/install.sh`, install)
  // The install outlives Freestyle's five-minute command limit, so it runs as a unit.
  const launch = await vm.exec({ command: `sudo systemd-run --unit=desktop-install --collect bash ${build}/install.sh`, timeoutMs: 30_000 })
  if (launch.statusCode !== 0) throw new Error(`install did not start: ${launch.stderr ?? ""}`)
  const deadline = Date.now() + 60 * 60_000
  for (;;) {
    const [ready, failed] = await Promise.all([vm.fs.exists(`${build}/ready`), vm.fs.exists(`${build}/failed`)])
    if (ready) break
    if (failed || Date.now() > deadline) {
      const log = await vm.exec({ command: `sudo tail -c 6000 ${build}/install.log`, timeoutMs: 30_000 })
      throw new Error(`install ${failed ? "failed" : "timed out"}:\n${log.stdout ?? "(no log)"}`)
    }
    process.stdout.write(".")
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
  console.log(`\nInstalled in ${Math.round((Date.now() - started) / 1000)}s.`)
  await vm.exec({ command: `sudo rm -rf ${build}`, timeoutMs: 30_000 })

  // Start the desktop exactly as the runner does, so the snapshot captures it running
  // and a new computer's first viewer request finds it healthy at once.
  const start = await vm.exec({ command: `sudo -n /usr/local/sbin/openwork-desktop-bridge start ${desktopVersion}`, timeoutMs: 60_000 })
  console.log(start.stdout?.trim())
  if (start.statusCode !== 0) throw new Error(`desktop did not start: ${start.stderr ?? ""}`)
  // The bridge returns once the guest is launched; poll until it listens, as the runner does.
  const probeHealth = () => vm.exec({ command: "printf '{}' | sudo -n /usr/local/sbin/openwork-desktop-bridge call /health", timeoutMs: 30_000 })
  let health = await probeHealth()
  for (let attempt = 1; attempt < 60 && health.statusCode !== 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    health = await probeHealth()
  }
  if (health.statusCode !== 0) {
    const log = await vm.exec({ command: "sudo tail -c 4000 /var/lib/openwork-desktop/guest.log", timeoutMs: 30_000 })
    throw new Error(`desktop is not healthy: ${health.stderr ?? ""}\n${log.stdout ?? ""}`)
  }
  console.log(`Desktop healthy: ${health.stdout?.trim()}`)

  const snapshot = await vm.snapshot({ slug, displayName: `Workbot desktop ${slug}` })
  console.log(`Snapshot ${slug} ready (${snapshot.snapshotId}) after ${Math.round((Date.now() - started) / 1000)}s.`)
  console.log(`Run the runner with HEADLESS_COMPUTER=freestyle HEADLESS_COMPUTER_DESKTOP=true HEADLESS_COMPUTER_SNAPSHOT=${slug}`)
} finally {
  await vm.delete().catch(() => undefined)
}
