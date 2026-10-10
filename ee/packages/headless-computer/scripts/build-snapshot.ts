/**
 * Builds the Freestyle snapshot every headless computer boots from, once per install script.
 *
 *   FREESTYLE_API_KEY=... pnpm --filter @openwork-ee/headless-computer snapshot:build
 *
 * Boots Freestyle's Ubuntu base, runs the install script as a detached unit (it outlives the 5-minute command
 * limit), polls its marker files, and snapshots the VM under a slug derived from the script. Re-running with an
 * unchanged script is a no-op. The API key stays on this machine; it never enters the VM.
 */
import { Freestyle, FreestyleApiError } from "freestyle"
import { COMPUTER_INSTALL_SCRIPT, computerSnapshotSlug } from "../src/image.js"

const apiKey = process.env.FREESTYLE_API_KEY
if (!apiKey) {
  console.error("Set FREESTYLE_API_KEY (see the get-env-var skill: dev, /openwork-ops).")
  process.exit(1)
}
const api = new Freestyle({ apiKey })
const slug = computerSnapshotSlug()

const exists = await api.vms.snapshots.get(slug).then(
  () => true,
  (error: unknown) => {
    if (error instanceof FreestyleApiError && error.status === 404) return false
    throw error
  },
)
if (exists) {
  console.log(`Snapshot ${slug} already exists.`)
  process.exit(0)
}

const started = Date.now()
const builderSlug = `${slug}-build`
console.log(`Building ${slug} on ${builderSlug}…`)
const { vm } = await api.vms.create({
  snapshotId: "freestyle/ubuntu",
  slug: builderSlug,
  displayName: `Computer image build ${slug}`,
  metadata: { kind: "headless-computer-build" },
  ttlSeconds: 3600,
  firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
})

try {
  const root = "/opt/computer-install"
  await vm.exec({ command: `sudo mkdir -p ${root} && sudo chown 1000:1000 ${root}`, timeoutMs: 30_000 })
  await vm.fs.writeTextFile(
    `${root}/install.sh`,
    `#!/bin/bash\nexec > ${root}/install.log 2>&1\ntrap 'touch ${root}/failed' ERR\n${COMPUTER_INSTALL_SCRIPT}\ntouch ${root}/ready\n`,
  )
  const launch = await vm.exec({ command: `sudo systemd-run --unit=computer-install --collect bash ${root}/install.sh`, timeoutMs: 30_000 })
  if (launch.statusCode !== 0) throw new Error(`install did not start: ${launch.stderr ?? ""}`)

  const deadline = Date.now() + 25 * 60_000
  for (;;) {
    const [ready, failed] = await Promise.all([vm.fs.exists(`${root}/ready`), vm.fs.exists(`${root}/failed`)])
    if (ready) break
    if (failed || Date.now() > deadline) {
      const log = await vm.fs.readTextFile(`${root}/install.log`).catch(() => "(no log)")
      throw new Error(`install ${failed ? "failed" : "timed out"}:\n${log.slice(-4000)}`)
    }
    process.stdout.write(".")
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  console.log(`\nInstalled in ${Math.round((Date.now() - started) / 1000)}s.`)

  const check = await vm.exec({
    command: "ffmpeg -version | head -1; python3 -c 'import pandas, cv2, docx, pdfplumber; print(\"python ok\")'; node --version; command -v background",
    timeoutMs: 60_000,
  })
  console.log(check.stdout?.trim())
  if (check.statusCode !== 0) throw new Error(`tool check failed: ${check.stderr ?? ""}`)

  await vm.exec({ command: `sudo rm -rf ${root}`, timeoutMs: 30_000 })
  const snapshot = await vm.snapshot({ slug, displayName: `Computer image ${slug}` })
  console.log(`Snapshot ${slug} ready (${snapshot.snapshotId}) after ${Math.round((Date.now() - started) / 1000)}s.`)
} finally {
  await vm.delete().catch(() => undefined)
}
