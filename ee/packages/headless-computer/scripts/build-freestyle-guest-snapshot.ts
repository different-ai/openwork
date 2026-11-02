/**
 * Layers this checkout's desktop guest onto the Freestyle snapshot of its image, so a new computer already runs the
 * guest its runner expects and skips installing it on first open. Guests change far more often than images, and
 * this takes seconds where building an image takes minutes.
 *
 *   pnpm --filter @openwork-ee/headless-computer build
 *   FREESTYLE_API_KEY=... pnpm --filter @openwork-ee/headless-computer snapshot:build:freestyle-guest
 *
 * The image's snapshot (snapshot:build:freestyle-desktop) has to exist. This boots it, installs and starts the guest
 * the way the runner does, and captures workbot-desktop-freestyle-<image>-<guest>; re-running with an unchanged guest
 * is a no-op. Every new computer would start from the result, so it boots it once to see the guest answer, and a
 * layer that doesn't is deleted. Building a layer gives the ones it replaces an unused-for-14-days deletion window.
 * The image's snapshot keeps none, so it is still there for the next layer and for a runner that can't use one.
 *
 * Not in IMAGE_FILES: nothing here changes what an image installs, so changing this file leaves computers current.
 * The API key stays on this machine; it never enters the VM.
 */
import { createHash } from "node:crypto"
import { Freestyle, FreestyleApiError, type Vm } from "freestyle"

const apiKey = process.env.FREESTYLE_API_KEY
if (!apiKey) {
  console.error("Set FREESTYLE_API_KEY (see the get-env-var skill: dev, /openwork-ops).")
  process.exit(1)
}
const [{ default: identity }, { default: guestBundle }] = await Promise.all([import("../dist/desktop-identity.mjs"), import("../dist/desktop-guest-bundle.mjs")]).catch(() => {
  console.error("Build the desktop guest first: pnpm --filter @openwork-ee/headless-computer build")
  process.exit(1)
})
const image = identity.image.trim()
const guest = identity.guest.trim()
const base = `workbot-desktop-freestyle-${image.slice(0, 16)}`
const slug = `${base}-${guest.slice(0, 16)}`
/** What this image and guest report from /health (Desktop.prepare), which lets the runner skip the install. */
const version = createHash("sha256").update(identity.image).update(identity.guest).digest("hex")
const BRIDGE = "sudo -n /usr/local/sbin/openwork-desktop-bridge"
const UPLOAD = "/home/ubuntu/.openwork-guest-upload"
const RETIRED_SNAPSHOT_SECONDS = 14 * 24 * 3600
const api = new Freestyle({ apiKey })

const exists = await api.vms.snapshots.get(slug).then(() => true, (error: unknown) => {
  if (error instanceof FreestyleApiError && error.status === 404) return false
  throw error
})
if (exists) {
  console.log(`Snapshot ${slug} already exists.`)
  process.exit(0)
}

const create = (snapshotId: string) => api.vms.create({
  snapshotId,
  displayName: `Workbot desktop build ${slug}`,
  metadata: { kind: "headless-computer-build" },
  ttlSeconds: 15 * 60,
  firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
})

const started = Date.now()
console.log(`Building ${slug} from ${base}…`)
const { vm } = await create(base)
let snapshotId: string
try {
  await vm.fs.writeFile(UPLOAD, Buffer.from(guestBundle, "base64"))
  await run(vm, `${BRIDGE} install ${image} ${guest} ${identity.bundleSha256} < ${UPLOAD}`, 60_000)
  await run(vm, `rm -f ${UPLOAD}`, 10_000)
  await run(vm, `${BRIDGE} start ${image} ${guest}`, 60_000)
  await guestAnswers(vm)
  snapshotId = (await vm.snapshot({ slug, displayName: `Workbot desktop ${slug}` })).snapshotId
} finally {
  await vm.delete().catch(() => undefined)
}
console.log(`Snapshot ${slug} ready (${snapshotId}) after ${Math.round((Date.now() - started) / 1000)}s.`)

const booted = Date.now()
try {
  const { vm: check } = await create(slug)
  try { await guestAnswers(check) }
  finally { await check.delete().catch(() => undefined) }
} catch (error) {
  await api.vms.snapshots.delete(snapshotId).catch(() => undefined)
  throw error
}
console.log(`A computer from it answered as this guest in ${((Date.now() - booted) / 1000).toFixed(1)}s.`)
await retireOlderLayers().catch((error: unknown) => console.warn(`Older layers keep no deletion window: ${error instanceof Error ? error.message : String(error)}`))
console.log(`Run the runner with HEADLESS_COMPUTER=freestyle HEADLESS_COMPUTER_DESKTOP=true HEADLESS_COMPUTER_SNAPSHOT=${slug}`)

async function run(box: Vm, command: string, timeoutMs: number) {
  const result = await box.exec({ command, timeoutMs })
  if (result.statusCode !== 0) throw new Error(`${command} failed: ${result.stderr ?? ""}`)
}

/** The bridge returns once the guest is launched, and a VM from a snapshot may still be resuming; poll as the runner does. */
async function guestAnswers(box: Vm) {
  let last = ""
  for (let attempt = 0; attempt < 60; attempt++) {
    const health = await box.exec({ command: `printf '{}' | ${BRIDGE} call /health`, timeoutMs: 30_000 })
    if (health.statusCode === 0 && JSON.parse(health.stdout ?? "{}").version === version) return
    last = `${health.stdout ?? ""} ${health.stderr ?? ""}`.trim()
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`The desktop didn't answer as this guest: ${last}`)
}

/**
 * Gives every earlier layer without a deletion window one: Freestyle deletes it once no computer has been created from
 * it for RETIRED_SNAPSHOT_SECONDS. Computers already made from it keep running; only new ones can't use it. Image
 * snapshots have the image builder's own retirement, and the current image's has to stay.
 */
async function retireOlderLayers() {
  let retired = 0
  for (let offset = 0; ; offset += 100) {
    const page = await api.vms.snapshots.list({ limit: 100, offset })
    for (const snapshot of page.snapshots) {
      if (snapshot.slug === slug || !/^workbot-desktop-freestyle-[0-9a-f]{16}-[0-9a-f]{16}$/.test(snapshot.slug ?? "") || snapshot.autoDeleteSeconds != null) continue
      await api.vms.snapshots.update(snapshot.id, { autoDeleteSeconds: RETIRED_SNAPSHOT_SECONDS })
      retired++
    }
    if (page.snapshots.length < 100 || offset + 100 >= page.totalCount) break
  }
  console.log(`Gave ${retired} older layer${retired === 1 ? "" : "s"} a ${RETIRED_SNAPSHOT_SECONDS / 86400}-day unused deletion window.`)
}
