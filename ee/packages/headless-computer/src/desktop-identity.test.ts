import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { guestIdentity, imageIdentity } from "../scripts/desktop-identity.mjs"

test("the guest's identity follows what it bundles, and the image's what the image installs", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-identity-"))
  const put = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }
  try {
    await put("pkg/src/guest.mjs", "guest")
    await put("node_modules/ws/package.json", JSON.stringify({ name: "ws", version: "8.0.0" }))
    await put("node_modules/ws/index.js", "ws")
    await put("ee/packages/headless-computer/scripts/desktop-bridge.py", "bridge")
    await put("pnpm-lock.yaml", "lock")
    await put("packages/computer-use/native/Sources/Mac.swift", "mac")
    const identities = async () => ({
      guest: await guestIdentity({ root, workingDirectory: join(root, "pkg"), inputs: ["src/guest.mjs", "../node_modules/ws/index.js"] }),
      image: await imageIdentity({ root }),
    })
    const original = await identities()

    await put("pnpm-lock.yaml", "another package was added")
    await put("packages/computer-use/native/Sources/Mac.swift", "mac only")
    assert.deepEqual(await identities(), original, "lockfile and Mac-only changes keep both")

    await put("node_modules/ws/index.js", "same version, different install")
    assert.deepEqual(await identities(), original, "a bundled package counts by its version")

    await put("node_modules/ws/package.json", JSON.stringify({ name: "ws", version: "8.1.0" }))
    const upgraded = await identities()
    assert.notEqual(upgraded.guest, original.guest, "a new version of a bundled package is a new guest")
    assert.equal(upgraded.image, original.image, "on the same image")

    await put("pkg/src/guest.mjs", "changed guest")
    const guest = await identities()
    assert.notEqual(guest.guest, upgraded.guest, "bundled guest code is a new guest")
    assert.equal(guest.image, original.image, "which the runner installs into computers from the same image")

    await put("ee/packages/headless-computer/scripts/desktop-bridge.py", "changed bridge")
    const image = await identities()
    assert.notEqual(image.image, guest.image, "files installed in the image need a new snapshot")
    assert.equal(image.guest, guest.guest)
  } finally { await rm(root, { recursive: true, force: true }) }
})
