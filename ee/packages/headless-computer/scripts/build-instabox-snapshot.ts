/**
 * Builds the instabox snapshot Workbot computers boot from: the same computer and desktop as Dockerfile.desktop,
 * installed on instabox's Debian base for the `ubuntu` user, then checked on a fresh sandbox made from it.
 *
 *   pnpm --filter @openwork-ee/headless-computer build
 *   INSTABOX_API_KEY=... pnpm --filter @openwork-ee/headless-computer snapshot:build:instabox
 *
 * Then run the runner with HEADLESS_COMPUTER=instabox, HEADLESS_COMPUTER_PERSISTENT=true and
 * HEADLESS_COMPUTER_SNAPSHOT=<printed name> (add HEADLESS_COMPUTER_DESKTOP=true for the desktop). The name follows the
 * desktop image's identity, so re-running with an unchanged image is a no-op. The API key stays on this machine.
 */
import { randomUUID } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { CommandExitError, Sandbox } from "@insforge/instabox-sdk"
import { z } from "zod"
import { DESKTOP_COMPUTER_INSTALL_SCRIPT } from "../src/image.js"

const apiKey = process.env.INSTABOX_API_KEY ?? ""
if (!apiKey) {
  console.error("Set INSTABOX_API_KEY (an instabox API key with machines and images scopes).")
  process.exit(1)
}
const apiUrl = (process.env.INSTABOX_API_URL ?? "https://api.instabox.sh").replace(/\/$/, "")
const conn = { apiKey, apiUrl }
const root = new URL("../", import.meta.url)
const repo = new URL("../../../../", import.meta.url)
const text = (path: string, base = root) => readFile(new URL(path, base), "utf8")
const [imageVersion, guestVersion] = await Promise.all([text("dist/desktop-image.version"), text("dist/desktop-guest.version")]).catch(() => {
  console.error("Build the desktop guest first: pnpm --filter @openwork-ee/headless-computer build")
  process.exit(1)
})
// A base without instabox's own desktop, so nothing else holds the displays or the viewer port.
const base = process.env.INSTABOX_DESKTOP_BASE ?? "universal"
const name = process.env.HEADLESS_COMPUTER_SNAPSHOT ?? `workbot-desktop-instabox-${imageVersion.trim().slice(0, 16)}`

if ((await Sandbox.listSnapshots(conn)).some(snapshot => snapshot.name === name)) {
  console.log(`Snapshot ${name} already exists.`)
  process.exit(0)
}

// The lock's hashes name Debian 12's Python 3.11 wheels; instabox's Debian 13 has 3.13. Install the same pinned
// versions as binary wheels over the system's own copies instead.
const lock = await text("requirements-desktop.lock")
const pinned = [...lock.matchAll(/^([A-Za-z0-9._-]+==[^\s\\]+)/gm)].map(match => match[1]).join("\n") + "\n"
const lockedInstall = "python3 -m pip install --no-cache-dir --quiet --break-system-packages --require-hashes --only-binary=:all: -r /usr/local/share/openwork-computer/requirements-desktop.lock"
if (!DESKTOP_COMPUTER_INSTALL_SCRIPT.includes(lockedInstall)) throw new Error("The desktop install script's Python step changed; update this builder.")
const installComputer = DESKTOP_COMPUTER_INSTALL_SCRIPT.replace(lockedInstall,
  "/usr/bin/python3 -m pip install --no-cache-dir --quiet --break-system-packages --ignore-installed --only-binary=:all: -r /usr/local/share/openwork-computer/requirements-desktop.lock")

// Everything Dockerfile.desktop copies into its image, from this checkout.
const build = "/opt/openwork-desktop-build"
const marker = "/var/tmp/openwork-desktop-build"
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
  "image.version": imageVersion,
  "start.sh": await text("ee/apps/den-worker-runtime/scripts/cloud-desktop.sh", repo),
  "openwork-desktop-bridge": await text("scripts/desktop-bridge.py"),
  "vnc-stdio.py": await text("scripts/vnc-stdio.py"),
}
for (const file of await readdir(new URL("src/scripting/", root))) files[`scripting/${file}`] = await text(`src/scripting/${file}`)

const install = `#!/bin/bash
set -euo pipefail
exec > ${marker}.log 2>&1
trap 'touch ${marker}.failed' ERR
export DEBIAN_FRONTEND=noninteractive
B=${build}
apt-get update -qq
apt-get install -y -qq --no-install-recommends \\
  bash sudo python3 python3-pip ca-certificates curl chromium chromium-sandbox xvfb xauth x11-utils \\
  openbox xdotool util-linux dbus-x11 iptables nftables
bash $B/build-desktop-vnc.sh
for user in openwork-browser openwork-app; do id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/sh "$user"; done
id openwork-command >/dev/null 2>&1 || useradd --create-home --shell /bin/bash openwork-command
printf 'ubuntu ALL=(root) NOPASSWD: /usr/local/sbin/openwork-desktop-bridge\\n' > /etc/sudoers.d/ubuntu
printf 'openwork-command ALL=(root) NOPASSWD: /usr/local/sbin/openwork-install\\n' > /etc/sudoers.d/openwork-command
chmod 0440 /etc/sudoers.d/ubuntu /etc/sudoers.d/openwork-command
# instabox keeps the user's home on its /data disk; Workbot addresses it as /home/ubuntu.
ln -sfn /data/home /home/ubuntu
mkdir -p /usr/local/share/openwork-computer /usr/local/share/openwork-desktop/scripting
install -m 0644 $B/requirements-desktop.lock /usr/local/share/openwork-computer/requirements-desktop.lock
bash $B/install-computer.sh
install -m 0644 $B/apps.mjs /usr/local/share/openwork-desktop/apps.mjs
install -m 0644 $B/desktop-scripting.mjs /usr/local/share/openwork-desktop/desktop-scripting.mjs
install -m 0644 $B/configure-files.sh /usr/local/share/openwork-desktop/configure-files.sh
bash $B/install-desktop-apps.sh
install -m 0644 $B/scripting/* /usr/local/share/openwork-desktop/scripting/
chmod 0755 /usr/local/share/openwork-desktop/scripting
install -m 0644 $B/guest.mjs /usr/local/share/openwork-desktop/guest.mjs
install -m 0644 $B/guest.version /usr/local/share/openwork-desktop/guest.version
install -m 0644 $B/image.version /usr/local/share/openwork-desktop/image.version
install -m 0644 $B/start.sh /usr/local/share/openwork-desktop/start.sh
install -m 0644 $B/vnc-stdio.py /usr/local/share/openwork-desktop/vnc-stdio.py
install -m 0755 $B/openwork-desktop-bridge /usr/local/sbin/openwork-desktop-bridge
chown -R root:root /usr/local/share/openwork-desktop /usr/local/sbin/openwork-desktop-bridge
chmod -R go-w /usr/local/share/openwork-desktop
chown 1000:1000 /workspace
rm -rf $B
# instabox gives the sandbox's user passwordless root and Docker; Workbot's user may only run the desktop bridge.
systemctl disable --now docker.service docker.socket >/dev/null 2>&1 || true
systemctl mask docker.service docker.socket >/dev/null 2>&1 || true
gpasswd -d ubuntu docker >/dev/null 2>&1 || true
gpasswd -d ubuntu sudo >/dev/null 2>&1 || true
rm -f /etc/sudoers.d/90-instabox-sudo
touch ${marker}.ready
`

/** The fields read from the API's operation replies and error envelopes. */
const apiReply = z.object({
  id: z.string().optional(),
  state: z.string().optional(),
  machineId: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
})

/** Creates a sandbox whose user is `ubuntu`, which the SDK's create does not offer yet. */
async function createAsUbuntu(sandboxName: string, templateId: string): Promise<Sandbox> {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${apiUrl}${path}`, {
      method, headers: { "X-API-Key": apiKey, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const reply = apiReply.parse(await res.json().catch(() => ({})))
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${reply.error?.code ?? ""} ${reply.error?.message ?? ""}`)
    return reply
  }
  let op = await call("POST", "/v1/machines", { name: sandboxName, templateId, guestUser: "ubuntu", vault: false, metadata: { kind: "headless-computer-build" } })
  const deadline = Date.now() + 10 * 60_000
  while (op.state !== "succeeded") {
    if (!op.id || op.state === "failed" || Date.now() > deadline) throw new Error(`create ${sandboxName} ${op.state === "failed" ? "failed" : "did not finish"}: ${op.error?.message ?? ""}`)
    await new Promise(resolve => setTimeout(resolve, 2_000))
    op = await call("GET", `/v1/operations/${encodeURIComponent(op.id)}`)
  }
  if (!op.machineId) throw new Error(`create ${sandboxName} named no sandbox`)
  return Sandbox.connect(op.machineId, conn)
}

const run = async (box: Sandbox, command: string, timeoutMs = 60_000) => {
  try { return await box.commands.run(command, { timeoutMs }) } catch (error) {
    if (error instanceof CommandExitError) return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr }
    throw error
  }
}

const started = Date.now()
const tag = randomUUID().slice(0, 8)
console.log(`Building ${name} from ${base}…`)
const builder = await createAsUbuntu(`workbot-desktop-build-${tag}`, base)
let snapshotId: string | undefined
try {
  const prepare = await run(builder, `sudo mkdir -p ${build}/scripting && sudo chown -R ubuntu:ubuntu ${build}`)
  if (prepare.exitCode !== 0) throw new Error(`cannot prepare the build directory: ${prepare.stderr}`)
  for (const [file, content] of Object.entries(files)) await builder.files.write(`${build}/${file}`, content)
  await builder.files.write(`${build}/install.sh`, install)
  // The install outlives a single command's limit, so it runs as a unit.
  const launch = await run(builder, `sudo systemd-run --unit=desktop-install --collect bash ${build}/install.sh`)
  if (launch.exitCode !== 0) throw new Error(`install did not start: ${launch.stderr}`)
  const deadline = Date.now() + 60 * 60_000
  for (;;) {
    const [ready, failed] = await Promise.all([builder.files.exists(`${marker}.ready`), builder.files.exists(`${marker}.failed`)])
    if (ready) break
    if (failed || Date.now() > deadline) {
      const log = await run(builder, `tail -c 6000 ${marker}.log`)
      throw new Error(`install ${failed ? "failed" : "timed out"}:\n${log.stdout || "(no log)"}`)
    }
    process.stdout.write(".")
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
  console.log(`\nInstalled in ${Math.round((Date.now() - started) / 1000)}s.`)
  // instabox snapshots hold disks, not memory, so the desktop is not started here: a running browser would leave its
  // profile locked to this sandbox's hostname, and every computer made from the snapshot would fail to start it.
  let snapshot = await builder.createSnapshot({ name, description: `Workbot desktop ${imageVersion.trim().slice(0, 16)}` })
  while (snapshot.status === "pending") {
    await new Promise(resolve => setTimeout(resolve, 5_000))
    snapshot = await Sandbox.getSnapshot(snapshot.id, conn)
  }
  snapshotId = snapshot.id
  console.log(`Snapshot ${name} saved (${snapshot.id}).`)
} finally {
  await builder.kill().catch(() => undefined)
}

if (!snapshotId) throw new Error("the build saved no snapshot")
const savedSnapshotId = snapshotId
// Check the snapshot as the runner will use it: a fresh sandbox, its desktop started by the bridge, its viewer port.
const check = await Sandbox.create(savedSnapshotId, { ...conn, name: `workbot-desktop-check-${tag}`, vault: false })
try {
  const whoami = await run(check, "id -un; sudo -n true 2>/dev/null && echo root || echo no-root")
  if (whoami.stdout.trim() !== "ubuntu\nno-root") throw new Error(`the computer's user should be ubuntu without root, got: ${whoami.stdout.trim()}`)
  const start = await run(check, `sudo -n /usr/local/sbin/openwork-desktop-bridge start ${imageVersion.trim()} ${guestVersion.trim()}`, 120_000)
  if (start.exitCode !== 0) throw new Error(`desktop did not start: ${start.stderr}`)
  let health = await run(check, "printf '{}' | sudo -n /usr/local/sbin/openwork-desktop-bridge call /health")
  for (let attempt = 1; attempt < 60 && health.exitCode !== 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    health = await run(check, "printf '{}' | sudo -n /usr/local/sbin/openwork-desktop-bridge call /health")
  }
  if (health.exitCode !== 0) throw new Error(`desktop is not healthy: ${health.stderr}`)
  const viewer = await check.ports.publish(6080)
  const reply = await fetch(`${viewer.url}/`, { redirect: "manual" })
  if (reply.status >= 500) throw new Error(`the viewer port answered ${reply.status}`)
  console.log(`Desktop healthy on a fresh sandbox; viewer port answered ${reply.status}.`)
} catch (error) {
  await Sandbox.deleteSnapshot(savedSnapshotId, conn).catch(() => undefined)
  throw error
} finally {
  await check.kill().catch(() => undefined)
}
console.log(`Ready after ${Math.round((Date.now() - started) / 1000)}s.`)
console.log(`Run the runner with HEADLESS_COMPUTER=instabox HEADLESS_COMPUTER_PERSISTENT=true HEADLESS_COMPUTER_DESKTOP=true HEADLESS_COMPUTER_SNAPSHOT=${name}`)
